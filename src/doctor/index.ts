import { DEFAULT_CONFIG, resolveFacets, type SiftConfig } from "../config.ts";
import { buildFacetPrompt, createSummarizer, DEFAULT_MAX_TRACE_CHARS } from "../facets/summarize.ts";
import { createEmbedder } from "../embed/index.ts";
import { withPrivacyGate } from "../pipeline.ts";
import { cosine } from "../cluster/vectors.ts";
import type { SiftStore } from "../store/db.ts";
import type { FacetDef, Trace } from "../types.ts";
import { PRICES_AS_OF, priceFor } from "./prices.ts";

/**
 * The preflight.
 *
 * Everything sift does against a hosted model is per-trace and paid, which
 * makes the expensive failures the ones that only show up on trace 900: a
 * provider/base-URL mismatch, an embedder whose width is not the configured
 * width, a model that answers in prose. `sift doctor` moves all of those to the
 * front, spends at most two calls doing it, and prints what the real run would
 * cost before anyone starts it.
 *
 * Pure over an injected store and fetch: it reads no environment and writes
 * nothing, so the whole thing is testable offline with a scripted fetch.
 */

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail" | "skip";
  detail: string;
  /** the one command or env var that resolves this check */
  fix?: string;
}

export interface CostEstimate {
  traces: number;
  inputTokens: number;
  outputTokens: number;
  embedTokens: number;
  charsPerToken: number;
  llmCost: number | null;
  embedCost: number | null;
  priced: boolean;
  assumptions: string[];
}

export interface DoctorResult {
  checks: DoctorCheck[];
  estimate: CostEstimate | null;
  ok: boolean;
}

export interface DoctorOptions {
  store: SiftStore;
  fetchImpl?: typeof fetch;
  /** false runs zero network calls; config and cost checks still run */
  probe?: boolean;
  timeoutMs?: number;
  agentId?: string;
  since?: string;
  /** where each key came from, for the key check; doctor never reads env itself */
  keySources?: { llm?: string; embeddings?: string };
  /** USD per 1M tokens, overriding the table */
  priceIn?: number;
  priceOut?: number;
}

/**
 * A preflight must report a rate limit in seconds, not sit in backoff for a
 * minute, so probes get one attempt and a short deadline.
 */
const PROBE_TIMEOUT_MS = 10_000;

/** Synthetic, and it stays synthetic: a preflight must never ship a user's trace. */
const PROBE_TRACE: Trace = {
  id: "doctor-probe",
  agentId: "doctor",
  startedAt: "2026-01-01T00:00:00.000Z",
  text: [
    "## chat",
    "input: the nightly job failed again, can you check it",
    "## execute_tool",
    "tool: read_logs",
    "ERROR: TimeoutError: request timed out after 30s",
    "output: I could not reach the log service. Please try again in a few minutes.",
  ].join("\n"),
  meta: {},
};

/** Two paraphrases and an unrelated line: enough to see whether an embedder has geometry. */
const PROBE_EMBED_TEXTS = [
  "the agent retried the search tool after a timeout",
  "after the tool timed out the agent tried again",
  "the user thanked the agent and left",
];

/** Below this, an embedder separates a paraphrase from a stranger about as well as HashEmbedder. */
const MIN_COSINE_GAP = 0.15;

