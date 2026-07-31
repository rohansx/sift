import { assembleTrace, type OtlpSpan } from "./otlp.ts";
import type { SiftStore } from "../store/db.ts";

/**
 * Turning staged spans into traces.
 *
 * A JSONL file arrives whole; a receiver sees BatchSpanProcessor flushes, so
 * one agent conversation routinely arrives across several POSTs. A trace is
 * therefore only assembled once nothing new has been seen for it in
 * `settleMs` — assembling per batch would persist half a conversation, and
 * `insertTrace` is INSERT OR IGNORE, so the rest would vanish without a word
 * and the summarizer would describe the half it got.
 */

export const DEFAULT_SETTLE_MS = 30_000;

export interface FlushOptions {
  /** quiet period after the last span of a trace before it is assembled */
  settleMs?: number;
  now?: Date;
  /** agent id for traces whose spans name no agent */
  agentId?: string;
  /** cap on traces assembled per call */
  limit?: number;
}

export interface FlushResult {
  traces: number;
  spans: number;
  /** settled traces whose id was already in the database */
  duplicates: number;
}

/**
 * Assemble and store every trace that has gone quiet.
 *
 * ponytail: settling on silence is a heuristic. A conversation that stalls
 * mid-flight for longer than `settleMs` flushes early, and its late spans then
 * assemble into an id that already exists and are dropped by INSERT OR IGNORE —
 * a truncated trace, never a corrupt one. The upgrade path is to flush when the
 * root span has been seen with an end time and keep `settleMs` as the backstop.
 */
export function flushSettledTraces(store: SiftStore, opts: FlushOptions = {}): FlushResult {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - (opts.settleMs ?? DEFAULT_SETTLE_MS)).toISOString();
  const result: FlushResult = { traces: 0, spans: 0, duplicates: 0 };

  for (const traceId of store.settledTraceIds(cutoff, opts.limit ?? 1000)) {
    // One transaction per trace: a crash mid-flush leaves either the staged
    // spans or the assembled trace, never neither.
    store.transaction(() => {
      const spans = store.pendingSpansFor(traceId).map((s) => JSON.parse(s) as OtlpSpan);
      if (spans.length === 0) return;
      if (store.insertTrace(assembleTrace(traceId, spans, opts.agentId ?? "default"))) result.traces++;
      else result.duplicates++;
      result.spans += spans.length;
      store.deletePendingSpans(traceId);
    });
  }
  return result;
}
