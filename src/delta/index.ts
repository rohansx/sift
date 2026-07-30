import type { DeltaFinding, DeltaSeverity } from "../types.ts";
import type { SiftStore } from "../store/db.ts";

/**
 * Deltas, not snapshots (OVERVIEW.md §3.3).
 *
 * "What are my themes" is a chart. "What changed since Tuesday's deploy" is the
 * question someone acts on, so this diffs theme shares between two windows and
 * scores each change against that theme's own historical variance — a theme
 * that swings 10 points every week has not done anything by swinging 10 points
 * again, and a steady one has.
 */

export interface DeltaOptions {
  /** |change| beyond this many standard deviations of the theme's history is notable */
  sigma: number;
  /** absolute floor, in share points, below which nothing is notable (default 1pp) */
  minAbsDelta?: number;
}

export interface DeltaReport {
  facet: string;
  fromWindow: string;
  toWindow: string;
  fromTotal: number;
  toTotal: number;
  fromResidualShare: number;
  toResidualShare: number;
  findings: DeltaFinding[];
}

const SEVERITY_RANK: Record<DeltaSeverity, number> = { regression: 0, new: 1, notable: 2, info: 3 };

export function computeDeltas(
  store: SiftStore,
  facet: string,
  fromWindow: string,
  toWindow: string,
  opts: DeltaOptions,
): DeltaReport {
  const minAbsDelta = opts.minAbsDelta ?? 0.01;
  const stats = store.themeCountsByWindow(facet);

  const fromTotal = stats.totals.get(fromWindow) ?? 0;
  const toTotal = stats.totals.get(toWindow) ?? 0;
  const fromCounts = stats.counts.get(fromWindow) ?? new Map<string, number>();
  const toCounts = stats.counts.get(toWindow) ?? new Map<string, number>();

  // Every window except the one being judged is history for the sigma estimate.
  const history = new Map<string, number[]>();
  for (const window of stats.windows) {
    if (window === toWindow) continue;
    const total = stats.totals.get(window) ?? 0;
    if (total === 0) continue;
    const counts = stats.counts.get(window) ?? new Map<string, number>();
    for (const themeId of allThemeIds(stats)) {
      const arr = history.get(themeId) ?? [];
      arr.push((counts.get(themeId) ?? 0) / total);
      history.set(themeId, arr);
    }
  }

  const findings: DeltaFinding[] = [];
  for (const themeId of new Set([...fromCounts.keys(), ...toCounts.keys()])) {
    const theme = store.getTheme(themeId);
    // An assignment can outlive its theme (deleted registry entry); reporting a
    // change to something nobody can open is worse than staying quiet about it.
    if (!theme) continue;
    if (theme.state === "muted") continue;

    const fromCount = fromCounts.get(themeId) ?? 0;
    const toCount = toCounts.get(themeId) ?? 0;
    const fromShare = fromTotal === 0 ? 0 : fromCount / fromTotal;
    const toShare = toTotal === 0 ? 0 : toCount / toTotal;
    const delta = toShare - fromShare;

    const sd = stddev(history.get(themeId) ?? []);
    const sigmas = sd > 0 ? Math.abs(delta) / sd : 0;
    const threshold = Math.max(sd * opts.sigma, minAbsDelta);
    const exceeded = Math.abs(delta) > threshold;

    let severity: DeltaSeverity = "info";
    if (exceeded) severity = "notable";
    if (exceeded && delta > 0 && fromCount === 0) severity = "new";
    if (exceeded && delta > 0 && (theme.state === "regressed" || theme.state === "resolved")) {
      severity = "regression";
    }

    findings.push({
      themeId,
      label: theme.label,
      state: theme.state,
      fromWindow,
      toWindow,
      fromShare,
      toShare,
      fromCount,
      toCount,
      delta,
      sigmas,
      severity,
    });
  }

  findings.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      Math.abs(b.delta) - Math.abs(a.delta) ||
      a.themeId.localeCompare(b.themeId),
  );

  return {
    facet,
    fromWindow,
    toWindow,
    fromTotal,
    toTotal,
    fromResidualShare: fromTotal === 0 ? 0 : (stats.residuals.get(fromWindow) ?? 0) / fromTotal,
    toResidualShare: toTotal === 0 ? 0 : (stats.residuals.get(toWindow) ?? 0) / toTotal,
    findings,
  };
}

export interface SeriesPoint {
  window: string;
  count: number;
  share: number;
}

export interface ThemeSeries {
  windows: string[];
  /** themeId -> one point per window, in window order, zeros included */
  byTheme: Map<string, SeriesPoint[]>;
  residual: SeriesPoint[];
}

/**
 * Per-window share history for every theme in a facet. Zeros are filled in
 * rather than omitted: a sparkline with a hole in it reads as "no data" when
 * the truth is "nothing happened", and those are different stories.
 */
export function themeSeries(store: SiftStore, facet: string): ThemeSeries {
  const stats = store.themeCountsByWindow(facet);
  const themeIds = [...allThemeIds(stats)].sort();

  const byTheme = new Map<string, SeriesPoint[]>();
  for (const themeId of themeIds) {
    byTheme.set(
      themeId,
      stats.windows.map((window) => {
        const total = stats.totals.get(window) ?? 0;
        const count = stats.counts.get(window)?.get(themeId) ?? 0;
        return { window, count, share: total === 0 ? 0 : count / total };
      }),
    );
  }

  const residual = stats.windows.map((window) => {
    const total = stats.totals.get(window) ?? 0;
    const count = stats.residuals.get(window) ?? 0;
    return { window, count, share: total === 0 ? 0 : count / total };
  });

  return { windows: stats.windows, byTheme, residual };
}

function allThemeIds(stats: { counts: Map<string, Map<string, number>> }): Set<string> {
  const ids = new Set<string>();
  for (const perWindow of stats.counts.values()) for (const id of perWindow.keys()) ids.add(id);
  return ids;
}

/** Sample standard deviation; fewer than two points means no variance estimate. */
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}
