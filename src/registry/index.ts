import type { Clock, FacetSummary, Labeler, Theme, ThemeState } from "../types.ts";
import { systemClock } from "../types.ts";
import type { SiftConfig } from "../config.ts";
import type { SiftStore } from "../store/db.ts";
import { cosine, nearest, updateCentroid } from "../cluster/vectors.ts";
import { discoverClusters } from "../cluster/bootstrap.ts";
import { windowForTrace } from "../window.ts";

/**
 * The theme registry — the part Mastra doesn't have (OVERVIEW.md §3.1–3.2).
 *
 * Steady state is classification, not clustering. Each new summary is assigned
 * to the nearest existing theme centroid if similarity clears the threshold;
 * otherwise it lands in the residual pile. Discovery re-runs only on residuals,
 * only past a threshold, and only ever *adds* themes. Existing IDs, labels and
 * history never churn.
 *
 * That stability is not a nice-to-have. It is the difference between a chart
 * and an issue tracker: you cannot say "SIFT-14 regressed after v1.3" about a
 * cluster that gets renamed and renumbered on every run.
 */

export interface StateTransition {
  themeId: string;
  from: ThemeState;
  to: ThemeState;
}

export interface AssignResult {
  traceId: string;
  facet: string;
  /** null means residual: nothing in the registry was close enough */
  themeId: string | null;
  similarity: number;
  window: string;
  transition?: StateTransition;
}

export interface AssignPendingResult {
  facet: string;
  assigned: number;
  residual: number;
  transitions: StateTransition[];
}

export interface AssignOptions {
  /** observability hook: called with the number of centroid comparisons made */
  onCompare?: (comparisons: number) => void;
}

export interface RegistryDeps {
  labeler: Labeler;
  clock?: Clock;
}

export class ThemeRegistry {
  private store: SiftStore;
  private cfg: SiftConfig;
  private labeler: Labeler;
  private clock: Clock;

