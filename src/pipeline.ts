import { resolveFacets, type SiftConfig } from "./config.ts";
import { SiftStore, type TraceCursor } from "./store/db.ts";
import { ingestOtlpJsonlFile, parseOtlpJsonl, type IngestOptions } from "./ingest/otlp.ts";
import { flushSettledTraces, type FlushOptions, type FlushResult } from "./ingest/pending.ts";
import { createSummarizer, createLabeler } from "./facets/summarize.ts";
import { createEmbedder } from "./embed/index.ts";
import { ThemeRegistry, type StateTransition } from "./registry/index.ts";
import { computeDeltas, type DeltaReport } from "./delta/index.ts";
import { buildFacetReport, type FacetReport } from "./report/model.ts";
import { exportTheme, type EvalExport, type ExportOptions } from "./export/evals.ts";
import { systemClock, type Clock, type Embedder, type FacetDef, type Labeler, type Summarizer, type Theme, type Trace } from "./types.ts";
import { windowForTrace } from "./window.ts";
import { Pseudonymizer } from "./privacy/redact.ts";
import { RedactingSummarizer } from "./privacy/gate.ts";

/**
 * Orchestration.
 *
 * Every stage is separately runnable and separately resumable, because these
 * are long jobs against paid APIs: `summarize` only touches traces missing a
 * facet, `assign` only touches summaries with no assignment. Killing a run
 * halfway and starting it again costs nothing already spent.
 *
 * Providers are injected rather than constructed here, which is what lets the
 * whole pipeline run offline in tests and in `sift demo`.
 */

export interface PipelineDeps {
  summarizer: Summarizer;
  embedder: Embedder;
  labeler: Labeler;
  clock?: Clock;
  /** progress sink; defaults to silence */
  log?: (message: string) => void;
}

export interface IngestSummary {
  ingested: number;
  duplicates: number;
  spans: number;
  skippedLines: number;
  errors: string[];
}

export interface SummarizeSummary {
  traces: number;
  summaries: number;
  embedded: number;
  failures: Array<{ traceId: string; error: string }>;
  /** traces still matching the same scope afterwards; 0 means the job is done */
  remaining: number;
}

/**
 * How many traces one summarize pass will take on.
 *
 * This is a cost guard, not a tuning knob: every trace in a pass is one paid
 * model call, and an accidental `sift summarize` over a year of traffic should
 * not be a five-figure invoice. `analyze` pages through this repeatedly because
 * it promises a whole picture; `summarize` stops after one pass and says how
 * much it left, because it is the deliberately incremental command.
 */
export const SUMMARIZE_BATCH = 1000;

export interface DiscoverySummary {
  agentId: string;
  facet: string;
  created: Theme[];
}

export interface AssignSummary {
  agentId: string;
  facet: string;
  assigned: number;
  residual: number;
  transitions: StateTransition[];
  rediscovered: Theme[];
  autoResolved: StateTransition[];
}

export class Pipeline {
  readonly store: SiftStore;
  readonly cfg: SiftConfig;
  readonly facets: FacetDef[];
  private summarizer: Summarizer;
  private embedder: Embedder;
  private labeler: Labeler;
  private clock: Clock;
  private log: (message: string) => void;
  private registries = new Map<string, ThemeRegistry>();

  constructor(store: SiftStore, cfg: SiftConfig, deps: PipelineDeps) {
    this.store = store;
    this.cfg = cfg;
    this.facets = resolveFacets(cfg);
    this.summarizer = deps.summarizer;
    this.embedder = deps.embedder;
    this.labeler = deps.labeler;
    this.clock = deps.clock ?? systemClock;
    this.log = deps.log ?? (() => {});
  }

  /** Every agent this database holds traces for. */
  agents(): string[] {
    return this.store.agentIds();
  }

  /**
   * The registry for one agent. Registries are per-agent because a theme's
   * vocabulary is: "retry loop on search_kb" means nothing for a coding agent,
   * and letting the two share centroids merges two products into one issues
   * list that describes neither.
   */
  registryFor(agentId: string): ThemeRegistry {
    let registry = this.registries.get(agentId);
    if (!registry) {
      registry = new ThemeRegistry(this.store, this.cfg, {
        labeler: this.labeler,
        clock: this.clock,
        agentId,
      });
      this.registries.set(agentId, registry);
    }
    return registry;
  }

