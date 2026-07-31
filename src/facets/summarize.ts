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
  /** per-attempt request timeout; see postJson */
  timeoutMs?: number;
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
  const cleaned = stripThinking(raw).replace(/```(?:json)?/gi, "").trim();

  for (const candidate of [cleaned, ...braceCandidates(cleaned)]) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
        else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
      }
      // An object of nothing usable is not an answer; keep scanning rather than
      // storing a row of blanks that looks like a successful summarization.
      if (Object.keys(out).length > 0) return out;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`could not parse facet JSON from model output: ${raw.slice(0, 400)}`);
}

/**
 * A reasoning model narrates before it answers, and its scratchpad is prose
 * full of braces. Dropping it first is what keeps the scan below honest.
 * An unterminated <think> means the reply was cut off mid-thought — there is no
 * JSON after it either way.
 */
function stripThinking(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, " ").replace(/<think>[\s\S]*$/i, " ");
}

/**
 * Every balanced-brace object in the text, left to right, so the *first* one
 * that parses wins. The old first-{-to-last-} slice spanned from a brace in the
 * preamble to a brace in the sign-off and parsed as neither.
 *
 * Quotes are tracked so a brace inside a summary string does not close the
 * object. Once an object closes, the scan resumes after it rather than inside
 * it: a nested `{"a":1}` is part of its parent, not a rival answer, and
 * preferring it would return a fragment over the reply that follows. An object
 * that never closes yields nothing and the scan continues, which is what finds
 * the real JSON after a truncated one.
 *
 * Capped because a reply is bounded by max_tokens and an O(n²) scan over
 * anything larger would be a denial of service on a malformed body.
 */
function braceCandidates(text: string, cap = 32): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length && out.length < cap; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j]!;
      if (escaped) escaped = false;
      else if (ch === "\\" && inString) escaped = true;
      else if (ch === '"') inString = !inString;
      else if (inString) continue;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        out.push(text.slice(i, j + 1));
        i = j;
        break;
      }
    }
  }
  return out;
}

/**
 * The output budget, scaled by facet count, and overridable because the scaling
 * cannot see the model. A fixed 400 truncated a six-facet reply mid-string,
 * which `parseFacetJson` could only report as a parse error — on every trace,
 * every run, forever, because a failed trace stays pending and gets paid for
 * again. A reasoning model reaches the same dead end from the other side: its
 * thinking is spent from this same budget, and 480 tokens of it buys no answer
 * at all. `llm.maxTokens` (SIFT_LLM_MAX_TOKENS) is the way out of that.
 */
export function maxTokensFor(facets: FacetDef[], configured?: number): number {
  return configured ?? Math.max(400, 120 * facets.length);
}

/** What the labeler asks for: one label and one sentence, unless the config says otherwise. */
const LABEL_MAX_TOKENS = 200;

/**
 * Truncation is not a parse error and must not be reported as one: the reply is
 * well-formed JSON that simply stops, and the fix is a budget, not a retry.
 */
function assertNotTruncated(reason: string | undefined, maxTokens: number): void {
  if (reason === "max_tokens" || reason === "length") {
    throw new Error(
      `model output was truncated at ${maxTokens} tokens before the JSON closed — ` +
        `raise it with SIFT_LLM_MAX_TOKENS (a reasoning model spends this budget on thinking before it answers), ` +
        `or use fewer facets`,
    );
  }
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
  protected timeoutMs: number | undefined;

  constructor(cfg: LlmConfig, opts: LlmProviderOptions = {}) {
    this.cfg = cfg;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxTraceChars = opts.maxTraceChars ?? DEFAULT_MAX_TRACE_CHARS;
    this.labelSampleSize = opts.labelSampleSize ?? 20;
    this.timeoutMs = opts.timeoutMs;
  }

  /** One prompt in, one text completion out — the only thing sift asks of an LLM. */
  protected abstract complete(prompt: string, maxTokens: number): Promise<string>;

  protected post<T>(url: string, headers: Record<string, string>, body: unknown, label: string): Promise<T> {
    const opts: Parameters<typeof postJson>[3] = {
      fetchImpl: this.fetchImpl,
      maxRetries: this.maxRetries,
      sleep: this.sleep,
      label,
    };
    if (this.timeoutMs !== undefined) opts.timeoutMs = this.timeoutMs;
    return postJson<T>(url, headers, body, opts);
  }

  /** Anthropic /v1/messages. Thinking blocks are tolerated: only text is kept. */
  protected async anthropicComplete(prompt: string, maxTokens: number, label: string): Promise<string> {
    const data = await this.post<{ content: Array<{ type: string; text?: string }>; stop_reason?: string }>(
      `${trimSlash(this.cfg.baseUrl)}/v1/messages`,
      {
        "content-type": "application/json",
        "x-api-key": this.cfg.apiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      { model: this.cfg.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] },
      label,
    );
    assertNotTruncated(data.stop_reason, maxTokens);
    return data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  }

  /** Any OpenAI-compatible /v1/chat/completions: OpenAI, ollama, llama.cpp, vLLM. */
  protected async openAiComplete(prompt: string, maxTokens: number, label: string): Promise<string> {
    const url = `${trimSlash(this.cfg.baseUrl)}/v1/chat/completions`;
    const headers = { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey ?? ""}` };
    const base = { model: this.cfg.model, messages: [{ role: "user", content: prompt }] };
    type Chat = { choices: Array<{ message?: { content?: string }; finish_reason?: string }> };

    let data: Chat;
    try {
      data = await this.post<Chat>(url, headers, { ...base, max_tokens: maxTokens }, label);
    } catch (err) {
      // The one 400 that is not permanent: newer OpenAI models reject max_tokens
      // and name the field they want instead. postJson is right not to retry a
      // 400 in general, so the rename is retried here, once, on that body only.
      if (!wantsMaxCompletionTokens(err)) throw err;
      data = await this.post<Chat>(url, headers, { ...base, max_completion_tokens: maxTokens }, label);
    }
    assertNotTruncated(data.choices[0]?.finish_reason, maxTokens);
    return data.choices[0]?.message?.content ?? "";
  }
}