export async function runDoctor(cfg: SiftConfig, opts: DoctorOptions): Promise<DoctorResult> {
  const facets = resolveFacets(cfg);
  const probe = opts.probe !== false;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const checks: DoctorCheck[] = [];

  // loadConfig already threw on anything invalid, so this is a restatement of
  // what will actually be used — which is the check, because most of the
  // surprises here are "I set the env var in the other shell".
  checks.push({
    name: "config",
    status: "ok",
    detail:
      `llm ${cfg.llm.provider}/${cfg.llm.model} at ${cfg.llm.baseUrl} · ` +
      `embeddings ${cfg.embeddings.provider}/${cfg.embeddings.model} (${cfg.embeddings.dimensions}d) · ` +
      `db ${cfg.dbPath} · ${facets.length} facets (${cfg.preset}): ${facets.map((f) => f.name).join(", ")}`,
  });

  checks.push(coherenceCheck(cfg));
  checks.push(keyCheck("llm key", cfg.llm.provider, cfg.llm.apiKey, opts.keySources?.llm, "SIFT_LLM_API_KEY", ["fake"]));
  checks.push(
    keyCheck("embed key", cfg.embeddings.provider, cfg.embeddings.apiKey, opts.keySources?.embeddings, "SIFT_EMBED_API_KEY", ["hash"]),
  );
  checks.push(privacyCheck(cfg));
  checks.push(await llmProbe(cfg, facets, { probe, timeoutMs, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }));
  checks.push(await embedProbe(cfg, { probe, timeoutMs, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }));

  const scope: { since?: string; agentId?: string } = {};
  if (opts.since) scope.since = opts.since;
  if (opts.agentId) scope.agentId = opts.agentId;
  const stats = opts.store.pendingSummaryStats(facets.map((f) => f.name), scope);
  checks.push({
    name: "corpus",
    status: "ok",
    detail:
      stats.traces === 0
        ? "nothing pending — every trace in scope already has all its facet summaries"
        : `${stats.traces.toLocaleString("en-US")} traces pending summarization, ` +
          `${stats.chars.toLocaleString("en-US")} chars of trace text after clipping`,
  });

  const prices: { in?: number; out?: number } = {};
  if (opts.priceIn !== undefined) prices.in = opts.priceIn;
  if (opts.priceOut !== undefined) prices.out = opts.priceOut;
  const estimate = estimateCost(stats, cfg, facets, prices);

  return { checks, estimate, ok: !checks.some((c) => c.status === "fail") };
}

/**
 * Provider, base URL and model are three independent settings with one default
 * set, which makes exactly one mistake very easy: `SIFT_LLM_PROVIDER=openai`
 * alone leaves the Anthropic base URL in place and sift POSTs
 * /v1/chat/completions at api.anthropic.com. The 404 that comes back names
 * neither setting.
 */
function coherenceCheck(cfg: SiftConfig): DoctorCheck {
  if (cfg.llm.provider === "openai" && cfg.llm.baseUrl === DEFAULT_CONFIG.llm.baseUrl) {
    return {
      name: "coherence",
      status: "fail",
      detail: `llm.provider is "openai" but llm.baseUrl is still the Anthropic default (${cfg.llm.baseUrl}); every call would POST an OpenAI body to Anthropic`,
      fix: "SIFT_LLM_BASE_URL=https://api.openai.com (or your local server), and set SIFT_LLM_MODEL to match",
    };
  }
  if (cfg.llm.provider === "anthropic" && !cfg.llm.model.startsWith("claude")) {
    return {
      name: "coherence",
      status: "fail",
      detail: `llm.provider is "anthropic" but llm.model is ${JSON.stringify(cfg.llm.model)}, which is not a Claude model id`,
      fix: "SIFT_LLM_MODEL=claude-haiku-4-5-20251001, or SIFT_LLM_PROVIDER=openai if that model is served over an OpenAI-compatible API",
    };
  }
  return { name: "coherence", status: "ok", detail: "provider, base URL and model agree with each other" };
}

/**
 * Reports presence, source and length — never the value. Doctor output gets
 * pasted into issues.
 */
function keyCheck(
  name: string,
  provider: string,
  key: string | undefined,
  source: string | undefined,
  envVar: string,
  offlineProviders: string[],
): DoctorCheck {
  if (offlineProviders.includes(provider)) {
    return { name, status: "skip", detail: `provider "${provider}" needs no key` };
  }
  if (!key) {
    return {
      name,
      status: "fail",
      detail: `provider "${provider}" needs an API key and none is set`,
      fix: `export ${envVar}=...`,
    };
  }
  const where = source ?? "config";
  const check: DoctorCheck = { name, status: "ok", detail: `${key.length} chars, from ${where}` };
  if (where.endsWith(".json")) {
    // Not pedantry: a key in a file next to the code is a key that gets committed.
    check.status = "warn";
    check.fix = `move it to ${envVar} — a key in a config file is a key that gets committed`;
  }
  return check;
}

