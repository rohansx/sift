import { readFileSync } from "node:fs";
import type { Trace } from "../types.ts";

/**
 * Ingestion, OTel-first (README point 5).
 *
 * v0 reads JSON-lines exports of GenAI semantic-convention spans. Three shapes
 * show up in the wild and all three are accepted, because "OTel-native" is
 * worth nothing if it only works with one vendor's exporter:
 *
 *   1. flat span objects with an attributes *map*   (Langfuse, Phoenix, OpenLIT)
 *   2. spans with OTLP protobuf-JSON attribute *arrays* of {key, value}
 *   3. whole ExportTraceServiceRequest envelopes    (collector file exporter)
 *
 * Spans sharing a trace id are grouped and flattened into one readable block,
 * which is the only thing the summarizer ever sees.
 */

export interface IngestOptions {
  /** agent id for traces whose spans name no agent */
  agentId?: string;
  /** throw on the first malformed line instead of skipping it */
  strict?: boolean;
}

export interface IngestResult {
  traces: Trace[];
  spanCount: number;
  skippedLines: number;
  errors: string[];
}

interface Span {
  traceId: string;
  spanId?: string;
  name?: string;
  startMs: number;
  endMs?: number;
  attributes: Record<string, unknown>;
  events: Array<{ name?: string; attributes: Record<string, unknown> }>;
  status?: { code?: string | number; message?: string };
}

export function ingestOtlpJsonlFile(path: string, opts: IngestOptions = {}): IngestResult {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`could not read trace file ${path}: ${(err as Error).message}`);
  }
  return parseOtlpJsonl(content, opts);
}

export function parseOtlpJsonl(content: string, opts: IngestOptions = {}): IngestResult {
  const errors: string[] = [];
  let skippedLines = 0;
  let spanCount = 0;
  const byTrace = new Map<string, Span[]>();

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      const msg = `line ${i + 1}: invalid JSON (${(err as Error).message})`;
      if (opts.strict) throw new Error(msg);
      errors.push(msg);
      skippedLines++;
      continue;
    }

    let spans: Span[];
    try {
      spans = extractSpans(parsed);
    } catch (err) {
      const msg = `line ${i + 1}: ${(err as Error).message}`;
      if (opts.strict) throw new Error(msg);
      errors.push(msg);
      skippedLines++;
      continue;
    }

    if (spans.length === 0) {
      const msg = `line ${i + 1}: no span with a trace id`;
      if (opts.strict) throw new Error(msg);
      errors.push(msg);
      skippedLines++;
      continue;
    }

    for (const span of spans) {
      spanCount++;
      const bucket = byTrace.get(span.traceId);
      if (bucket) bucket.push(span);
      else byTrace.set(span.traceId, [span]);
    }
  }

  const traces: Trace[] = [];
  for (const [traceId, spans] of byTrace) {
    spans.sort((a, b) => a.startMs - b.startMs || (a.spanId ?? "").localeCompare(b.spanId ?? ""));
    traces.push(toTrace(traceId, spans, opts.agentId ?? "default"));
  }

  return { traces, spanCount, skippedLines, errors };
}

/* ---------- shape normalization ---------- */

function extractSpans(raw: unknown): Span[] {
  if (typeof raw !== "object" || raw === null) throw new Error("expected an object");
  const obj = raw as Record<string, unknown>;

  // shape 3: an ExportTraceServiceRequest envelope
  const resourceSpans = (obj.resourceSpans ?? obj.resource_spans) as unknown;
  if (Array.isArray(resourceSpans)) {
    const out: Span[] = [];
    for (const rs of resourceSpans as Array<Record<string, unknown>>) {
      const resourceAttrs = readAttributes((rs.resource as Record<string, unknown>)?.attributes);
      const scopeSpans = (rs.scopeSpans ?? rs.scope_spans ?? rs.instrumentationLibrarySpans) as unknown;
      for (const ss of (Array.isArray(scopeSpans) ? scopeSpans : []) as Array<Record<string, unknown>>) {
        for (const s of (Array.isArray(ss.spans) ? ss.spans : []) as Array<Record<string, unknown>>) {
          const span = toSpan(s);
          if (!span) continue;
          // resource attributes are defaults; a span's own attributes win
          span.attributes = { ...resourceAttrs, ...span.attributes };
          out.push(span);
        }
      }
    }
    return out;
  }

  const span = toSpan(obj);
  return span ? [span] : [];
}