  /**
   * Resolves a `--since` window: an ISO date, or a relative span like 7d/24h/30m.
   * Never silently falls back to "everything" — that would quietly re-summarize
   * an entire history and bill for it.
   */
  static resolveSince(since: string, now: Date = new Date()): string {
    const relative = /^(\d+)\s*([mhdw])$/i.exec(since.trim());
    if (relative) {
      const n = Number(relative[1]);
      const unitMs: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
      return new Date(now.getTime() - n * unitMs[relative[2]!.toLowerCase()]!).toISOString();
    }
    const parsed = Date.parse(since);
    if (Number.isNaN(parsed)) {
      throw new Error(`could not understand --since ${JSON.stringify(since)}; use an ISO date or a span like 7d, 24h, 30m`);
    }
    return new Date(parsed).toISOString();
  }

  /* ---------- ingest ---------- */

  ingestFile(path: string, opts: IngestOptions = {}): IngestSummary {
    return this.finishIngest(ingestOtlpJsonlFile(path, opts));
  }

  ingestJsonl(content: string, opts: IngestOptions = {}): IngestSummary {
    return this.finishIngest(parseOtlpJsonl(content, opts));
  }

  private finishIngest(result: ReturnType<typeof parseOtlpJsonl>): IngestSummary {
    const ingested = this.store.insertTraces(result.traces);
    this.log(`ingested ${ingested} traces (${result.traces.length - ingested} already known)`);
    return {
      ingested,
      duplicates: result.traces.length - ingested,
      spans: result.spanCount,
      skippedLines: result.skippedLines,
      errors: result.errors,
    };
  }

  /**
   * Assemble whatever `sift serve` has staged and gone quiet on.
   *
   * Called at the top of `summarize`, and so of `analyze` too. It is one cheap
   * query when nothing is staged, and without it someone who pointed their
   * exporter at sift would run `sift report`, see nothing, and get no error
   * explaining why.
   *
   * Drains rather than flushing once: `flushSettledTraces` caps each call, so a
   * single call means "up to a page", and a corpus that arrived over HTTP is
   * routinely larger than one. Stopping at the first page left the rest staged
   * and invisible while every count downstream treated the page as the whole.
   */
  flushPending(opts: FlushOptions = {}): FlushResult {
    const total: FlushResult = { traces: 0, spans: 0, duplicates: 0 };
    for (;;) {
      const page = flushSettledTraces(this.store, opts);
      // Spans consumed is the termination signal, not traces: a settled trace
      // whose id is already known assembles to a duplicate, which is progress.
      if (page.spans === 0) break;
      total.traces += page.traces;
      total.spans += page.spans;
      total.duplicates += page.duplicates;
    }
    if (total.traces > 0) this.log(`assembled ${total.traces} received traces from ${total.spans} staged spans`);
    return total;
  }

  /* ---------- summarize + embed ---------- */

  /**
   * One LLM call per trace produces every facet line; embeddings are batched.
   * A trace whose summarization fails is left pending rather than half-written,
   * so the next run picks it up instead of skipping it forever.
   */
  async summarize(opts: { limit?: number; since?: string; agentId?: string } = {}): Promise<SummarizeSummary> {
    this.flushPending();
    const facetNames = this.facets.map((f) => f.name);
    const query: { limit: number; since?: string; agentId?: string } = { limit: opts.limit ?? SUMMARIZE_BATCH };
    if (opts.since) query.since = opts.since;
    if (opts.agentId) query.agentId = opts.agentId;
    const pending = this.store.tracesNeedingSummaries(facetNames, query);

    this.log(`${pending.length} traces to summarize`);
    const { summaries, failures } = await this.summarizePage(pending);
    const embedded = await this.embedPending();
    if (failures.length > 0) this.log(`${failures.length} traces failed to summarize and will be retried next run`);

    // What a capped pass left behind, over the same scope it just worked on.
    // Reported rather than assumed to be nothing: a report built on 1,000 of
    // 40,000 traces is not wrong by a little, and nobody could tell from the
    // shares that it was built on a slice at all.
    const scope: { since?: string; agentId?: string } = {};
    if (opts.since) scope.since = opts.since;
    if (opts.agentId) scope.agentId = opts.agentId;
    const remaining = this.store.countTracesNeedingSummaries(facetNames, scope);
    // Progress, not advice: this same line is emitted once per batch inside a
    // paging analyze run, where "run sift summarize again" would be nonsense.
    if (remaining > 0) this.log(`${remaining} traces still pending`);
    return { traces: pending.length, summaries, embedded, failures, remaining };
  }

