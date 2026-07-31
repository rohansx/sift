import { DatabaseSync } from "node:sqlite";
import type { Assignment, FacetSummary, Theme, ThemeState, Trace } from "../types.ts";

/**
 * Single-file SQLite via node:sqlite (Node >= 22). No native deps, no infra,
 * no server — "local-first" has to mean a thing you can actually run locally.
 *
 * Embeddings are stored as JSON text. That is honest at this scale: brute-force
 * cosine over a few thousand vectors is microseconds, and sqlite-vec is the
 * documented upgrade path when a registry outgrows it.
 */

export const SCHEMA_VERSION = 2;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    version TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    text TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS facet_summaries (
    trace_id TEXT NOT NULL,
    facet TEXT NOT NULL,
    summary TEXT NOT NULL,
    embedding TEXT,
    PRIMARY KEY (trace_id, facet)
  );

  CREATE TABLE IF NOT EXISTS themes (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL DEFAULT '',
    facet TEXT NOT NULL,
    label TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'new',
    centroid TEXT NOT NULL,
    member_count INTEGER NOT NULL DEFAULT 0,
    exemplar_trace_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    first_window TEXT,
    last_seen_window TEXT,
    note TEXT
  );

  CREATE TABLE IF NOT EXISTS assignments (
    trace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT '',
    facet TEXT NOT NULL,
    theme_id TEXT,
    similarity REAL NOT NULL,
    window TEXT NOT NULL,
    PRIMARY KEY (trace_id, facet)
  );

  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

  CREATE INDEX IF NOT EXISTS idx_assignments_theme ON assignments(theme_id, window);
  CREATE INDEX IF NOT EXISTS idx_assignments_scope ON assignments(agent_id, facet, window);
  CREATE INDEX IF NOT EXISTS idx_traces_agent ON traces(agent_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_summaries_facet ON facet_summaries(facet);
  CREATE INDEX IF NOT EXISTS idx_themes_scope ON themes(agent_id, facet, state);
`;

export interface ListTracesOptions {
  agentId?: string;
  /** ISO timestamp; traces starting at or after it */
  since?: string;
  limit?: number;
}

export interface WindowCounts {
  /** ordered window tags */
  windows: string[];
  /** window -> themeId -> assignment count */
  counts: Map<string, Map<string, number>>;
  /** window -> total assignments (residuals included) */
  totals: Map<string, number>;
  /** window -> residual (unassigned) count */
  residuals: Map<string, number>;
}

export class SiftStore {
  readonly path: string;
  private db: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(SCHEMA);
    const found = this.getMeta("schema_version");
    if (found === undefined) {
      this.setMeta("schema_version", String(SCHEMA_VERSION));
      return;
    }
    const version = Number(found);
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `database ${this.path} was written by a newer version of sift (schema ${version}, this build understands ${SCHEMA_VERSION})`,
      );
    }
    if (version < 2) this.migrateToAgentScoping();
    if (version < SCHEMA_VERSION) this.setMeta("schema_version", String(SCHEMA_VERSION));
  }

  /**
   * v1 -> v2: themes and assignments became agent-scoped. The columns are added
   * by the CREATE TABLE above for new databases; for an existing one they may
   * already exist (sqlite has no IF NOT EXISTS for columns, so this tolerates
   * the duplicate) and are backfilled from each assignment's trace.
   */
  private migrateToAgentScoping(): void {
    for (const stmt of [
      "ALTER TABLE themes ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE assignments ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''",
    ]) {
      try {
        this.db.exec(stmt);
      } catch {
        // column already present: this database was created by the current schema
      }
    }
    this.db.exec(`
      UPDATE assignments SET agent_id = COALESCE(
        (SELECT t.agent_id FROM traces t WHERE t.id = assignments.trace_id), ''
      ) WHERE agent_id = '';
    `);
    this.db.exec(`
      UPDATE themes SET agent_id = COALESCE((
        SELECT a.agent_id FROM assignments a
        WHERE a.theme_id = themes.id AND a.agent_id != '' LIMIT 1
      ), '') WHERE agent_id = '';
    `);
  }

  schemaVersion(): number {
    return Number(this.getMeta("schema_version"));
  }

  /** Runs `fn` inside a transaction, rolling back if it throws. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /* ---------- traces ---------- */

  /** Ingestion is idempotent: re-reading the same export never duplicates. */
  insertTrace(t: Trace): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO traces (id, agent_id, version, started_at, ended_at, text, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.id, t.agentId, t.version ?? null, t.startedAt, t.endedAt ?? null, t.text, JSON.stringify(t.meta ?? {}));
    return Number(res.changes) > 0;
  }

  /** Returns how many traces were new. */
  insertTraces(traces: Trace[]): number {
    return this.transaction(() => {
      let n = 0;
      for (const t of traces) if (this.insertTrace(t)) n++;
      return n;
    });
  }

  getTrace(id: string): Trace | null {
    const r = this.db.prepare(`SELECT * FROM traces WHERE id = ?`).get(id) as Row | undefined;
    return r ? rowToTrace(r) : null;
  }

  countTraces(): number {
    return (this.db.prepare(`SELECT COUNT(*) c FROM traces`).get() as { c: number }).c;
  }

  listTraces(opts: ListTracesOptions = {}): Trace[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.agentId) {
      where.push("agent_id = ?");
      params.push(opts.agentId);
    }
    if (opts.since) {
      where.push("started_at >= ?");
      params.push(opts.since);
    }
    const sql =
      `SELECT * FROM traces ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at, id` +
      (opts.limit ? ` LIMIT ${Math.floor(opts.limit)}` : "");
    return (this.db.prepare(sql).all(...params) as Row[]).map(rowToTrace);
  }

  agentIds(): string[] {
    return (this.db.prepare(`SELECT DISTINCT agent_id a FROM traces ORDER BY a`).all() as Array<{ a: string }>).map(
      (r) => r.a,
    );
  }

  /**
   * Traces missing at least one of `facets`.
   *
   * Deliberately not "traces with no summaries at all": a summarize run that
   * dies halfway through a facet set would otherwise leave traces permanently
   * half-summarized and invisible to every later run.
   */
  tracesNeedingSummaries(
    facets: string[],
    opts: { limit?: number; since?: string; agentId?: string } = {},
  ): Trace[] {
    if (facets.length === 0) return [];
    const { sql, params } = pendingSummaryFilter(facets, opts);
    const paged = `
      SELECT t.* FROM traces t
      WHERE ${sql}
      ORDER BY t.started_at, t.id
      LIMIT ?`;
    return (this.db.prepare(paged).all(...params, Math.floor(opts.limit ?? 500)) as Row[]).map(rowToTrace);
  }

  /**
   * How many traces the query above would return if it were not paged — what a
   * capped summarize pass is leaving behind.
   *
   * Shares one predicate with the page itself, so "1000 done, 39,000 to go"
   * can never turn out to be arithmetic over two subtly different sets.
   */
  countTracesNeedingSummaries(facets: string[], opts: { since?: string; agentId?: string } = {}): number {
    if (facets.length === 0) return 0;
    const { sql, params } = pendingSummaryFilter(facets, opts);
    return (this.db.prepare(`SELECT COUNT(*) c FROM traces t WHERE ${sql}`).get(...params) as { c: number }).c;
  }

  /**
   * Traces this agent has for which the facet has no assignment row at all.
   *
   * Deliberately not "traces with no summary": a residual gets an assignment
   * row with a NULL theme, so "no row at all" is exactly the set that no share,
   * window, delta or gate in this tool can see. It also catches the later
   * stages — summarized but never embedded, embedded but never assigned —
   * which a summary-shaped question would call done.
   */
  countUncoveredTraces(agentId: string, facet: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) c FROM traces t
           WHERE t.agent_id = ?
             AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.trace_id = t.id AND a.facet = ?)`,
        )
        .get(agentId, facet) as { c: number }
    ).c;
  }

  /* ---------- summaries ---------- */

  insertSummary(s: FacetSummary): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO facet_summaries (trace_id, facet, summary, embedding) VALUES (?, ?, ?, ?)`)
      .run(s.traceId, s.facet, s.summary, s.embedding ? JSON.stringify(s.embedding) : null);
  }

  insertSummaries(summaries: FacetSummary[]): void {
    this.transaction(() => {
      for (const s of summaries) this.insertSummary(s);
    });
  }

  getSummary(traceId: string, facet: string): FacetSummary | null {
    const r = this.db
      .prepare(`SELECT * FROM facet_summaries WHERE trace_id = ? AND facet = ?`)
      .get(traceId, facet) as Row | undefined;
    return r ? rowToSummary(r) : null;
  }

  countSummaries(facet?: string): number {
    const sql = facet
      ? `SELECT COUNT(*) c FROM facet_summaries WHERE facet = ?`
      : `SELECT COUNT(*) c FROM facet_summaries`;
    const params = facet ? [facet] : [];
    return (this.db.prepare(sql).get(...params) as { c: number }).c;
  }

  summariesNeedingEmbeddings(limit = 1000): FacetSummary[] {
    return (
      this.db
        .prepare(`SELECT * FROM facet_summaries WHERE embedding IS NULL ORDER BY trace_id, facet LIMIT ?`)
        .all(Math.floor(limit)) as Row[]
    ).map(rowToSummary);
  }

  /**
   * Embedded summaries for one facet. `unassignedOnly` means the residual
   * pile plus anything never assigned — exactly the pool re-discovery runs on.
   */
  summariesForFacet(
    facet: string,
    opts: { unassignedOnly?: boolean; agentId?: string } = {},
  ): FacetSummary[] {
    const agentClause = opts.agentId ? "AND t.agent_id = ?" : "";
    const params: string[] = [facet];
    if (opts.agentId) params.push(opts.agentId);

    const sql = opts.unassignedOnly
      ? `SELECT fs.* FROM facet_summaries fs
         JOIN traces t ON t.id = fs.trace_id
         LEFT JOIN assignments a ON a.trace_id = fs.trace_id AND a.facet = fs.facet
         WHERE fs.facet = ? ${agentClause} AND fs.embedding IS NOT NULL AND (a.trace_id IS NULL OR a.theme_id IS NULL)
         ORDER BY fs.trace_id`
      : `SELECT fs.* FROM facet_summaries fs
         JOIN traces t ON t.id = fs.trace_id
         WHERE fs.facet = ? ${agentClause} AND fs.embedding IS NOT NULL
         ORDER BY fs.trace_id`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(rowToSummary);
  }

  facetsWithSummaries(): string[] {
    return (
      this.db.prepare(`SELECT DISTINCT facet f FROM facet_summaries ORDER BY f`).all() as Array<{ f: string }>
    ).map((r) => r.f);
  }

  /* ---------- themes ---------- */

  /**
   * Monotonic theme IDs. The counter lives in `meta` and is never decremented,
   * so a deleted theme's ID is retired forever — SIFT-14 in last month's
   * incident notes must never come to mean something else.
   */
  nextThemeId(prefix = "SIFT"): string {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT v FROM meta WHERE k = 'theme_seq'`).get() as { v: string } | undefined;
      const next = (row ? parseInt(row.v, 10) : 0) + 1;
      this.db.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('theme_seq', ?)`).run(String(next));
      return `${prefix}-${next}`;
    });
  }

  insertTheme(t: Theme): void {
    this.db
      .prepare(
        `INSERT INTO themes (id, agent_id, facet, label, description, state, centroid, member_count,
                             exemplar_trace_ids, created_at, updated_at, first_window, last_seen_window, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id,
        t.agentId,
        t.facet,
        t.label,
        t.description,
        t.state,
        JSON.stringify(t.centroid),
        t.memberCount,
        JSON.stringify(t.exemplarTraceIds),
        t.createdAt,
        t.updatedAt,
        t.firstWindow ?? null,
        t.lastSeenWindow ?? null,
        t.note ?? null,
      );
  }

  updateTheme(t: Theme): void {
    this.db
      .prepare(
        `UPDATE themes SET label = ?, description = ?, state = ?, centroid = ?, member_count = ?,
                           exemplar_trace_ids = ?, updated_at = ?, first_window = ?, last_seen_window = ?, note = ?
         WHERE id = ?`,
      )
      .run(
        t.label,
        t.description,
        t.state,
        JSON.stringify(t.centroid),
        t.memberCount,
        JSON.stringify(t.exemplarTraceIds),
        t.updatedAt,
        t.firstWindow ?? null,
        t.lastSeenWindow ?? null,
        t.note ?? null,
        t.id,
      );
  }

  deleteTheme(id: string): void {
    this.transaction(() => {
      this.db.prepare(`DELETE FROM themes WHERE id = ?`).run(id);
      this.db.prepare(`UPDATE assignments SET theme_id = NULL WHERE theme_id = ?`).run(id);
    });
  }

  getTheme(id: string): Theme | null {
    const r = this.db.prepare(`SELECT * FROM themes WHERE id = ?`).get(id) as Row | undefined;
    return r ? rowToTheme(r) : null;
  }

  /** Themes for one agent's facet. Scope is not optional: mixing agents is a bug. */
  themesForFacet(agentId: string, facet: string, states?: ThemeState[]): Theme[] {
    const all = (
      this.db.prepare(`SELECT * FROM themes WHERE agent_id = ? AND facet = ? ORDER BY id`).all(agentId, facet) as Row[]
    ).map(rowToTheme);
    return states ? all.filter((t) => states.includes(t.state)) : all;
  }

  /** Every theme in the database, biggest first. Optionally narrowed to one agent. */
  allThemes(agentId?: string): Theme[] {
    const sql = agentId
      ? `SELECT * FROM themes WHERE agent_id = ? ORDER BY member_count DESC, id`
      : `SELECT * FROM themes ORDER BY member_count DESC, id`;
    return (this.db.prepare(sql).all(...(agentId ? [agentId] : [])) as Row[]).map(rowToTheme);
  }

  /* ---------- assignments & window stats ---------- */

  insertAssignment(a: Assignment): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO assignments (trace_id, agent_id, facet, theme_id, similarity, window)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(a.traceId, a.agentId, a.facet, a.themeId, a.similarity, a.window);
  }

  countAssignments(facet?: string, agentId?: string): number {
    const where: string[] = [];
    const params: string[] = [];
    if (facet) {
      where.push("facet = ?");
      params.push(facet);
    }
    if (agentId) {
      where.push("agent_id = ?");
      params.push(agentId);
    }
    const sql = `SELECT COUNT(*) c FROM assignments${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
    return (this.db.prepare(sql).get(...params) as { c: number }).c;
  }

  /** Fraction of a window's assignments that landed in the residual pile. */
  residualShare(agentId: string, facet: string, window: string): number {
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) c FROM assignments WHERE agent_id = ? AND facet = ? AND window = ?`)
        .get(agentId, facet, window) as { c: number }
    ).c;
    if (total === 0) return 0;
    const residual = (
      this.db
        .prepare(
          `SELECT COUNT(*) c FROM assignments WHERE agent_id = ? AND facet = ? AND window = ? AND theme_id IS NULL`,
        )
        .get(agentId, facet, window) as { c: number }
    ).c;
    return residual / total;
  }

  /**
   * Per-window counts for one facet. Totals include residuals on purpose:
   * when discovery is behind, theme shares should visibly fail to add to 1
   * rather than quietly renormalizing the gap away.
   */
  themeCountsByWindow(agentId: string, facet: string): WindowCounts {
    const rows = this.db
      .prepare(
        `SELECT window, theme_id, COUNT(*) c FROM assignments
         WHERE agent_id = ? AND facet = ? GROUP BY window, theme_id ORDER BY window`,
      )
      .all(agentId, facet) as Array<{ window: string; theme_id: string | null; c: number }>;

    const counts = new Map<string, Map<string, number>>();
    const totals = new Map<string, number>();
    const residuals = new Map<string, number>();

    for (const r of rows) {
      totals.set(r.window, (totals.get(r.window) ?? 0) + r.c);
      if (!counts.has(r.window)) counts.set(r.window, new Map());
      if (!residuals.has(r.window)) residuals.set(r.window, 0);
      if (r.theme_id === null) residuals.set(r.window, residuals.get(r.window)! + r.c);
      else counts.get(r.window)!.set(r.theme_id, r.c);
    }
    return { windows: [...totals.keys()].sort(), counts, totals, residuals };
  }

  windowsForFacet(agentId: string, facet: string): string[] {
    return (
      this.db
        .prepare(`SELECT DISTINCT window w FROM assignments WHERE agent_id = ? AND facet = ? ORDER BY w`)
        .all(agentId, facet) as Array<{ w: string }>
    ).map((r) => r.w);
  }

  themeCountInWindow(themeId: string, facet: string, window: string): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) c FROM assignments WHERE theme_id = ? AND facet = ? AND window = ?`)
        .get(themeId, facet, window) as { c: number }
    ).c;
  }

  tracesForTheme(themeId: string, limit = 50): Trace[] {
    return (
      this.db
        .prepare(
          `SELECT t.* FROM traces t JOIN assignments a ON a.trace_id = t.id
           WHERE a.theme_id = ? ORDER BY a.similarity DESC, t.id LIMIT ?`,
        )
        .all(themeId, Math.floor(limit)) as Row[]
    ).map(rowToTrace);
  }

  /* ---------- meta ---------- */

  getMeta(key: string): string | undefined {
    const r = this.db.prepare(`SELECT v FROM meta WHERE k = ?`).get(key) as { v: string } | undefined;
    return r?.v;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`).run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

