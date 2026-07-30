import type { DeltaReport } from "../delta/index.ts";
import type { ThemeState } from "../types.ts";
import { arrow, formatPercent, sparkline, type FacetReport } from "./model.ts";

/**
 * Markdown rendering, so the CLI is demoable and pasteable with zero UI.
 * `sift report --format md > report.md` is the v0 deliverable; a Next.js
 * issues list is explicitly out of scope until this stops being enough.
 */

export function renderThemeMarkdown(reports: FacetReport[]): string {
  const out: string[] = ["# sift report", ""];

  for (const report of reports) {
    out.push(`## ${report.facet}`, "");

    if (report.rows.length === 0) {
      out.push("_no themes yet — ingest traces and run `sift bootstrap`._", "");
      continue;
    }

    if (report.window) {
      out.push(
        `Window \`${report.window}\` · ${report.totalAssignments.toLocaleString("en-US")} traces` +
          (report.previousWindow ? ` · compared with \`${report.previousWindow}\`` : ""),
        "",
      );
    }

    out.push("| id | state | label | traces | share | change | trend |");
    out.push("|---|---|---|---:|---:|---:|---|");
    for (const row of report.rows) {
      const change = row.delta === undefined ? "—" : `${arrow(row.delta)}${formatPercent(Math.abs(row.delta))}`;
      const state = row.isNewHere && row.state !== "regressed" ? "🆕 new here" : badge(row.state);
      out.push(
        `| ${row.id} | ${state} | ${escapePipes(row.label)} | ${row.count} | ${formatPercent(row.share)} | ${change} | \`${sparkline(row.history)}\` |`,
      );
    }
    out.push("");
    out.push(
      `_residual pile: ${report.residualCount} traces (${formatPercent(report.residualShare)}) — discovery re-runs above ${formatPercent(report.rediscoverThreshold)}._`,
      "",
    );
  }

  return out.join("\n");
}

export function renderDeltaMarkdown(report: DeltaReport): string {
  const out: string[] = [`# sift delta: ${report.facet}`, ""];
  out.push(`\`${report.fromWindow}\` → \`${report.toWindow}\` · ${report.fromTotal} → ${report.toTotal} traces`, "");

  const attention = report.findings.filter((f) => f.severity !== "info");
  const stable = report.findings.filter((f) => f.severity === "info");

  if (attention.length > 0) {
    out.push("## needs attention", "");
    for (const f of attention) {
      const tag = f.severity === "regression" ? " **REGRESSED**" : f.severity === "new" ? " **NEW**" : "";
      const sigma = f.sigmas > 0 ? ` _(${f.sigmas.toFixed(1)}σ)_` : "";
      out.push(
        `- **${f.themeId}** ${escapePipes(f.label)}: ${formatPercent(f.fromShare)} → ${formatPercent(f.toShare)} ` +
          `(${arrow(f.delta)}${formatPercent(Math.abs(f.delta))})${tag}${sigma}`,
      );
    }
    out.push("");
  } else {
    out.push("Nothing notable changed.", "");
  }

  if (stable.length > 0) {
    out.push("## stable", "");
    for (const f of stable.slice(0, 10)) {
      out.push(`- ${f.themeId} ${escapePipes(f.label)}: ${formatPercent(f.toShare)} (±${formatPercent(Math.abs(f.delta))})`);
    }
    out.push("");
  }

  // A growing residual pile is itself a finding: every theme can look steady
  // while an increasing share of traffic matches nothing the registry knows.
  const residualDelta = report.toResidualShare - report.fromResidualShare;
  out.push(
    `_residual pile: ${formatPercent(report.fromResidualShare)} → ${formatPercent(report.toResidualShare)} ` +
      `(${arrow(residualDelta)}${formatPercent(Math.abs(residualDelta))})._`,
    "",
  );

  return out.join("\n");
}

function badge(state: ThemeState): string {
  const map: Record<ThemeState, string> = {
    new: "🆕 new",
    active: "active",
    regressed: "🔴 regressed",
    resolved: "✅ resolved",
    muted: "🔇 muted",
  };
  return map[state];
}

function escapePipes(text: string): string {
  return text.replace(/\|/g, "\\|");
}