  /** The paid loop, factored out so a paging run does not have to re-enter summarize(). */
  private async summarizePage(
    traces: Trace[],
  ): Promise<{ summaries: number; failures: SummarizeSummary["failures"] }> {
    const failures: SummarizeSummary["failures"] = [];
    let summaries = 0;
    for (const trace of traces) {
      try {
        const produced = await this.summarizer.summarize(trace, this.facets);
        this.store.insertSummaries(produced);
        summaries += produced.length;
      } catch (err) {
        failures.push({ traceId: trace.id, error: (err as Error).message });
      }
    }
    return { summaries, failures };
  }

  /**
   * Summarize everything pending, a batch at a time. What `analyze` uses when
   * the caller named no `--limit`, because "ingest → issues list" is a promise
   * about the whole corpus.
   *
   * Paged with a keyset cursor rather than by re-asking for "the oldest pending
   * traces". A trace whose summarization throws stays pending by design, so
   * re-asking hands back every earlier failure again on every later pass, and
   * pays for it again: a batch-sized block of failures at the head of the corpus
   * cost 1,000 model calls for each trace behind it that got through. The cursor
   * makes a run exactly one call per trace, failures included, and terminates
   * because it only ever moves forward.
   */
  private async summarizeAll(opts: { since?: string; agentId?: string }): Promise<SummarizeSummary> {
    // Before the count, not only inside the passes: a corpus that is entirely
    // staged spans would otherwise count zero and this would do nothing at all.
    this.flushPending();
    const facetNames = this.facets.map((f) => f.name);
    const total = this.store.countTracesNeedingSummaries(facetNames, opts);
    if (total > SUMMARIZE_BATCH) {
      this.log(`${total} traces to summarize — one model call each; cap it with --limit`);
    }

    const acc: SummarizeSummary = { traces: 0, summaries: 0, embedded: 0, failures: [], remaining: 0 };
    let after: TraceCursor | undefined;
    for (;;) {
      const query: { limit: number; since?: string; agentId?: string; after?: TraceCursor } = {
        limit: SUMMARIZE_BATCH,
        ...opts,
      };
      if (after) query.after = after;
      const page = this.store.tracesNeedingSummaries(facetNames, query);
      if (page.length === 0) break;

      this.log(`${page.length} traces to summarize`);
      const pass = await this.summarizePage(page);
      acc.traces += page.length;
      acc.summaries += pass.summaries;
      acc.failures.push(...pass.failures);
      acc.embedded += await this.embedPending();
      const last = page[page.length - 1]!;
      after = { startedAt: last.startedAt, id: last.id };
    }

    if (acc.failures.length > 0) this.log(`${acc.failures.length} traces failed to summarize and will be retried next run`);
    acc.remaining = this.store.countTracesNeedingSummaries(facetNames, opts);
    if (acc.remaining > 0) this.log(`${acc.remaining} traces still pending`);
    return acc;
  }

  /** Embed any summary that lacks a vector, in batches, resumable. */
  async embedPending(): Promise<number> {
    let total = 0;
    for (;;) {
      const batch = this.store.summariesNeedingEmbeddings(256);
      if (batch.length === 0) break;
      const vectors = await this.embedder.embed(batch.map((s) => s.summary));
      this.store.insertSummaries(batch.map((s, i) => ({ ...s, embedding: vectors[i]! })));
      total += batch.length;
    }
    if (total > 0) this.log(`embedded ${total} summaries`);
    return total;
  }