  constructor(store: SiftStore, cfg: SiftConfig, deps: RegistryDeps) {
    this.store = store;
    this.cfg = cfg;
    this.labeler = deps.labeler;
    this.clock = deps.clock ?? systemClock;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  /* ---------- assignment ---------- */

  /**
   * Assign one embedded summary to a theme, or to the residual pile.
   *
   * Every theme is a candidate, including resolved and muted ones: a resolved
   * theme picking up traffic again is precisely the signal worth paging on, and
   * it can only be detected by still comparing against it.
   */
  assign(summary: FacetSummary, window: string, opts: AssignOptions = {}): AssignResult {
    const embedding = summary.embedding;
    if (!embedding) {
      throw new Error(`summary ${summary.traceId}/${summary.facet} has no embedding; embed before assigning`);
    }

    const themes = this.store.themesForFacet(summary.facet);
    opts.onCompare?.(themes.length);
    const hit = nearest(embedding, themes, (t) => t.centroid);
    const similarity = hit?.similarity ?? 0;

    if (!hit || similarity < this.cfg.assignThreshold) {
      this.store.insertAssignment({ traceId: summary.traceId, facet: summary.facet, themeId: null, similarity, window });
      return { traceId: summary.traceId, facet: summary.facet, themeId: null, similarity, window };
    }

    const theme = hit.item;
    const from = theme.state;

    theme.centroid = updateCentroid(theme.centroid, theme.memberCount, embedding);
    theme.memberCount += 1;
    theme.lastSeenWindow = window;
    if (!theme.firstWindow || window < theme.firstWindow) theme.firstWindow = window;
    theme.updatedAt = this.now();
    theme.state = nextStateOnAssignment(from, theme.memberCount, this.cfg.activateAfter);
    if (theme.exemplarTraceIds.length < this.cfg.maxExemplars) {
      theme.exemplarTraceIds = [...theme.exemplarTraceIds, summary.traceId];
    }

    this.store.transaction(() => {
      this.store.updateTheme(theme);
      this.store.insertAssignment({
        traceId: summary.traceId,
        facet: summary.facet,
        themeId: theme.id,
        similarity,
        window,
      });
    });

    const result: AssignResult = {
      traceId: summary.traceId,
      facet: summary.facet,
      themeId: theme.id,
      similarity,
      window,
    };
    if (theme.state !== from) result.transition = { themeId: theme.id, from, to: theme.state };
    return result;
  }

  /**
   * Assign everything unassigned for a facet. Each trace's window comes from
   * the trace itself (release tag, else its date) rather than from a flag, so
   * a late backfill still lands in the window it belongs to.
   */
  assignPending(facet: string, opts: AssignOptions = {}): AssignPendingResult {
    const pending = this.store.summariesForFacet(facet, { unassignedOnly: true });
    const transitions: StateTransition[] = [];
    let assigned = 0;
    let residual = 0;

    for (const summary of pending) {
      const trace = this.store.getTrace(summary.traceId);
      if (!trace) continue;
      const result = this.assign(summary, windowForTrace(trace), opts);
      if (result.themeId) assigned++;
      else residual++;
      if (result.transition) transitions.push(result.transition);
    }

    for (const themeId of new Set(transitions.map((t) => t.themeId))) this.refreshExemplars(themeId);
    return { facet, assigned, residual, transitions };
  }

  /* ---------- lifecycle ---------- */

  resolve(themeId: string, note?: string): Theme {
    return this.setState(themeId, "resolved", note);
  }

  mute(themeId: string, note?: string): Theme {
    return this.setState(themeId, "muted", note);
  }

  /** Back to active, note cleared: the theme is under investigation again. */
  reopen(themeId: string): Theme {
    return this.setState(themeId, "active", undefined, { clearNote: true });
  }

  /** Change the words, keep the identity. Labels are display; the ID is the contract. */
  relabel(themeId: string, label: string, description?: string): Theme {
    const theme = this.requireTheme(themeId);
    theme.label = label;
    if (description !== undefined) theme.description = description;
    theme.updatedAt = this.now();
    this.store.updateTheme(theme);
    return theme;
  }

  private setState(themeId: string, state: ThemeState, note?: string, opts: { clearNote?: boolean } = {}): Theme {
    const theme = this.requireTheme(themeId);
    theme.state = state;
    theme.updatedAt = this.now();
    if (opts.clearNote) delete theme.note;
    else if (note !== undefined) theme.note = note;
    this.store.updateTheme(theme);
    return theme;
  }

  private requireTheme(themeId: string): Theme {
    const theme = this.store.getTheme(themeId);
    if (!theme) throw new Error(`no such theme: ${themeId}`);
    return theme;
  }

  /**
   * Resolve themes that have gone quiet for K consecutive windows.
   *
   * Optional (K = 0 disables it) because auto-resolving is a judgement call:
   * it keeps the issues list honest, but a theme that resolves itself and later
   * regresses will page someone. Muted and already-resolved themes are skipped.
   */
  sweepAutoResolve(facet: string): StateTransition[] {
    const k = this.cfg.autoResolveAfterEmptyWindows;
    if (k <= 0) return [];

    const windows = this.store.windowsForFacet(facet);
    if (windows.length < k + 1) return []; // not enough history to judge silence
    const recent = windows.slice(-k);

    const transitions: StateTransition[] = [];
    for (const theme of this.store.themesForFacet(facet, ["new", "active", "regressed"])) {
      const seen = recent.some((w) => this.store.themeCountInWindow(theme.id, facet, w) > 0);
      if (seen) continue;
      const from = theme.state;
      theme.state = "resolved";
      theme.note = `auto-resolved: no assignments in the last ${k} window${k === 1 ? "" : "s"}`;
      theme.updatedAt = this.now();
      this.store.updateTheme(theme);
      transitions.push({ themeId: theme.id, from, to: "resolved" });
    }
    return transitions;
  }

  /* ---------- discovery ---------- */

  /** Is the residual pile large enough to be worth a discovery pass? */
  needsRediscovery(facet: string, window: string): boolean {
    return this.store.residualShare(facet, window) > this.cfg.rediscoverResidualShare;
  }

  /**
   * Cluster the residual pile and turn dense groups into new themes.
   *
   * At bootstrap the residual pile is simply everything, so this is also the
   * bootstrap path — one code path, no "is this the first run" branch to get
   * wrong. Existing themes are never read, re-fitted or renamed here.
   */
  async discover(facet: string, opts: { minClusterSize?: number } = {}): Promise<Theme[]> {
    const pool = this.store.summariesForFacet(facet, { unassignedOnly: true });
    const minClusterSize = opts.minClusterSize ?? this.cfg.minClusterSize;
    if (pool.length < minClusterSize) return [];

    const { clusters, noiseIndices } = discoverClusters(
      pool.map((s) => s.embedding!),
      { minClusterSize, mergeThreshold: this.cfg.mergeThreshold },
    );

    const created: Theme[] = [];
    for (const cluster of clusters) {
      const members = cluster.memberIndices.map((i) => pool[i]!);
      const { label, description } = await this.labeler.label(facet, members.map((m) => m.summary));

      const ranked = members
        .map((m) => ({ member: m, similarity: cosine(m.embedding!, cluster.centroid) }))
        .sort((a, b) => b.similarity - a.similarity || a.member.traceId.localeCompare(b.member.traceId));

      const windows = members
        .map((m) => this.store.getTrace(m.traceId))
        .filter((t): t is NonNullable<typeof t> => t !== null)
        .map((t) => windowForTrace(t))
        .sort();

      const now = this.now();
      const theme: Theme = {
        id: this.store.nextThemeId(),
        facet,
        label,
        description,
        // A theme discovered at bootstrap out of 340 traces is not "new" — it
        // is the bulk of the traffic. The activation rule has to apply here too,
        // or every theme the first run finds is permanently mislabelled.
        state: members.length >= this.cfg.activateAfter ? "active" : "new",
        centroid: cluster.centroid,
        memberCount: members.length,
        exemplarTraceIds: ranked.slice(0, this.cfg.maxExemplars).map((r) => r.member.traceId),
        createdAt: now,
        updatedAt: now,
      };
      const firstWindow = windows[0];
      const lastWindow = windows[windows.length - 1];
      if (firstWindow) theme.firstWindow = firstWindow;
      if (lastWindow) theme.lastSeenWindow = lastWindow;

      this.store.transaction(() => {
        this.store.insertTheme(theme);
        for (const { member, similarity } of ranked) {
          const trace = this.store.getTrace(member.traceId);
          this.store.insertAssignment({
            traceId: member.traceId,
            facet,
            themeId: theme.id,
            similarity,
            window: trace ? windowForTrace(trace) : (lastWindow ?? now.slice(0, 10)),
          });
        }
      });
      created.push(theme);
    }

    // Noise is written back as residual rows rather than dropped: an unexplained
    // trace still belongs in the denominator, or the residual share lies.
    this.store.transaction(() => {
      for (const i of noiseIndices) {
        const summary = pool[i]!;
        const trace = this.store.getTrace(summary.traceId);
        if (!trace) continue;
        this.store.insertAssignment({
          traceId: summary.traceId,
          facet,
          themeId: null,
          similarity: bestSimilarity(summary.embedding!, created),
          window: windowForTrace(trace),
        });
      }
    });

    return created;
  }

  /* ---------- exemplars ---------- */

  /**
   * Recompute a theme's exemplars from the assignment record — the traces that
   * matched it most strongly. Cheap enough to run after a batch, and it keeps
   * eval export seeded with the clearest examples rather than the first ones.
   */
  refreshExemplars(themeId: string): Theme {
    const theme = this.requireTheme(themeId);
    const traces = this.store.tracesForTheme(themeId, this.cfg.maxExemplars);
    if (traces.length === 0) return theme;
    theme.exemplarTraceIds = traces.map((t) => t.id);
    this.store.updateTheme(theme);
    return theme;
  }
}

/**
 * The state machine, in one place.
 *
 *   new ──(activateAfter assignments)──> active
 *   resolved ──(any assignment)──> regressed     <- the alert-worthy one
 *   muted stays muted; regressed stays regressed until a human resolves it
 */
function nextStateOnAssignment(state: ThemeState, memberCount: number, activateAfter: number): ThemeState {
  switch (state) {
    case "resolved":
      return "regressed";
    case "new":
      return memberCount >= activateAfter ? "active" : "new";
    case "active":
    case "regressed":
    case "muted":
      return state;
  }
}

function bestSimilarity(embedding: number[], themes: Theme[]): number {
  const hit = nearest(embedding, themes, (t) => t.centroid);
  return hit?.similarity ?? 0;
}