function toSpan(s: Record<string, unknown>): Span | null {
  const traceId = firstString(s, ["trace_id", "traceId", "traceID"]);
  if (!traceId) return null;

  const events = (Array.isArray(s.events) ? s.events : []) as Array<Record<string, unknown>>;
  const startMs = readTime(s, ["start_time", "startTime", "startTimeUnixNano", "start_time_unix_nano", "timestamp"]);
  const endMs = readTime(s, ["end_time", "endTime", "endTimeUnixNano", "end_time_unix_nano"]);

  const span: Span = {
    traceId,
    attributes: readAttributes(s.attributes),
    events: events.map((e) => ({
      name: typeof e.name === "string" ? e.name : undefined,
      attributes: readAttributes(e.attributes),
    })),
    startMs: startMs ?? 0,
  };
  const spanId = firstString(s, ["span_id", "spanId", "spanID"]);
  if (spanId) span.spanId = spanId;
  const name = firstString(s, ["name"]);
  if (name) span.name = name;
  if (endMs !== undefined) span.endMs = endMs;
  if (s.status && typeof s.status === "object") span.status = s.status as Span["status"];
  return span;
}

/** Accepts both the attribute-map and the OTLP {key, value: {...Value}} array forms. */
function readAttributes(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const out: Record<string, unknown> = {};
    for (const entry of raw as Array<Record<string, unknown>>) {
      if (typeof entry?.key !== "string") continue;
      out[entry.key] = readAnyValue(entry.value);
    }
    return out;
  }
  if (typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

function readAnyValue(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if ("stringValue" in o) return o.stringValue;
  if ("intValue" in o) return Number(o.intValue);
  if ("doubleValue" in o) return o.doubleValue;
  if ("boolValue" in o) return o.boolValue;
  if ("arrayValue" in o) {
    const values = (o.arrayValue as Record<string, unknown>)?.values;
    return Array.isArray(values) ? values.map(readAnyValue) : [];
  }
  return o;
}

function firstString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** ISO strings, epoch millis, and OTLP nanosecond strings all land as millis. */
function readTime(o: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "number") return v > 1e15 ? v / 1e6 : v;
    if (typeof v === "string") {
      if (/^\d+$/.test(v)) {
        const n = Number(v);
        return n > 1e15 ? n / 1e6 : n;
      }
      const parsed = Date.parse(v);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return undefined;
}

/* ---------- trace assembly ---------- */

const AGENT_KEYS = ["gen_ai.agent.name", "gen_ai.assistant.name", "service.name", "mastra.agent.name"];
const VERSION_KEYS = ["service.version", "deployment.environment.version", "gen_ai.agent.version", "release.version"];

function toTrace(traceId: string, spans: Span[], agentIdFallback: string): Trace {
  const agentId = scanAttr(spans, AGENT_KEYS) ?? agentIdFallback;
  const version = scanAttr(spans, VERSION_KEYS);

  const startMs = Math.min(...spans.map((s) => s.startMs));
  const ends = spans.map((s) => s.endMs).filter((n): n is number => typeof n === "number");
  const endMs = ends.length ? Math.max(...ends) : undefined;

  const tools: string[] = [];
  let hasError = false;
  for (const s of spans) {
    const tool = asString(s.attributes["gen_ai.tool.name"]);
    if (tool && !tools.includes(tool)) tools.push(tool);
    if (isError(s)) hasError = true;
  }

  const trace: Trace = {
    id: traceId,
    agentId,
    startedAt: new Date(startMs).toISOString(),
    text: renderSpans(spans),
    meta: {
      spanCount: spans.length,
      tools,
      hasError,
      ...(endMs !== undefined ? { durationMs: endMs - startMs } : {}),
    },
  };
  if (version) trace.version = version;
  if (endMs !== undefined) trace.endedAt = new Date(endMs).toISOString();
  return trace;
}

function scanAttr(spans: Span[], keys: string[]): string | undefined {
  for (const key of keys) {
    for (const s of spans) {
      const v = asString(s.attributes[key]);
      if (v) return v;
    }
  }
  return undefined;
}

function isError(s: Span): boolean {
  const code = s.status?.code;
  if (typeof code === "string" && code.toUpperCase().includes("ERROR")) return true;
  if (code === 2) return true; // STATUS_CODE_ERROR
  if (s.attributes["error.type"] !== undefined) return true;
  return s.events.some((e) => e.name === "exception");
}

/* ---------- rendering ---------- */

const PROMPT_KEYS = ["gen_ai.prompt", "gen_ai.input.messages", "gen_ai.request.messages"];
const COMPLETION_KEYS = ["gen_ai.completion", "gen_ai.output.messages", "gen_ai.response.messages"];
const TOOL_INPUT_KEYS = ["gen_ai.tool.input", "gen_ai.tool.call.arguments", "gen_ai.tool.arguments"];
const TOOL_OUTPUT_KEYS = ["gen_ai.tool.output", "gen_ai.tool.result", "gen_ai.tool.message"];

/**
 * Flattens the span tree into the block the summarizer reads. Durations are
 * included on purpose: retry loops, timeouts and runaway steps are exactly the
 * failure modes the behavior and resource facets are asked to notice, and they
 * are invisible in the message text alone.
 */
function renderSpans(spans: Span[]): string {
  const parts: string[] = [];
  for (const s of spans) {
    const op = asString(s.attributes["gen_ai.operation.name"]) ?? s.name ?? "span";
    const duration = s.endMs !== undefined ? ` (${Math.round(s.endMs - s.startMs)}ms)` : "";
    parts.push(`## ${op}${duration}`);

    const model = asString(s.attributes["gen_ai.request.model"]);
    if (model) parts.push(`model: ${model}`);

    const prompt = pickAttr(s, PROMPT_KEYS);
    if (prompt) parts.push(`input: ${renderMessages(prompt)}`);

    const tool = asString(s.attributes["gen_ai.tool.name"]);
    if (tool) {
      const args = pickAttr(s, TOOL_INPUT_KEYS);
      parts.push(`tool: ${tool}${args ? ` args: ${args}` : ""}`);
      const toolOut = pickAttr(s, TOOL_OUTPUT_KEYS);
      if (toolOut) parts.push(`tool result: ${toolOut}`);
    }

    const completion = pickAttr(s, COMPLETION_KEYS);
    if (completion) parts.push(`output: ${renderMessages(completion)}`);

    const inTok = s.attributes["gen_ai.usage.input_tokens"];
    const outTok = s.attributes["gen_ai.usage.output_tokens"];
    if (inTok !== undefined || outTok !== undefined) {
      parts.push(`tokens: in=${inTok ?? "?"} out=${outTok ?? "?"}`);
    }

    for (const e of s.events) {
      if (e.name === "exception") {
        const type = asString(e.attributes["exception.type"]) ?? "Exception";
        const message = asString(e.attributes["exception.message"]) ?? "unknown";
        parts.push(`ERROR: ${type}: ${message}`);
      } else if (e.name) {
        parts.push(`event: ${e.name}`);
      }
    }

    if (s.status?.message) parts.push(`status: ${s.status.code ?? ""} ${s.status.message}`.trim());
    else if (isError(s) && !s.events.some((e) => e.name === "exception")) parts.push(`status: error`);
  }
  return parts.join("\n");
}

/** Chat-message arrays render as `role: content` lines; anything else passes through. */
function renderMessages(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return raw;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const lines: string[] = [];
  for (const m of messages) {
    if (typeof m !== "object" || m === null) {
      lines.push(String(m));
      continue;
    }
    const o = m as Record<string, unknown>;
    const role = asString(o.role);
    const content = o.content;
    if (!role || content === undefined) return raw;
    lines.push(`${role}: ${typeof content === "string" ? content : JSON.stringify(content)}`);
  }
  return lines.length > 1 ? `\n${lines.join("\n")}` : lines[0] ?? raw;
}

function pickAttr(s: Span, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = asString(s.attributes[k]);
    if (v) return v;
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v.length > 0 ? v : undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v && typeof v === "object") return JSON.stringify(v);
  return undefined;
}