function wantsMaxCompletionTokens(err: unknown): boolean {
  return err instanceof Error && / HTTP 400: /.test(err.message) && err.message.includes("max_completion_tokens");
}

export class AnthropicSummarizer extends HttpLlm implements Summarizer {
  async summarize(trace: Trace, facets: FacetDef[]): Promise<FacetSummary[]> {
    const text = await this.complete(
      buildFacetPrompt(trace, facets, this.maxTraceChars),
      maxTokensFor(facets, this.cfg.maxTokens),
    );
    return toSummaries(trace, facets, parseFacetJson(text));
  }

  protected override complete(prompt: string, maxTokens: number): Promise<string> {
    return this.anthropicComplete(prompt, maxTokens, "summarizer");
  }
}

export class OpenAiSummarizer extends HttpLlm implements Summarizer {
  async summarize(trace: Trace, facets: FacetDef[]): Promise<FacetSummary[]> {
    const text = await this.complete(
      buildFacetPrompt(trace, facets, this.maxTraceChars),
      maxTokensFor(facets, this.cfg.maxTokens),
    );
    return toSummaries(trace, facets, parseFacetJson(text));
  }

  protected override complete(prompt: string, maxTokens: number): Promise<string> {
    return this.openAiComplete(prompt, maxTokens, "summarizer");
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

    const text = await this.complete(prompt, this.cfg.maxTokens ?? LABEL_MAX_TOKENS);
    const parsed = parseFacetJson(text);
    const fallback = fallbackLabel(memberSummaries);
    return {
      label: (parsed.label ?? "").trim() || fallback,
      description: (parsed.description ?? "").trim() || `traces whose ${facet} resembles: ${fallback}`,
    };
  }

  protected override complete(prompt: string, maxTokens: number): Promise<string> {
    return this.cfg.provider === "openai"
      ? this.openAiComplete(prompt, maxTokens, "labeler")
      : this.anthropicComplete(prompt, maxTokens, "labeler");
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
