import type { FacetDef, FacetSummary, Labeler, Summarizer, Trace } from "../types.ts";
import type { LlmConfig } from "../config.ts";
import { postJson, trimSlash } from "../embed/index.ts";
import { KeywordSummarizer, StubLabeler } from "../testing/fakes.ts";

/**
 * The Clio move: one cheap LLM call per trace produces one line per facet.
 * Those lines are what get embedded; the raw trace never is.
 *
 * Summaries are instructed to strip identifiers, which is the first layer of
 * the privacy posture (OVERVIEW.md §3.6) — the pseudonymization gate slots in
 * in front of this step later.
 */

export const DEFAULT_MAX_TRACE_CHARS = 24_000;

export interface LlmProviderOptions {
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  maxTraceChars?: number;
  /** how many member summaries a labeler sends for a cluster */
  labelSampleSize?: number;
}

/** Keeps the head and the tail: the setup and the failure are both load-bearing. */
export function clipTrace(text: string, maxChars = DEFAULT_MAX_TRACE_CHARS): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n...[trace truncated]...\n${text.slice(-half)}`;
}

/**
 * Models add fences and preamble no matter how firmly they are told not to,
 * and a summarize run that dies on the 900th trace because of a stray "Sure!"
 * is not acceptable. Values are coerced to strings; non-scalars are dropped.
 */
export function parseFacetJson(raw: string): Record<string, string> {
  const candidates: string[] = [];
  const fenced = raw.replace(/```(?:json)?/gi, "").trim();
  candidates.push(fenced);
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(fenced.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
        else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
      }
      return out;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`could not parse facet JSON from model output: ${raw.slice(0, 400)}`);
}

export function buildFacetPrompt(trace: Trace, facets: FacetDef[], maxTraceChars: number): string {
  return [
    "You are summarizing an AI agent trace for aggregate analysis.",
    "For each facet below, write exactly one line.",
    "Never include names, emails, account numbers, URLs or other identifiers; describe roles and categories instead.",
    "",
    "Facets:",
    ...facets.map((f) => `"${f.name}": ${f.instruction}`),
    "",
    "Respond with ONLY a JSON object mapping facet name to summary string. No markdown fences.",
    "",
    "Trace:",
    clipTrace(trace.text, maxTraceChars),
  ].join("\n");
}

function toSummaries(trace: Trace, facets: FacetDef[], parsed: Record<string, string>): FacetSummary[] {
  // Every facet gets a row even when the model skipped one: a missing row would
  // make the trace look permanently unsummarized and it would be retried forever.
  return facets.map((f) => ({
    traceId: trace.id,
    facet: f.name,
    summary: (parsed[f.name] ?? "").trim() || "unclear",
  }));
}

abstract class HttpLlm {
  protected cfg: LlmConfig;
  protected fetchImpl: typeof fetch;
  protected maxRetries: number;
  protected sleep: (ms: number) => Promise<void>;
  protected maxTraceChars: number;
  protected labelSampleSize: number;

  constructor(cfg: LlmConfig, opts: LlmProviderOptions = {}) {
    this.cfg = cfg;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxTraceChars = opts.maxTraceChars ?? DEFAULT_MAX_TRACE_CHARS;
    this.labelSampleSize = opts.labelSampleSize ?? 20;
  }

  /** One prompt in, one text completion out — the only thing sift asks of an LLM. */
  protected abstract complete(prompt: string, maxTokens: number): Promise<string>;

  protected post<T>(url: string, headers: Record<string, string>, body: unknown, label: string): Promise<T> {
    return postJson<T>(url, headers, body, {
      fetchImpl: this.fetchImpl,
      maxRetries: this.maxRetries,
      sleep: this.sleep,
      label,
    });
  }
}

export class AnthropicSummarizer extends HttpLlm implements Summarizer {
  async summarize(trace: Trace, facets: FacetDef[]): Promise<FacetSummary[]> {
    const text = await this.complete(buildFacetPrompt(trace, facets, this.maxTraceChars), 400);
    return toSummaries(trace, facets, parseFacetJson(text));
  }

  protected override async complete(prompt: string, maxTokens: number): Promise<string> {
    const data = await this.post<{ content: Array<{ type: string; text?: string }> }>(
      `${trimSlash(this.cfg.baseUrl)}/v1/messages`,
      {
        "content-type": "application/json",
        "x-api-key": this.cfg.apiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      { model: this.cfg.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] },
      "summarizer",
    );
    return data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  }
}

