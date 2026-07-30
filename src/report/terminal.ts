import type { DeltaReport } from "../delta/index.ts";
import type { DeltaFinding, ThemeState } from "../types.ts";
import { arrow, formatPercent, sparkline, type FacetReport, type ThemeRow } from "./model.ts";

/**
 * The hero view is an issues list, not a Sankey (OVERVIEW.md §3.3) — Sentry's
 * issue stream, in a terminal. Colour is opt-in so piping to a file or a CI log
 * stays clean.
 */

export interface IssuesListOptions {
  agentId?: string;
  limit?: number;
  color?: boolean;
}

const ANSI = {
  reset: "[0m",
  dim: "[2m",
  bold: "[1m",
  red: "[31m",
  yellow: "[33m",
  cyan: "[36m",
  green: "[32m",
};

export function renderIssuesList(report: FacetReport, opts: IssuesListOptions = {}): string {
  const paint = painter(opts.color === true);
  const out: string[] = [];

  if (report.rows.length === 0) {
    out.push("");
    out.push(`  no themes yet for facet "${report.facet}".`);
    out.push(`  ingest traces, then run ${paint("sift bootstrap", "bold")} to discover them.`);
    out.push("");
    return out.join("\n");
  }

  const scope = [opts.agentId ? `agent: ${opts.agentId}` : null, `facet: ${report.facet}`, report.window ? `window: ${report.window}` : null]
    .filter(Boolean)
    .join(", ");

  out.push("");
  out.push(`  ${paint("THEMES", "bold")} (${scope}, ${report.totalAssignments.toLocaleString("en-US")} traces)`);
  out.push("");

  const limit = opts.limit ?? report.rows.length;
  const shown = report.rows.slice(0, limit);
  const idWidth = Math.max(...shown.map((r) => r.id.length));
  const labelWidth = Math.min(44, Math.max(...shown.map((r) => r.label.length)));

  for (const row of shown) {
    out.push(`  ▸ ${row.id.padEnd(idWidth)}  ${truncate(row.label, labelWidth).padEnd(labelWidth)}  ${changeCell(row)}  ${paint(stateTag(row.state), stateColor(row.state))} ${paint(sparkline(row.history), "dim")}`.trimEnd());
  }

  const hidden = report.rows.length - shown.length;
  if (hidden > 0) out.push(`    ${paint(`... ${hidden} more`, "dim")}`);

  out.push("");
  const willRun = report.residualShare > report.rediscoverThreshold ? "discovery will re-run" : `discovery re-runs at ${formatPercent(report.rediscoverThreshold)}`;
  out.push(
    `  ○ residual pile: ${report.residualCount} traces (${formatPercent(report.residualShare)}) — ${willRun}`,
  );
  out.push("");
  return out.join("\n");
}

const CHANGE_WIDTH = 22;

function changeCell(row: ThemeRow): string {
  const share = formatPercent(row.share).padStart(6);
  const change = (() => {
    if (row.previousShare === undefined) return "";
    const symbol = arrow(row.delta);
    if (symbol === "±") return `(± ${formatPercent(Math.abs(row.delta ?? 0))})`;
    return `${symbol} was ${formatPercent(row.previousShare)}`;
  })();
  return `${share}  ${change}`.padEnd(CHANGE_WIDTH);
}

function stateTag(state: ThemeState): string {
  return state === "regressed" ? "REGRESSED" : state === "new" ? "NEW" : state;
}

function stateColor(state: ThemeState): keyof typeof ANSI | undefined {
  switch (state) {
    case "regressed":
      return "red";
    case "new":
      return "yellow";
    case "resolved":
      return "green";
    case "muted":
      return "dim";
    default:
      return undefined;
  }
}

export function renderDeltaTerminal(report: DeltaReport, opts: { color?: boolean } = {}): string {
  const paint = painter(opts.color === true);
  const out: string[] = [""];
  out.push(`  ${paint("DELTA", "bold")} ${report.facet}: ${report.fromWindow} → ${report.toWindow}`);
  out.push("");

  const attention = report.findings.filter((f) => f.severity !== "info");
  if (attention.length === 0) {
    out.push("  nothing notable changed.");
  } else {
    for (const f of attention) {
      out.push(`  ▸ ${f.themeId}  ${f.label}`);
      out.push(
        `      ${formatPercent(f.fromShare)} → ${formatPercent(f.toShare)}  ${arrow(f.delta)}${formatPercent(Math.abs(f.delta))}  ${paint(severityTag(f), severityColor(f))}${sigmaNote(f)}`,
      );
    }
  }

  out.push("");
  out.push(
    `  ○ residual pile: ${formatPercent(report.fromResidualShare)} → ${formatPercent(report.toResidualShare)}`,
  );
  out.push("");
  return out.join("\n");
}

function severityTag(f: DeltaFinding): string {
  if (f.severity === "regression") return "REGRESSED";
  if (f.severity === "new") return "NEW";
  return "notable";
}

function severityColor(f: DeltaFinding): keyof typeof ANSI | undefined {
  if (f.severity === "regression") return "red";
  if (f.severity === "new") return "yellow";
  return "cyan";
}

function sigmaNote(f: DeltaFinding): string {
  return f.sigmas > 0 ? `  (${f.sigmas.toFixed(1)}σ)` : "";
}

function painter(enabled: boolean) {
  return (text: string, color?: keyof typeof ANSI): string => {
    if (!enabled || !color) return text;
    return `${ANSI[color]}${text}${ANSI.reset}`;
  };
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}