function privacyCheck(cfg: SiftConfig): DoctorCheck {
  const hosted = cfg.llm.provider !== "fake";
  if (cfg.privacy.mode === "off" && hosted) {
    return {
      name: "privacy",
      status: "warn",
      detail: `privacy.mode is "off" and llm.provider is "${cfg.llm.provider}": raw trace text, identifiers included, will be sent to ${cfg.llm.baseUrl}`,
      fix: "SIFT_PRIVACY_MODE=pseudonymize, and `sift privacy --otlp <file>` to see exactly what that strips",
    };
  }
  return {
    name: "privacy",
    status: "ok",
    detail: `gate is ${cfg.privacy.mode} (scope ${cfg.privacy.scope})`,
  };
}

interface ProbeOptions {
  probe: boolean;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** maxRetries 0 is the point: a preflight reports a 429 in seconds, it does not sit in backoff. */
function probeFactory(opts: ProbeOptions): { maxRetries: number; timeoutMs: number; fetchImpl?: typeof fetch } {
  const factory: { maxRetries: number; timeoutMs: number; fetchImpl?: typeof fetch } = {
    maxRetries: 0,
    timeoutMs: opts.timeoutMs,
  };
  if (opts.fetchImpl) factory.fetchImpl = opts.fetchImpl;
  return factory;
}

/**
 * One synthetic trace through the configured summarizer, through the same
 * privacy gate a real run uses. Proves auth, the base URL, the model id and
 * JSON parsing in a single call.
 */
async function llmProbe(cfg: SiftConfig, facets: FacetDef[], opts: ProbeOptions): Promise<DoctorCheck> {
  const name = "llm probe";
  if (cfg.llm.provider === "fake") {
    return { name, status: "skip", detail: 'llm.provider is "fake" — no model to reach' };
  }
  if (!opts.probe) return { name, status: "skip", detail: "--no-probe" };
  if (!cfg.llm.apiKey) return { name, status: "skip", detail: "no API key to probe with" };

  const summarizer = withPrivacyGate(createSummarizer(cfg.llm, probeFactory(opts)), cfg);

  const started = Date.now();
  try {
    const summaries = await summarizer.summarize(PROBE_TRACE, facets);
    const elapsed = Date.now() - started;
    const unclear = summaries.filter((s) => s.summary === "unclear").map((s) => s.facet);
    if (unclear.length > 0) {
      return {
        name,
        status: "fail",
        detail: `${cfg.llm.model} answered in ${elapsed}ms but returned nothing for: ${unclear.join(", ")}`,
        fix: "the model is not honouring the facet names; try a stronger model, or shorten the facet instructions",
      };
    }
    return {
      name,
      status: "ok",
      detail: `${cfg.llm.model} answered all ${facets.length} facets in ${elapsed}ms — e.g. ${JSON.stringify(summaries[0]!.summary.slice(0, 60))}`,
    };
  } catch (err) {
    // parseFacetJson puts the raw head in its message on purpose: a fenced or
    // thinking model is only diagnosable from what it actually said.
    return {
      name,
      status: "fail",
      detail: `${cfg.llm.model} at ${cfg.llm.baseUrl}: ${describeError(err)}`,
      fix: "check SIFT_LLM_BASE_URL, SIFT_LLM_MODEL and SIFT_LLM_API_KEY",
    };
  }
}

/**
 * Two calls' worth of information for one call: the returned width (a mismatch
 * currently surfaces after a paid page of summaries has already been bought)
 * and whether the geometry is good enough to cluster with at all.
 */
async function embedProbe(cfg: SiftConfig, opts: ProbeOptions): Promise<DoctorCheck> {
  const name = "embed probe";
  if (cfg.embeddings.provider === "hash") {
    return { name, status: "skip", detail: 'embeddings.provider is "hash" — local, free, and not semantic' };
  }
  if (!opts.probe) return { name, status: "skip", detail: "--no-probe" };
  if (!cfg.embeddings.apiKey) return { name, status: "skip", detail: "no API key to probe with" };

  try {
    const [a, b, c] = await createEmbedder(cfg.embeddings, probeFactory(opts)).embed(PROBE_EMBED_TEXTS);
    const near = cosine(a!, b!);
    const far = cosine(a!, c!);
    const gap = near - far;
    const geometry = `paraphrase cosine ${near.toFixed(3)} vs unrelated ${far.toFixed(3)} (gap ${gap.toFixed(3)})`;
    if (gap < MIN_COSINE_GAP) {
      return {
        name,
        status: "warn",
        detail: `${cfg.embeddings.model} returned ${a!.length} dimensions, but ${geometry}`,
        fix: `a gap under ${MIN_COSINE_GAP} will fragment one behavior into one theme per phrasing, the way the hash embedder does — try a different embedding model`,
      };
    }
    return { name, status: "ok", detail: `${cfg.embeddings.model} returned ${a!.length} dimensions; ${geometry}` };
  } catch (err) {
    const message = (err as Error).message;
    const width = /returned (\d+) dimensions/.exec(message);
    const check: DoctorCheck = {
      name,
      status: "fail",
      detail: `${cfg.embeddings.model} at ${cfg.embeddings.baseUrl}: ${describeError(err)}`,
    };
    // The embedder's own error already states both widths; all doctor adds is
    // the env var, which is the entire difference between a puzzle and a fix.
    if (width) check.fix = `SIFT_EMBED_DIMENSIONS=${width[1]} (a registry already built at ${cfg.embeddings.dimensions} cannot be extended at ${width[1]})`;
    else check.fix = "check SIFT_EMBED_BASE_URL, SIFT_EMBED_MODEL and SIFT_EMBED_API_KEY";
    return check;
  }
}

/**
 * node:fetch reports every transport failure as the word "fetch failed" and
 * hides the reason — ECONNREFUSED, ENOTFOUND, a TLS error, the abort — in
 * `cause`. Unwrapping it is the difference between a diagnosis and a shrug.
 */
function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
  const full = cause && !message.includes(cause) ? `${message} (${cause})` : message;
  // Say so when it cuts: an error that silently ends mid-word reads like the
  // endpoint returned something truncated, which is a different bug entirely.
  return full.length <= 400 ? full : `${full.slice(0, 400)}… (${full.length} chars)`;
}

