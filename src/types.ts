/**
 * Core domain types.
 *
 * The pipeline is: Trace -> FacetSummary -> embedding -> Theme assignment.
 * Themes live in a persistent registry with stable IDs and a lifecycle, which
 * is the whole point of sift (docs/OVERVIEW.md §3).
 */

/** A normalized agent trace, whatever its source (OTLP, Mastra storage, JSONL). */
export interface Trace {
  id: string;
  agentId: string;
  /** release/version tag if the emitter provides one; powers deltas across deploys */
  version?: string;
  startedAt: string; // ISO 8601
  endedAt?: string;
  /** flattened, readable rendering of the span tree: messages, tool calls, errors */
  text: string;
  /** structured extras kept around for eval export and drill-down */
  meta: Record<string, unknown>;
}

/** A facet is one dimension along which every trace gets a one-line summary. */
export interface FacetDef {
  /** kebab-case; used as a storage key, so it must stay stable */
  name: string;
  /** instruction handed to the summarizer for this facet */
  instruction: string;
}

export interface FacetSummary {
  traceId: string;
  facet: string;
  /** the one-line summary. This is what gets embedded — never the raw trace. */
  summary: string;
  embedding?: number[];
}

/**
 * Theme lifecycle, borrowed wholesale from Sentry issues:
 *
 *   new ──(N assignments or review)──> active ──(manual/auto)──> resolved
 *                                        │                          │
 *                                        │                    (assignments resume)
 *                                        │                          ↓
 *                                        └──────────────────────> regressed
 *
 * Anything can be muted (known and accepted). Muted themes still accept
 * assignments — they just never raise alerts.
 */
export type ThemeState = "new" | "active" | "regressed" | "resolved" | "muted";

export const THEME_STATES: readonly ThemeState[] = ["new", "active", "regressed", "resolved", "muted"];

/** A theme is a Sentry-style issue: stable identity, lifecycle, history. */
export interface Theme {
  /** stable, human-pasteable, never reused: "SIFT-14" */
  id: string;
  facet: string;
  label: string;
  description: string;
  state: ThemeState;
  /** running-mean centroid of member embeddings */
  centroid: number[];
  memberCount: number;
  /** trace IDs nearest the centroid; used for display and eval export */
  exemplarTraceIds: string[];
  createdAt: string;
  updatedAt: string;
  /** window tag of the most recent assignment; drives auto-resolve */
  lastSeenWindow?: string;
  /** free-form note set when a human resolves/mutes a theme */
  note?: string;
}

export interface Assignment {
  traceId: string;
  facet: string;
  /** null = residual pile: nothing in the registry was close enough */
  themeId: string | null;
  similarity: number;
  /** version tag when the emitter provides one, else the trace's date */
  window: string;
}

/** One theme's share of one window; the delta engine diffs these. */
export interface ThemeWindowStat {
  themeId: string;
  window: string;
  count: number;
  /** count / total assignments in that window for that facet */
  share: number;
}

export type DeltaSeverity = "info" | "notable" | "regression" | "new";

export interface DeltaFinding {
  themeId: string;
  label: string;
  state: ThemeState;
  fromWindow: string;
  toWindow: string;
  fromShare: number;
  toShare: number;
  fromCount: number;
  toCount: number;
  /** absolute change in share (toShare - fromShare) */
  delta: number;
  /** |delta| expressed in standard deviations of the theme's own history */
  sigmas: number;
  severity: DeltaSeverity;
}

/* ---------- provider interfaces (keep the pipeline vendor-neutral) ---------- */

export interface Summarizer {
  summarize(trace: Trace, facets: FacetDef[]): Promise<FacetSummary[]>;
}

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

/** Names a discovered cluster. Separate from Summarizer: different prompt, different call. */
export interface Labeler {
  label(facet: string, memberSummaries: string[]): Promise<{ label: string; description: string }>;
}

/** Injectable clock. Every timestamp in sift goes through one of these. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();