export class OpenAiSummarizer extends HttpLlm implements Summarizer {
  async summarize(trace: Trace, facets: FacetDef[]): Promise<FacetSummary[]> {
    const text = await this.complete(buildFacetPrompt(trace, facets, this.maxTraceChars), 400);
    return toSummaries(trace, facets, parseFacetJson(text));
  }

  protected override async complete(prompt: string, maxTokens: number): Promise<string> {
    const data = await this.post<{ choices: Array<{ message?: { content?: string } }> }>(
      `${trimSlash(this.cfg.baseUrl)}/v1/chat/completions`,
      { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey ?? ""}` },
      { model: this.cfg.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] },
      "summarizer",
    );
    return data.choices[0]?.message?.content ?? "";
  }
}

/**
 * Names a discovered cluster from a sample of its members.
 *
 * Separate from the summarizer because it is a different prompt at a different
 * cadence: summarizing is per trace and constant, labeling happens once per new
 * theme and never again — that permanence is what keeps IDs from churning.
 */
export class HttpLabeler extends HttpLlm implements Labeler {
  async label(facet: string, memberSummaries: string[]): Promise<{ label: string; description: string }> {
    const sample = memberSummaries.slice(0, this.labelSampleSize).map((s) => `- ${s}`).join("\n");
    const prompt = [
      `These are one-line summaries of the "${facet}" facet of agent traces that clustered together.`,
      "Write a short label (max 8 words, lowercase, specific, no identifiers) and a one-sentence description of what unites them.",
      'Respond with ONLY JSON: {"label": "...", "description": "..."}',
      "",
      sample,
    ].join("\n");

    const text = await this.complete(prompt, 200);
    const parsed = parseFacetJson(text);
    const fallback = fallbackLabel(memberSummaries);
    return {
      label: (parsed.label ?? "").trim() || fallback,
      description: (parsed.description ?? "").trim() || `traces whose ${facet} resembles: ${fallback}`,
    };
  }

  protected override async complete(prompt: string, maxTokens: number): Promise<string> {
    if (this.cfg.provider === "openai") {
      const data = await this.post<{ choices: Array<{ message?: { content?: string } }> }>(
        `${trimSlash(this.cfg.baseUrl)}/v1/chat/completions`,
        { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey ?? ""}` },
        { model: this.cfg.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] },
        "labeler",
      );
      return data.choices[0]?.message?.content ?? "";
    }
    const data = await this.post<{ content: Array<{ type: string; text?: string }> }>(
      `${trimSlash(this.cfg.baseUrl)}/v1/messages`,
      { "content-type": "application/json", "x-api-key": this.cfg.apiKey ?? "", "anthropic-version": "2023-06-01" },
      { model: this.cfg.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] },
      "labeler",
    );
    return data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  }
}

/** A theme with no label is unusable in an issues list, so never return one. */
export function fallbackLabel(memberSummaries: string[]): string {
  const first = memberSummaries[0]?.trim();
  if (!first) return "unlabeled theme";
  return first.length > 60 ? `${first.slice(0, 57)}...` : first;
}

export interface FactoryOptions extends LlmProviderOptions {
  /** fail at construction rather than on the first call of a long run */
  requireKey?: boolean;
}

export function createSummarizer(cfg: LlmConfig, opts: FactoryOptions = {}): Summarizer {
  // "fake" is a supported production mode, not just a test seam: it runs the
  // whole pipeline with no key and no network, which is how `sift demo` works.
  if (cfg.provider === "fake") return new KeywordSummarizer();
  requireKeyIfNeeded(cfg, opts);
  return cfg.provider === "openai" ? new OpenAiSummarizer(cfg, opts) : new AnthropicSummarizer(cfg, opts);
}

export function createLabeler(cfg: LlmConfig, opts: FactoryOptions = {}): Labeler {
  if (cfg.provider === "fake") return new StubLabeler();
  requireKeyIfNeeded(cfg, opts);
  return new HttpLabeler(cfg, opts);
}

function requireKeyIfNeeded(cfg: LlmConfig, opts: FactoryOptions): void {
  if (opts.requireKey && !cfg.apiKey) {
    throw new Error(`llm provider "${cfg.provider}" needs an API key: set SIFT_LLM_API_KEY or llm.apiKey in sift.config.json`);
  }
}
