import type { SiftConfig } from "../config.ts";
import type { SiftStore } from "../store/db.ts";
import type { ThemeState } from "../types.ts";
import { themeSeries } from "../delta/index.ts";

/**
 * The report model: one pass over the store producing everything the renderers
 * need. Rendering is then pure, which is why the markdown, terminal and JSON
 * views cannot disagree about the numbers.
 */

export interface ThemeRow {
  id: string;
  label: string;
  description: string;
  state: ThemeState;
  /** assignments in the reported window */
  count: number;
  share: number;
  /** share in the window before it, when there is one */
  previousShare?: number;
  delta?: number;
  /** share in every window, oldest first — the sparkline */
  history: number[];
  /** lifetime assignments, across all windows */
  memberCount: number;
  /** earliest window with traffic; equal to the reported window means "first seen here" */
  firstWindow?: string;
  lastSeenWindow?: string;
  exemplarTraceIds: string[];
  /** first appeared in the window being reported on */
  isNewHere: boolean;
}

export interface FacetReport {
  agentId: string;
  facet: string;
  /** the window being reported on; undefined when there are no assignments yet */
  window?: string;
  previousWindow?: string;
  windows: string[];
  totalAssignments: number;
  residualCount: number;
  residualShare: number;
  rediscoverThreshold: number;
  /** ingested but in no window at all — no share below counts them */
  uncoveredTraces: number;
  rows: ThemeRow[];
}

export interface BuildReportOptions {
  agentId: string;
  facet: string;
  /** defaults to the most recent window */
  window?: string;
}

export function buildFacetReport(store: SiftStore, cfg: SiftConfig, opts: BuildReportOptions): FacetReport {
  const stats = store.themeCountsByWindow(opts.agentId, opts.facet);
  const series = themeSeries(store, opts.agentId, opts.facet);
  const windows = stats.windows;

  const window = opts.window ?? windows[windows.length - 1];
  const windowIndex = window ? windows.indexOf(window) : -1;
  const previousWindow = windowIndex > 0 ? windows[windowIndex - 1] : undefined;

  const total = window ? (stats.totals.get(window) ?? 0) : 0;
  const counts = window ? (stats.counts.get(window) ?? new Map<string, number>()) : new Map<string, number>();
  const residualCount = window ? (stats.residuals.get(window) ?? 0) : 0;

  const rows: ThemeRow[] = [];
  // Every theme in the registry appears, including ones with no traffic this
  // window: a theme that has gone quiet is information, and omitting it would
  // make a resolved-then-forgotten issue invisible.
  for (const theme of store.themesForFacet(opts.agentId, opts.facet)) {
    const count = counts.get(theme.id) ?? 0;
    const share = total === 0 ? 0 : count / total;
    const history = (series.byTheme.get(theme.id) ?? []).map((p) => p.share);

    const row: ThemeRow = {
      id: theme.id,
      label: theme.label,
      description: theme.description,
      state: theme.state,
      count,
      share,
      history,
      memberCount: theme.memberCount,
      exemplarTraceIds: theme.exemplarTraceIds,
      isNewHere: window !== undefined && theme.firstWindow === window && count > 0,
    };
    if (theme.firstWindow) row.firstWindow = theme.firstWindow;
    if (theme.lastSeenWindow) row.lastSeenWindow = theme.lastSeenWindow;
    if (previousWindow) {
      const prevTotal = stats.totals.get(previousWindow) ?? 0;
      const prevCount = stats.counts.get(previousWindow)?.get(theme.id) ?? 0;
      row.previousShare = prevTotal === 0 ? 0 : prevCount / prevTotal;
      row.delta = share - row.previousShare;
    }
    rows.push(row);
  }

  rows.sort((a, b) => b.share - a.share || b.memberCount - a.memberCount || a.id.localeCompare(b.id));

  const report: FacetReport = {
    agentId: opts.agentId,
    facet: opts.facet,
    windows,
    totalAssignments: total,
    residualCount,
    residualShare: total === 0 ? 0 : residualCount / total,
    rediscoverThreshold: cfg.rediscoverResidualShare,
    // The residual pile is traffic the registry could not explain; this is
    // traffic the report never saw. Both belong on the page, and only one of
    // them was here before.
    uncoveredTraces: store.countUncoveredTraces(opts.agentId, [opts.facet]),
    rows,
  };
  if (window) report.window = window;
  if (previousWindow) report.previousWindow = previousWindow;
  return report;
}

const BLOCKS = "▁▂▃▄▅▆▇█";

/**
 * Unicode sparkline scaled to the series maximum.
 *
 * Two special cases, both about not lying: a series that never moved renders
 * mid-height rather than being stretched to full — scaling a flat line to the
 * top invents a spike out of "nothing happened" — and an all-zero series sits
 * on the baseline instead of vanishing.
 */
export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max <= 0) return BLOCKS[0]!.repeat(values.length);
  if (max - min < 1e-12) return BLOCKS[Math.floor(BLOCKS.length / 2) - 1]!.repeat(values.length);
  return values
    .map((v) => {
      const idx = Math.round((v / max) * (BLOCKS.length - 1));
      return BLOCKS[Math.max(0, Math.min(BLOCKS.length - 1, idx))]!;
    })
    .join("");
}

export function formatPercent(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

/** Arrow for a share change, or a neutral marker when it barely moved. */
export function arrow(delta: number | undefined, deadband = 0.001): string {
  if (delta === undefined || Math.abs(delta) < deadband) return "±";
  return delta > 0 ? "↑" : "↓";
}
