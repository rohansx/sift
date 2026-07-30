import type { FacetDef, FacetSummary, Summarizer, Trace } from "../types.ts";
import { Pseudonymizer } from "./redact.ts";

/**
 * Slots the pseudonymization gate in front of the facet step, exactly where
 * OVERVIEW.md §3.6 says a PII rewrite belongs.
 *
 * It is a decorator over any Summarizer rather than a change to one, so it
 * works the same in front of Anthropic, an OpenAI-compatible endpoint, or a
 * self-hosted model — and so it can be audited in one place.
 *
 * The stored trace is never modified. Redaction protects the third party, not
 * the local archive: drill-down and eval export both need the real text, and
 * that text never left the machine.
 */

export interface GateStats {
  tracesProcessed: number;
  /** rule name -> values replaced */
  byRule: Record<string, number>;
  total: number;
}

export class RedactingSummarizer implements Summarizer {
  readonly stats: GateStats = { tracesProcessed: 0, byRule: {}, total: 0 };
  private inner: Summarizer;
  private gate: Pseudonymizer;

  constructor(inner: Summarizer, gate: Pseudonymizer) {
    this.inner = inner;
    this.gate = gate;
  }

  async summarize(trace: Trace, facets: FacetDef[]): Promise<FacetSummary[]> {
    const { text, counts, total } = this.gate.redact(trace.text);

    this.stats.tracesProcessed++;
    this.stats.total += total;
    for (const [rule, n] of Object.entries(counts)) {
      this.stats.byRule[rule] = (this.stats.byRule[rule] ?? 0) + n;
    }

    // A copy, so the caller's trace — and anything the store holds — is untouched.
    return this.inner.summarize({ ...trace, text }, facets);
  }
}