type Row = Record<string, unknown>;

/** The "still needs summarizing" predicate, shared by the page and its count. */
function pendingSummaryFilter(
  facets: string[],
  opts: { since?: string; agentId?: string },
): { sql: string; params: Array<string | number> } {
  const placeholders = facets.map(() => "?").join(", ");
  const params: Array<string | number> = [...facets, facets.length];
  let sql = `(
        SELECT COUNT(*) FROM facet_summaries fs
        WHERE fs.trace_id = t.id AND fs.facet IN (${placeholders})
      ) < ?`;
  if (opts.since) {
    sql += " AND t.started_at >= ?";
    params.push(opts.since);
  }
  if (opts.agentId) {
    sql += " AND t.agent_id = ?";
    params.push(opts.agentId);
  }
  return { sql, params };
}

function rowToTrace(r: Row): Trace {
  const t: Trace = {
    id: r.id as string,
    agentId: r.agent_id as string,
    startedAt: r.started_at as string,
    text: r.text as string,
    meta: JSON.parse((r.meta as string) ?? "{}") as Record<string, unknown>,
  };
  if (r.version != null) t.version = r.version as string;
  if (r.ended_at != null) t.endedAt = r.ended_at as string;
  return t;
}

function rowToSummary(r: Row): FacetSummary {
  const s: FacetSummary = {
    traceId: r.trace_id as string,
    facet: r.facet as string,
    summary: r.summary as string,
  };
  if (r.embedding != null) s.embedding = JSON.parse(r.embedding as string) as number[];
  return s;
}

function rowToTheme(r: Row): Theme {
  const t: Theme = {
    id: r.id as string,
    agentId: (r.agent_id as string) ?? "",
    facet: r.facet as string,
    label: r.label as string,
    description: r.description as string,
    state: r.state as ThemeState,
    centroid: JSON.parse(r.centroid as string) as number[],
    memberCount: r.member_count as number,
    exemplarTraceIds: JSON.parse(r.exemplar_trace_ids as string) as string[],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
  if (r.first_window != null) t.firstWindow = r.first_window as string;
  if (r.last_seen_window != null) t.lastSeenWindow = r.last_seen_window as string;
  if (r.note != null) t.note = r.note as string;
  return t;
}