/* ---------- cost ---------- */

/**
 * Deliberately below the usual 4.0 rule of thumb: trace text is JSON, stack
 * traces and code, which tokenize worse than prose. An estimate that comes in
 * high is a surprise nobody minds.
 */
export const CHARS_PER_TOKEN = 3.5;

/** One facet line's worth of output, and one summary line's worth of embedding input. */
const OUTPUT_TOKENS_PER_FACET = 30;
const EMBED_TOKENS_PER_SUMMARY = 25;

export function estimateCost(
  stats: { traces: number; chars: number },
  cfg: SiftConfig,
  facets: FacetDef[],
  prices: { in?: number; out?: number } = {},
): CostEstimate {
  // Computed, not hardcoded: the overhead moves with the preset and with any
  // edit to the prompt, and a constant here would silently go stale.
  const overheadChars = buildFacetPrompt({ ...PROBE_TRACE, text: "" }, facets, 0).length;
  const inputTokens = Math.ceil((stats.chars + overheadChars * stats.traces) / CHARS_PER_TOKEN);
  const outputTokens = stats.traces * OUTPUT_TOKENS_PER_FACET * facets.length;
  const embedTokens = stats.traces * facets.length * EMBED_TOKENS_PER_SUMMARY;

  const assumptions = [
    `one model call per trace, whatever the facet count`,
    `${overheadChars} chars of fixed prompt overhead per trace (preset "${cfg.preset}", ${facets.length} facets)`,
    `trace text counted as the summarizer sends it: clipped at ${DEFAULT_MAX_TRACE_CHARS.toLocaleString("en-US")} chars`,
    `${CHARS_PER_TOKEN} chars per token (below the usual 4.0, so JSON-heavy traces do not come in under)`,
    `${OUTPUT_TOKENS_PER_FACET} output tokens per facet line, ${EMBED_TOKENS_PER_SUMMARY} tokens per embedded summary`,
  ];

  const llm = cfg.llm.provider === "fake" ? { in: 0, out: 0 } : priceFor(cfg.llm.model);
  const embed = cfg.embeddings.provider === "hash" ? { in: 0, out: 0 } : priceFor(cfg.embeddings.model);
  const priceIn = prices.in ?? llm?.in;
  const priceOut = prices.out ?? llm?.out;

  const llmCost =
    priceIn === undefined || priceOut === undefined
      ? null
      : (inputTokens / 1e6) * priceIn + (outputTokens / 1e6) * priceOut;
  const embedCost = embed ? (embedTokens / 1e6) * embed.in : null;

  if (llmCost === null) {
    assumptions.push(`no published price on file for ${cfg.llm.model} (table as of ${PRICES_AS_OF}) — pass --price-in/--price-out`);
  } else if (prices.in !== undefined || prices.out !== undefined) {
    assumptions.push(`prices given on the command line: $${priceIn}/$${priceOut} per 1M tokens`);
  } else if (cfg.llm.provider !== "fake") {
    assumptions.push(`list prices as of ${PRICES_AS_OF}: ${cfg.llm.model} at $${priceIn}/$${priceOut} per 1M tokens`);
  }
  if (embedCost === null) {
    assumptions.push(`no published price on file for ${cfg.embeddings.model} (table as of ${PRICES_AS_OF})`);
  }

  return {
    traces: stats.traces,
    inputTokens,
    outputTokens,
    embedTokens,
    charsPerToken: CHARS_PER_TOKEN,
    llmCost,
    embedCost,
    priced: llmCost !== null && embedCost !== null,
    assumptions,
  };
}

