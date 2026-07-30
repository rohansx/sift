import type { Trace } from "./types.ts";

/**
 * A window is the unit deltas are computed over. A release tag beats a
 * calendar day whenever the emitter provides one: "what changed after v1.3"
 * is the question people actually ask, and a date only approximates it.
 */
export function windowForTrace(trace: Trace): string {
  if (trace.version && trace.version.length > 0) return trace.version;
  return dayWindow(trace.startedAt);
}

/** The UTC calendar day of an ISO timestamp. */
export function dayWindow(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}
