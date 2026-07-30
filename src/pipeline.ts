import { resolveFacets, type SiftConfig } from "./config.ts";
import { SiftStore } from "./store/db.ts";
import { ingestOtlpJsonlFile, parseOtlpJsonl, type IngestOptions } from "./ingest/otlp.ts";
import { createSummarizer, createLabeler } from "./facets/summarize.ts";
import { createEmbedder } from "./embed/index.ts";
import { ThemeRegistry, type StateTransition } from "./registry/index.ts";
import { computeDeltas, type DeltaReport } from "./delta/index.ts";
import { buildFacetReport, type FacetReport } from "./report/model.ts";
import { exportTheme, type EvalExport, type ExportOptions } from "./export/evals.ts";
import { systemClock, type Clock, type Embedder, type FacetDef, type Labeler, type Summarizer, type Theme } from "./types.ts";
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
}

export interface DiscoverySummary {
  facet: string;
  created: Theme[];
}

export interface AssignSummary {
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
  readonly registry: ThemeRegistry;
  readonly facets: FacetDef[];
  private summarizer: Summarizer;
  private embedder: Embedder;
  private log: (message: string) => void;

  constructor(store: SiftStore, cfg: SiftConfig, deps: PipelineDeps) {
    this.store = store;
    this.cfg = cfg;
    this.facets = resolveFacets(cfg);
    this.summarizer = deps.summarizer;
    this.embedder = deps.embedder;
    this.log = deps.log ?? (() => {});
    this.registry = new ThemeRegistry(store, cfg, {
      labeler: deps.labeler,
      clock: deps.clock ?? systemClock,
    });
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

  /* ---------- summarize + embed ---------- */

  /**
   * One LLM call per trace produces every facet line; embeddings are batched.
   * A trace whose summarization fails is left pending rather than half-written,
   * so the next run picks it up instead of skipping it forever.
   */
  async summarize(opts: { limit?: number } = {}): Promise<SummarizeSummary> {
    const facetNames = this.facets.map((f) => f.name);
    const pending = this.store.tracesNeedingSummaries(facetNames, opts.limit ?? 1000);
    const failures: SummarizeSummary["failures"] = [];
    let summaries = 0;

    this.log(`${pending.length} traces to summarize`);
    for (const trace of pending) {
      try {
        const produced = await this.summarizer.summarize(trace, this.facets);
        this.store.insertSummaries(produced);
        summaries += produced.length;
      } catch (err) {
        failures.push({ traceId: trace.id, error: (err as Error).message });
      }
    }

    const embedded = await this.embedPending();
    if (failures.length > 0) this.log(`${failures.length} traces failed to summarize and will be retried next run`);
    return { traces: pending.length, summaries, embedded, failures };
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
  async bootstrap(): Promise<DiscoverySummary[]> {
    const out: DiscoverySummary[] = [];
    for (const facet of this.facets) {
      const created = await this.registry.discover(facet.name);
      this.log(`${facet.name}: discovered ${created.length} themes`);
      out.push({ facet: facet.name, created });
    }
    return out;
  }

  /**
   * Steady state: assign what is new, and re-run discovery only where the
   * residual pile has grown past the threshold. Discovery runs at most once per
   * facet per pass — a second pass on the same residuals would find the same
   * nothing and only burn tokens.
   */
  async assign(): Promise<AssignSummary[]> {
    const out: AssignSummary[] = [];
    for (const facet of this.facets) {
      const result = this.registry.assignPending(facet.name);
      let rediscovered: Theme[] = [];

      const windows = this.store.windowsForFacet(facet.name);
      const latest = windows[windows.length - 1];
      if (latest && this.registry.needsRediscovery(facet.name, latest)) {
        this.log(`${facet.name}: residual pile over ${(this.cfg.rediscoverResidualShare * 100).toFixed(0)}%, running discovery`);
        rediscovered = await this.registry.discover(facet.name);
        if (rediscovered.length > 0) {
          // newly created themes may also cover older residuals
          const second = this.registry.assignPending(facet.name);
          result.assigned += second.assigned;
          result.transitions.push(...second.transitions);
        }
      }

      const autoResolved = this.registry.sweepAutoResolve(facet.name);
      this.log(`${facet.name}: ${result.assigned} assigned, ${result.residual} residual`);
      out.push({
        facet: facet.name,
        assigned: result.assigned,
        residual: result.residual,
        transitions: result.transitions,
        rediscovered,
        autoResolved,
      });
    }
    return out;
  }

  /* ---------- the whole loop ---------- */

  /**
   * Ingest (optional) → summarize → embed → discover-or-assign.
   * The one command that takes a pile of traces and produces an issues list.
   */
  async analyze(opts: { otlpPath?: string; jsonl?: string; agentId?: string; limit?: number } = {}): Promise<{
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

    const summarizeOpts: { limit?: number } = {};
    if (opts.limit !== undefined) summarizeOpts.limit = opts.limit;
    const summarize = await this.summarize(summarizeOpts);

    // Bootstrap and steady state are the same code path; discovery on an empty
    // registry simply has everything as its residual pile.
    const discovery = this.store.allThemes().length === 0 ? await this.bootstrap() : [];
    const assign = await this.assign();

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

  report(opts: { facet?: string; window?: string } = {}): FacetReport[] {
    const facets = opts.facet ? [opts.facet] : this.facets.map((f) => f.name);
    return facets.map((facet) => {
      const reportOpts: { facet: string; window?: string } = { facet };
      if (opts.window) reportOpts.window = opts.window;
      return buildFacetReport(this.store, this.cfg, reportOpts);
    });
  }

  delta(facet: string, fromWindow: string, toWindow: string): DeltaReport {
    return computeDeltas(this.store, facet, fromWindow, toWindow, { sigma: this.cfg.deltaSigma });
  }

  /** The two most recent windows for a facet, which is what `sift delta` defaults to. */
  latestWindowPair(facet: string): { from: string; to: string } | null {
    const windows = this.store.windowsForFacet(facet);
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