/* ---------- rendering ---------- */

const GLYPH: Record<DoctorCheck["status"], string> = { ok: "✓", warn: "!", fail: "✗", skip: "–" };

export function renderDoctor(r: DoctorResult): string {
  const out: string[] = [""];
  for (const check of r.checks) {
    out.push(`  ${GLYPH[check.status]} ${check.name.padEnd(11)} ${check.detail}`);
    if (check.fix) out.push(`      fix: ${check.fix}`);
  }

  const e = r.estimate;
  if (e) {
    out.push("");
    if (e.traces === 0) {
      out.push("  cost estimate: nothing pending, so nothing to spend");
    } else {
      out.push(`  cost estimate for ${e.traces.toLocaleString("en-US")} pending traces`);
      // All the dollars or none of them. A run where only the embeddings have a
      // known price would print one small figure next to a much larger unpriced
      // one, and that reads as a total to anyone skimming.
      out.push(
        `    summarize   ${fmtTokens(e.inputTokens)} in + ${fmtTokens(e.outputTokens)} out` +
          (e.priced ? `   ${fmtUsd(e.llmCost!)}` : ""),
      );
      out.push(`    embed       ${fmtTokens(e.embedTokens)} in` + (e.priced ? `   ${fmtUsd(e.embedCost!)}` : ""));
      if (e.priced) out.push(`    total       ${fmtUsd(e.llmCost! + e.embedCost!)}`);
      else out.push("    no dollar figure: see below for which model has no price on file");
      out.push("");
      for (const a of e.assumptions) out.push(`    · ${a}`);
      out.push("");
      out.push("  this is an estimate, not a quote");
    }
  }

  out.push("");
  return out.join("\n");
}

function fmtTokens(n: number): string {
  return `${n.toLocaleString("en-US")} tok`;
}

function fmtUsd(n: number): string {
  return n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`;
}