  /* ---------- discovery & assignment ---------- */

  /** Discover themes for every facet. At bootstrap the residual pile is everything. */
  async bootstrap(opts: { agentId?: string } = {}): Promise<DiscoverySummary[]> {
    const out: DiscoverySummary[] = [];
    for (const agentId of this.agentScope(opts.agentId)) {
      for (const facet of this.facets) {
        const created = await this.registryFor(agentId).discover(facet.name);
        this.log(`${agentId}/${facet.name}: discovered ${created.length} themes`);
        out.push({ agentId, facet: facet.name, created });
      }
    }
    return out;
  }

  private agentScope(agentId?: string): string[] {
    if (agentId) return [agentId];
    return this.agents();
  }

  /**
   * Steady state: assign what is new, and re-run discovery only where the
   * residual pile has grown past the threshold. Discovery runs at most once per
   * facet per pass — a second pass on the same residuals would find the same
   * nothing and only burn tokens.
   */
  async assign(opts: { agentId?: string } = {}): Promise<AssignSummary[]> {
    const out: AssignSummary[] = [];
    for (const agentId of this.agentScope(opts.agentId)) {
      const registry = this.registryFor(agentId);
      for (const facet of this.facets) {
        const result = registry.assignPending(facet.name);
        let rediscovered: Theme[] = [];

        const windows = this.store.windowsForFacet(agentId, facet.name);
        const latest = windows[windows.length - 1];
        if (latest && registry.needsRediscovery(facet.name, latest)) {
          this.log(
            `${agentId}/${facet.name}: residual pile over ${(this.cfg.rediscoverResidualShare * 100).toFixed(0)}%, running discovery`,
          );
          rediscovered = await registry.discover(facet.name);
          if (rediscovered.length > 0) {
            // newly created themes may also cover older residuals
            const second = registry.assignPending(facet.name);
            result.assigned += second.assigned;
            result.transitions.push(...second.transitions);
          }
        }

        const autoResolved = registry.sweepAutoResolve(facet.name);
        this.log(`${agentId}/${facet.name}: ${result.assigned} assigned, ${result.residual} residual`);
        out.push({
          agentId,
          facet: facet.name,
          assigned: result.assigned,
          residual: result.residual,
          transitions: result.transitions,
          rediscovered,
          autoResolved,
        });
      }
    }
    return out;
  }

  /* ---------- the whole loop ---------- */

  /**
   * Ingest (optional) → summarize → embed → discover-or-assign.
   * The one command that takes a pile of traces and produces an issues list.
   */
  async analyze(opts: { otlpPath?: string; jsonl?: string; agentId?: string; limit?: number; since?: string } = {}): Promise<{
    ingest?: IngestSummary;
    summarize: SummarizeSummary;
    discovery: DiscoverySummary[];
    assign: AssignSummary[];
  }> {
    const ingestOpts: IngestOptions = {};
    if (opts.agentId) ingestOpts.agentId = opts.agentId;

    let ingest: IngestSummary | undefined;
    if (opts.otlpPath) ingest = this.ingestFile(opts.otlpPath, ingestOpts);
    else if (opts.jsonl !== undefined) ingest = this.ingestJsonl(opts.jsonl, ingestOpts);

    // An explicit --limit is the caller asking for a sample and accepting the
    // cost; without one, analyze finishes the job. Capping silently at a batch
    // and then printing shares as if they described everything ingested is the
    // one thing this command must not do.
    // agentId belongs here as much as since does: --agent is documented as
    // scoping the whole command, and dropping it made `analyze --agent a` pay
    // for every unsummarized trace agent b had.
    const summarizeOpts: { since?: string; agentId?: string } = {};
    if (opts.since !== undefined) summarizeOpts.since = opts.since;
    if (opts.agentId !== undefined) summarizeOpts.agentId = opts.agentId;
    const summarize =
      opts.limit === undefined
        ? await this.summarizeAll(summarizeOpts)
        : await this.summarize({ ...summarizeOpts, limit: opts.limit });

    // Bootstrap and steady state are the same code path; discovery on an empty
    // registry simply has everything as its residual pile. Decided per agent,
    // so adding a second agent later still gets a proper first discovery.
    const discovery: DiscoverySummary[] = [];
    for (const agentId of this.agentScope(opts.agentId)) {
      if (this.store.allThemes(agentId).length === 0) discovery.push(...(await this.bootstrap({ agentId })));
    }
    const assignOpts: { agentId?: string } = {};
    if (opts.agentId) assignOpts.agentId = opts.agentId;
    const assign = await this.assign(assignOpts);

    const result: {
      ingest?: IngestSummary;
      summarize: SummarizeSummary;
      discovery: DiscoverySummary[];
      assign: AssignSummary[];
    } = { summarize, discovery, assign };
    if (ingest) result.ingest = ingest;
    return result;
  }

