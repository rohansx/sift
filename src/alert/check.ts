import type { DeltaFinding, DeltaSeverity } from "../types.ts";
import type { DeltaReport } from "../delta/index.ts";
import type { Pipeline } from "../pipeline.ts";

/**
 * The CI gate.
 *
 * Evals catch the failure modes you already knew about; that is what makes them
 * a build step. Discovery catches the ones you didn't, and until it can also
 * fail a build it stays a thing someone has to remember to go and look at.
 * `sift check` closes that: run it after a deploy, exit non-zero when a theme
 * you had marked resolved starts happening again.
 */

/**
 * Regressions only, by default. Discovering something new is normal and
 * constant — gating on it would turn every release into a red build and teach
 * everyone to ignore the gate.
 */
export const DEFAULT_FAIL_ON: DeltaSeverity[] = ["regression"];

export interface CheckOptions {
  failOn: DeltaSeverity[];
  agentId?: string;
  facet?: string;
  from?: string;
  to?: string;
  /** ignore themes below this share of the window; keeps tiny noise out of CI */
  minShare?: number;
  /** pass on a partly summarized corpus, for teams who sample deliberately */
  allowPartial?: boolean;
}

export interface CheckResult {
  ok: boolean;
  failures: DeltaFinding[];
  reports: DeltaReport[];
  /** human-readable explanations for anything that was skipped */
  notes: string[];
  /**
   * Traces in no window, across everything checked. Separate from `failures`
   * on purpose: "the gate could not see the whole build" and "a theme
   * regressed" are different verdicts and a CI log must not confuse them.
   */
  uncoveredTraces: number;
}

export function runCheck(pipeline: Pipeline, opts: CheckOptions): CheckResult {
  const facets = opts.facet ? [opts.facet] : pipeline.facets.map((f) => f.name);
  const agents = opts.agentId ? [opts.agentId] : pipeline.agents();
  const minShare = opts.minShare ?? 0;

  const reports: DeltaReport[] = [];
  const failures: DeltaFinding[] = [];
  const notes: string[] = [];
  let uncoveredTraces = 0;

  for (const agentId of agents) {
    for (const facet of facets) {
      // Counted only where the facet has been analyzed at all: a facet with no
      // windows is one nobody uses, already covered by the note below, not a
      // half-finished run.
      if (pipeline.store.windowsForFacet(agentId, facet).length > 0) {
        uncoveredTraces += pipeline.store.countUncoveredTraces(agentId, facet);
      }

      let from = opts.from;
      let to = opts.to;
      if (!from || !to) {
        const pair = pipeline.latestWindowPair(agentId, facet);
        if (!pair) {
          // A first-ever run has one window. Failing there would break every
          // pipeline the day the gate was added, and find nothing.
          notes.push(`${agentId}/${facet}: not enough windows to compare yet, nothing to check`);
          continue;
        }
        from ??= pair.from;
        to ??= pair.to;
      }

      const report = pipeline.delta(agentId, facet, from, to);
      reports.push(report);

      for (const finding of report.findings) {
        if (!opts.failOn.includes(finding.severity)) continue;
        if (finding.toShare < minShare) {
          notes.push(
            `${agentId}/${facet}: ${finding.themeId} is ${formatShare(finding.toShare)} of traffic, below the ${formatShare(minShare)} floor`,
          );
          continue;
        }
        failures.push(finding);
      }
    }
  }

  if (reports.length === 0 && notes.length === 0) notes.push("no facets to check");
  failures.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // A gate that green-lights a slice of the build is worse than one that
  // fails: it reports "nothing regressed" about traffic it never looked at.
  // Someone sampling on purpose still needs a way through, hence allowPartial.
  if (uncoveredTraces > 0 && opts.allowPartial) {
    notes.push(
      `${uncoveredTraces.toLocaleString("en-US")} traces are not summarized yet and were not checked (--allow-partial)`,
    );
  }
  const ok = failures.length === 0 && (uncoveredTraces === 0 || opts.allowPartial === true);
  return { ok, failures, reports, notes, uncoveredTraces };
}

function formatShare(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** One line per failure, the shape a CI log wants. */
export function renderCheck(result: CheckResult): string {
  const out: string[] = [""];
  if (result.ok) {
    out.push("  ✓ sift check passed — no themes regressed");
  }
  // Deliberately not the regression wording. Both exit 1, and a CI log that
  // says "failed — 0 findings" over a half-analyzed corpus teaches everyone
  // that the gate is broken.
  if (!result.ok && result.uncoveredTraces > 0) {
    out.push(
      `  ✗ sift check cannot vouch for this build — ${result.uncoveredTraces.toLocaleString("en-US")} traces are not summarized yet`,
    );
    out.push("      run sift summarize first, or sift check --allow-partial to gate on the analyzed slice");
  }
  if (result.failures.length > 0) {
    out.push(`  ✗ sift check failed — ${result.failures.length} finding${result.failures.length === 1 ? "" : "s"}`);
    out.push("");
    for (const f of result.failures) {
      const tag = f.severity === "regression" ? "REGRESSED" : f.severity.toUpperCase();
      out.push(`    ${tag}  ${f.themeId}  ${f.label}`);
      out.push(
        `      ${formatShare(f.fromShare)} → ${formatShare(f.toShare)} between ${f.fromWindow} and ${f.toWindow}` +
          (f.sigmas > 0 ? ` (${f.sigmas.toFixed(1)}σ)` : ""),
      );
      out.push(`      sift show ${f.themeId}`);
    }
  }
  for (const note of result.notes) out.push(`    note: ${note}`);
  out.push("");
  return out.join("\n");
}