  /* ---------- views ---------- */

  report(opts: { facet?: string; window?: string; agentId?: string } = {}): FacetReport[] {
    const facets = opts.facet ? [opts.facet] : this.facets.map((f) => f.name);
    const out: FacetReport[] = [];
    for (const agentId of this.agentScope(opts.agentId)) {
      for (const facet of facets) {
        const reportOpts: { agentId: string; facet: string; window?: string } = { agentId, facet };
        if (opts.window) reportOpts.window = opts.window;
        out.push(buildFacetReport(this.store, this.cfg, reportOpts));
      }
    }
    return out;
  }

  delta(agentId: string, facet: string, fromWindow: string, toWindow: string): DeltaReport {
    return computeDeltas(this.store, agentId, facet, fromWindow, toWindow, { sigma: this.cfg.deltaSigma });
  }

  /** The two most recent windows for a facet, which is what `sift delta` defaults to. */
  latestWindowPair(agentId: string, facet: string): { from: string; to: string } | null {
    const windows = this.store.windowsForFacet(agentId, facet);
    if (windows.length < 2) return null;
    return { from: windows[windows.length - 2]!, to: windows[windows.length - 1]! };
  }

  exportTheme(themeId: string, opts: ExportOptions = {}): EvalExport {
    return exportTheme(this.store, themeId, opts);
  }

  /** Window a trace would be counted in — exposed so callers can explain themselves. */
  windowFor(traceId: string): string | null {
    const trace = this.store.getTrace(traceId);
    return trace ? windowForTrace(trace) : null;
  }
}

export interface CreatePipelineOptions {
  clock?: Clock;
  log?: (message: string) => void;
  /** fail at construction if a hosted provider has no API key */
  requireKey?: boolean;
}

/** Builds a pipeline with the providers named in config. */
export function createPipeline(cfg: SiftConfig, opts: CreatePipelineOptions = {}): Pipeline {
  const store = new SiftStore(cfg.dbPath);
  const factoryOpts = opts.requireKey ? { requireKey: true } : {};
  const deps: PipelineDeps = {
    // The pseudonymization gate wraps whatever summarizer was configured, so it
    // applies identically to a hosted model and a self-hosted one.
    summarizer: withPrivacyGate(createSummarizer(cfg.llm, factoryOpts), cfg),
    embedder: createEmbedder(cfg.embeddings, factoryOpts),
    labeler: createLabeler(cfg.llm, factoryOpts),
  };
  if (opts.clock) deps.clock = opts.clock;
  if (opts.log) deps.log = opts.log;
  return new Pipeline(store, cfg, deps);
}

/** Builds the configured Pseudonymizer. Exported so `sift privacy` uses the same one. */
export function createPseudonymizer(cfg: SiftConfig): Pseudonymizer {
  const opts: ConstructorParameters<typeof Pseudonymizer>[0] = {
    mode: cfg.privacy.mode,
    scope: cfg.privacy.scope,
  };
  if (cfg.privacy.salt !== undefined) opts.salt = cfg.privacy.salt;
  if (cfg.privacy.rules !== undefined) opts.rules = cfg.privacy.rules;
  return new Pseudonymizer(opts);
}

function withPrivacyGate(summarizer: Summarizer, cfg: SiftConfig): Summarizer {
  if (cfg.privacy.mode === "off") return summarizer;
  return new RedactingSummarizer(summarizer, createPseudonymizer(cfg));
}
