import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SCHEMA_VERSION, SiftStore, type PendingSpan } from "../src/store/db.ts";
import { withTempDir, withTempStore } from "../src/testing/temp.ts";
import type { Theme, Trace } from "../src/types.ts";

function trace(over: Partial<Trace> = {}): Trace {
  return {
    id: "t1",
    agentId: "support-bot",
    version: "v1.2",
    startedAt: "2026-07-01T10:00:00.000Z",
    endedAt: "2026-07-01T10:00:05.000Z",
    text: "## chat\ninput: hello\noutput: hi",
    meta: { spanCount: 2 },
    ...over,
  };
}

function theme(over: Partial<Theme> = {}): Theme {
  return {
    id: "SIFT-1",
    agentId: "support-bot",
    facet: "behavior",
    label: "tool retry loop on search_kb",
    description: "agent retries the search tool after a timeout",
    state: "new",
    centroid: [1, 0, 0],
    memberCount: 3,
    exemplarTraceIds: ["t1"],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

describe("schema", () => {
  test("migrating is idempotent and records the schema version", () => {
    withTempDir((dir) => {
      const path = join(dir, "s.db");
      const a = new SiftStore(path);
      assert.equal(a.schemaVersion(), SCHEMA_VERSION);
      a.insertTrace(trace());
      a.close();

      // reopening runs migrate() again; it must not clobber data
      const b = new SiftStore(path);
      assert.equal(b.schemaVersion(), SCHEMA_VERSION);
      assert.equal(b.countTraces(), 1);
      b.close();
    });
  });

  /**
   * v3 added `pending_spans` and nothing else, so it has no migration function —
   * the CREATE TABLE IF NOT EXISTS covers it. This is the test that says so.
   */
  test("a v2 database opens and gains the staging table", () => {
    withTempDir((dir) => {
      const path = join(dir, "s.db");
      const v3 = new SiftStore(path);
      v3.insertTrace(trace());
      v3.close();

      // wind it back to exactly what sift 2 left behind
      const raw = new DatabaseSync(path);
      raw.exec("DROP TABLE pending_spans");
      raw.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema_version', '2')");
      raw.close();

      const reopened = new SiftStore(path);
      assert.equal(reopened.schemaVersion(), 3);
      assert.equal(reopened.countTraces(), 1);
      assert.equal(reopened.countPendingSpans(), 0);
      reopened.close();
    });
  });

  test("refuses to open a database written by a newer sift", () => {
    withTempDir((dir) => {
      const path = join(dir, "s.db");
      const a = new SiftStore(path);
      a.setMeta("schema_version", String(SCHEMA_VERSION + 5));
      a.close();
      assert.throws(() => new SiftStore(path), /newer version of sift/i);
    });
  });

  test("an in-memory store works, for tests that do not need a file", () => {
    const s = new SiftStore(":memory:");
    s.insertTrace(trace());
    assert.equal(s.countTraces(), 1);
    s.close();
  });
});

describe("traces", () => {
  test("round-trips every field including meta", () => {
    withTempStore((store) => {
      store.insertTrace(trace({ meta: { spanCount: 7, tools: ["search_kb"] } }));
      const got = store.getTrace("t1");
      assert.deepEqual(got, trace({ meta: { spanCount: 7, tools: ["search_kb"] } }));
    });
  });

  test("a trace with no version or end time round-trips as undefined, not null", () => {
    withTempStore((store) => {
      store.insertTrace(trace({ id: "t2", version: undefined, endedAt: undefined }));
      const got = store.getTrace("t2")!;
      assert.equal(got.version, undefined);
      assert.equal(got.endedAt, undefined);
    });
  });

  test("re-ingesting the same trace is a no-op, so ingestion is safe to rerun", () => {
    withTempStore((store) => {
      store.insertTrace(trace({ text: "original" }));
      store.insertTrace(trace({ text: "different text, same id" }));
      assert.equal(store.countTraces(), 1);
      assert.equal(store.getTrace("t1")!.text, "original");
    });
  });

  test("bulk insert reports how many were actually new", () => {
    withTempStore((store) => {
      assert.equal(store.insertTraces([trace({ id: "a" }), trace({ id: "b" })]), 2);
      assert.equal(store.insertTraces([trace({ id: "b" }), trace({ id: "c" })]), 1);
      assert.equal(store.countTraces(), 3);
    });
  });

  test("unknown trace id is null, not a throw", () => {
    withTempStore((store) => assert.equal(store.getTrace("nope"), null));
  });

  test("lists traces filtered by agent and start time", () => {
    withTempStore((store) => {
      store.insertTraces([
        trace({ id: "a", agentId: "bot-1", startedAt: "2026-07-01T00:00:00.000Z" }),
        trace({ id: "b", agentId: "bot-1", startedAt: "2026-07-05T00:00:00.000Z" }),
        trace({ id: "c", agentId: "bot-2", startedAt: "2026-07-05T00:00:00.000Z" }),
      ]);
      assert.deepEqual(store.listTraces({ agentId: "bot-1" }).map((t) => t.id), ["a", "b"]);
      assert.deepEqual(store.listTraces({ since: "2026-07-03T00:00:00.000Z" }).map((t) => t.id), ["b", "c"]);
      assert.deepEqual(store.listTraces({ limit: 1 }).map((t) => t.id), ["a"]);
    });
  });

  test("knows which agents it holds", () => {
    withTempStore((store) => {
      store.insertTraces([trace({ id: "a", agentId: "x" }), trace({ id: "b", agentId: "y" }), trace({ id: "c", agentId: "x" })]);
      assert.deepEqual(store.agentIds(), ["x", "y"]);
    });
  });
});

describe("staged spans", () => {
  const staged = (over: Partial<PendingSpan> = {}): PendingSpan => ({
    traceId: "tr-1",
    spanKey: "span-1",
    receivedAt: "2026-07-01T10:00:00.000Z",
    span: JSON.stringify({ traceId: "tr-1", spanId: "span-1", startMs: 0, attributes: {}, events: [] }),
    ...over,
  });

  test("staging the same span twice stores it once", () => {
    withTempStore((store) => {
      assert.equal(store.stagePendingSpans([staged(), staged({ spanKey: "span-2" })]), 2);
      // what an exporter retry after a timeout looks like
      assert.equal(store.stagePendingSpans([staged(), staged({ spanKey: "span-2" })]), 0);
      assert.equal(store.countPendingSpans(), 2);
      assert.equal(store.pendingSpansFor("tr-1").length, 2);
    });
  });

  test("a trace settles only once its newest span is older than the cutoff", () => {
    withTempStore((store) => {
      store.stagePendingSpans([
        staged({ receivedAt: "2026-07-01T10:00:00.000Z" }),
        staged({ spanKey: "span-2", receivedAt: "2026-07-01T10:00:30.000Z" }),
        staged({ traceId: "tr-2", receivedAt: "2026-07-01T09:00:00.000Z" }),
      ]);
      assert.deepEqual(store.settledTraceIds("2026-07-01T10:00:10.000Z"), ["tr-2"], "tr-1 is still receiving spans");
      assert.deepEqual(store.settledTraceIds("2026-07-01T10:01:00.000Z"), ["tr-1", "tr-2"]);

      store.deletePendingSpans("tr-1");
      assert.equal(store.countPendingSpans(), 1);
    });
  });
});

describe("facet summaries", () => {
  test("round-trips with and without an embedding", () => {
    withTempStore((store) => {
      store.insertTrace(trace());
      store.insertSummary({ traceId: "t1", facet: "behavior", summary: "retries search" });
      store.insertSummary({ traceId: "t1", facet: "goal", summary: "find a doc", embedding: [0.5, 0.25] });

      const noEmb = store.getSummary("t1", "behavior")!;
      assert.equal(noEmb.summary, "retries search");
      assert.equal(noEmb.embedding, undefined);

      const withEmb = store.getSummary("t1", "goal")!;
      assert.deepEqual(withEmb.embedding, [0.5, 0.25]);
    });
  });

  test("re-summarizing a trace/facet replaces the old summary", () => {
    withTempStore((store) => {
      store.insertTrace(trace());
      store.insertSummary({ traceId: "t1", facet: "behavior", summary: "first" });
      store.insertSummary({ traceId: "t1", facet: "behavior", summary: "second", embedding: [1] });
      assert.equal(store.getSummary("t1", "behavior")!.summary, "second");
      assert.equal(store.countSummaries("behavior"), 1);
    });
  });

  test("a partially summarized trace still counts as pending", () => {
    // The prototype's "LEFT JOIN on any summary" logic silently skipped traces
    // whose summarize call died halfway through the facet set.
    withTempStore((store) => {
      store.insertTraces([trace({ id: "full" }), trace({ id: "partial" }), trace({ id: "none" })]);
      for (const f of ["goal", "outcome"]) {
        store.insertSummary({ traceId: "full", facet: f, summary: "x" });
      }
      store.insertSummary({ traceId: "partial", facet: "goal", summary: "x" });

      const pending = store.tracesNeedingSummaries(["goal", "outcome"]).map((t) => t.id);
      assert.deepEqual(pending.sort(), ["none", "partial"]);
    });
  });

  test("counts what a paged summarize pass is leaving behind", () => {
    // The count and the page must answer the same question, or "1000 done,
    // 200 left" is arithmetic over two different sets.
    withTempStore((store) => {
      store.insertTraces(["a", "b", "c"].map((id) => trace({ id })));
      store.insertSummary({ traceId: "a", facet: "goal", summary: "x" });

      assert.equal(store.countTracesNeedingSummaries(["goal"]), 2);
      assert.equal(store.tracesNeedingSummaries(["goal"], { limit: 1 }).length, 1);
      assert.equal(store.countTracesNeedingSummaries(["goal"], { agentId: "someone-else" }), 0);
      assert.equal(store.countTracesNeedingSummaries([]), 0);
    });
  });

  test("the cost estimate measures the same set the count counts", () => {
    // The shared-predicate claim, asserted rather than commented: a cost
    // estimate that quietly disagrees with "N still pending" about which traces
    // it means is a wrong bill wearing a right-looking number.
    withTempStore((store) => {
      const facets = ["goal", "behavior"];
      store.insertTraces([
        trace({ id: "done", text: "x".repeat(100) }),
        trace({ id: "half", text: "x".repeat(200) }),
        trace({ id: "pending", text: "x".repeat(300) }),
        trace({ id: "other-agent", agentId: "coder", text: "x".repeat(400) }),
      ]);
      store.insertSummary({ traceId: "done", facet: "goal", summary: "g" });
      store.insertSummary({ traceId: "done", facet: "behavior", summary: "b" });
      store.insertSummary({ traceId: "half", facet: "goal", summary: "g" });

      for (const scope of [{}, { agentId: "support-bot" }, { agentId: "coder" }, { since: "2026-07-01T09:00:00.000Z" }]) {
        assert.equal(
          store.pendingSummaryStats(facets, scope).traces,
          store.countTracesNeedingSummaries(facets, scope),
          `scope ${JSON.stringify(scope)}`,
        );
      }
      // half (200) + pending (300) + other-agent (400); "done" is finished.
      assert.equal(store.pendingSummaryStats(facets).chars, 900);
      assert.deepEqual(store.pendingSummaryStats([]), { traces: 0, chars: 0 });
    });
  });

  test("a long trace is measured as it is sent, not as it is stored", () => {
    // clipTrace caps what actually reaches the model; summing raw lengths would
    // overstate the bill on any corpus holding long traces.
    withTempStore((store) => {
      store.insertTraces([trace({ id: "huge", text: "x".repeat(30_000) })]);
      assert.equal(store.pendingSummaryStats(["goal"]).chars, 24_000);
      assert.equal(store.pendingSummaryStats(["goal"], { maxChars: 1000 }).chars, 1000);
    });
  });

  test("counts traces no window can see, residuals excluded", () => {
    // A residual has an assignment row with a NULL theme: the report counts it
    // and can say so. A trace with no row at all is the invisible one.
    withTempStore((store) => {
      store.insertTraces(["assigned", "residual", "unsummarized", "other-facet"].map((id) => trace({ id })));
      store.insertAssignment({ traceId: "assigned", agentId: "support-bot", facet: "behavior", themeId: "SIFT-1", similarity: 0.9, window: "v1.2" });
      store.insertAssignment({ traceId: "residual", agentId: "support-bot", facet: "behavior", themeId: null, similarity: 0.1, window: "v1.2" });
      store.insertAssignment({ traceId: "other-facet", agentId: "support-bot", facet: "goal", themeId: null, similarity: 0.1, window: "v1.2" });

      assert.equal(store.countUncoveredTraces("support-bot", ["behavior"]), 2);
      assert.equal(store.countUncoveredTraces("nobody", ["behavior"]), 0);
    });
  });

  test("over several facets it counts traces, not trace-facet pairs", () => {
    // The bug this pins: `sift check` added a per-facet count once per facet
    // and reported four times the traces the database held.
    withTempStore((store) => {
      store.insertTraces(["covered", "half", "invisible"].map((id) => trace({ id })));
      for (const facet of ["goal", "behavior"]) {
        store.insertAssignment({ traceId: "covered", agentId: "support-bot", facet, themeId: "SIFT-1", similarity: 0.9, window: "v1.2" });
      }
      store.insertAssignment({ traceId: "half", agentId: "support-bot", facet: "goal", themeId: null, similarity: 0.1, window: "v1.2" });

      assert.equal(store.countUncoveredTraces("support-bot", ["goal", "behavior"]), 2, "half is uncovered once, not twice");
      assert.equal(store.countUncoveredTraces("support-bot", ["goal"]), 1);
      assert.equal(store.countUncoveredTraces("support-bot", []), 0);
    });
  });

  test("finds summaries that still need embedding", () => {
    withTempStore((store) => {
      store.insertTrace(trace());
      store.insertSummary({ traceId: "t1", facet: "goal", summary: "a", embedding: [1] });
      store.insertSummary({ traceId: "t1", facet: "outcome", summary: "b" });
      const pending = store.summariesNeedingEmbeddings();
      assert.deepEqual(pending.map((s) => s.facet), ["outcome"]);
    });
  });

  test("summariesForFacet returns only embedded rows", () => {
    withTempStore((store) => {
      store.insertTraces([trace({ id: "embedded" }), trace({ id: "bare" })]);
      store.insertSummary({ traceId: "embedded", facet: "goal", summary: "a", embedding: [1, 0] });
      store.insertSummary({ traceId: "bare", facet: "goal", summary: "b" });
      assert.deepEqual(store.summariesForFacet("goal").map((s) => s.traceId), ["embedded"]);
    });
  });

  test("unassignedOnly covers both never-assigned rows and residual rows", () => {
    withTempStore((store) => {
      store.insertTraces([trace({ id: "assigned" }), trace({ id: "residual" }), trace({ id: "untouched" })]);
      for (const id of ["assigned", "residual", "untouched"]) {
        store.insertSummary({ traceId: id, facet: "behavior", summary: id, embedding: [1, 0] });
      }
      store.insertTheme(theme());
      store.insertAssignment({ traceId: "assigned", agentId: "support-bot", facet: "behavior", themeId: "SIFT-1", similarity: 0.9, window: "v1.2" });
      store.insertAssignment({ traceId: "residual", agentId: "support-bot", facet: "behavior", themeId: null, similarity: 0.1, window: "v1.2" });

      const ids = store.summariesForFacet("behavior", { unassignedOnly: true }).map((s) => s.traceId).sort();
      assert.deepEqual(ids, ["residual", "untouched"]);
    });
  });

  test("lists the facets it has summaries for", () => {
    withTempStore((store) => {
      store.insertTrace(trace());
      store.insertSummary({ traceId: "t1", facet: "goal", summary: "a" });
      store.insertSummary({ traceId: "t1", facet: "behavior", summary: "b" });
      assert.deepEqual(store.facetsWithSummaries(), ["behavior", "goal"]);
    });
  });
});

describe("theme identity", () => {
  test("issues sequential SIFT ids", () => {
    withTempStore((store) => {
      assert.equal(store.nextThemeId(), "SIFT-1");
      assert.equal(store.nextThemeId(), "SIFT-2");
      assert.equal(store.nextThemeId(), "SIFT-3");
    });
  });

  test("the sequence survives reopening the database", () => {
    withTempDir((dir) => {
      const path = join(dir, "s.db");
      const a = new SiftStore(path);
      a.nextThemeId();
      a.nextThemeId();
      a.close();
      const b = new SiftStore(path);
      assert.equal(b.nextThemeId(), "SIFT-3");
      b.close();
    });
  });

  test("ids are never reused, even after a theme is deleted", () => {
    // Stable identity is the entire premise: SIFT-14 in a chat log from last
    // month must never point at a different behavior today.
    withTempStore((store) => {
      const id = store.nextThemeId();
      store.insertTheme(theme({ id }));
      store.deleteTheme(id);
      assert.notEqual(store.nextThemeId(), id);
    });
  });

  test("inserting a duplicate theme id is an error rather than a silent overwrite", () => {
    withTempStore((store) => {
      store.insertTheme(theme());
      assert.throws(() => store.insertTheme(theme({ label: "something else" })));
    });
  });
});

describe("themes", () => {
  test("round-trips including centroid, exemplars and optional fields", () => {
    withTempStore((store) => {
      const t = theme({ centroid: [0.1, 0.2, 0.3], exemplarTraceIds: ["a", "b"], lastSeenWindow: "v1.3", note: "wontfix" });
      store.insertTheme(t);
      assert.deepEqual(store.getTheme("SIFT-1"), t);
    });
  });

  test("update persists every mutable field", () => {
    withTempStore((store) => {
      store.insertTheme(theme());
      const updated = theme({
        label: "renamed",
        description: "new description",
        state: "resolved",
        centroid: [0, 1, 0],
        memberCount: 99,
        exemplarTraceIds: ["z"],
        updatedAt: "2026-08-01T00:00:00.000Z",
        lastSeenWindow: "v2.0",
        note: "fixed in v2",
      });
      store.updateTheme(updated);
      assert.deepEqual(store.getTheme("SIFT-1"), updated);
    });
  });

  test("filters themes by facet and state", () => {
    withTempStore((store) => {
      store.insertTheme(theme({ id: "SIFT-1", facet: "behavior", state: "active" }));
      store.insertTheme(theme({ id: "SIFT-2", facet: "behavior", state: "muted" }));
      store.insertTheme(theme({ id: "SIFT-3", facet: "goal", state: "active" }));

      assert.deepEqual(store.themesForFacet("support-bot", "behavior").map((t) => t.id), ["SIFT-1", "SIFT-2"]);
      assert.deepEqual(store.themesForFacet("support-bot", "behavior", ["active"]).map((t) => t.id), ["SIFT-1"]);
      assert.deepEqual(store.allThemes().length, 3);
    });
  });

  test("allThemes is ordered by size so the issues list leads with what matters", () => {
    withTempStore((store) => {
      store.insertTheme(theme({ id: "SIFT-1", memberCount: 3 }));
      store.insertTheme(theme({ id: "SIFT-2", memberCount: 40 }));
      store.insertTheme(theme({ id: "SIFT-3", memberCount: 12 }));
      assert.deepEqual(store.allThemes().map((t) => t.id), ["SIFT-2", "SIFT-3", "SIFT-1"]);
    });
  });
});

describe("assignments and windows", () => {
  function seed(store: SiftStore) {
    store.insertTheme(theme({ id: "SIFT-1" }));
    store.insertTheme(theme({ id: "SIFT-2" }));
    const rows: Array<[string, string | null, string]> = [
      ["a", "SIFT-1", "v1.2"],
      ["b", "SIFT-1", "v1.2"],
      ["c", "SIFT-2", "v1.2"],
      ["d", null, "v1.2"],
      ["e", "SIFT-1", "v1.3"],
      ["f", null, "v1.3"],
    ];
    for (const [id, themeId, window] of rows) {
      store.insertTrace(trace({ id, version: window }));
      store.insertAssignment({ traceId: id, agentId: "support-bot", facet: "behavior", themeId, similarity: themeId ? 0.9 : 0.1, window });
    }
  }

  test("re-assigning a trace/facet replaces the previous assignment", () => {
    withTempStore((store) => {
      store.insertTrace(trace());
      store.insertTheme(theme());
      store.insertAssignment({ traceId: "t1", agentId: "support-bot", facet: "behavior", themeId: null, similarity: 0.2, window: "w1" });
      store.insertAssignment({ traceId: "t1", agentId: "support-bot", facet: "behavior", themeId: "SIFT-1", similarity: 0.8, window: "w1" });
      assert.equal(store.residualShare("support-bot", "behavior", "w1"), 0);
      assert.equal(store.countAssignments("behavior"), 1);
    });
  });

  test("residual share is residuals over all assignments in the window", () => {
    withTempStore((store) => {
      seed(store);
      assert.equal(store.residualShare("support-bot", "behavior", "v1.2"), 0.25);
      assert.equal(store.residualShare("support-bot", "behavior", "v1.3"), 0.5);
    });
  });

  test("residual share of an empty window is 0, not NaN", () => {
    withTempStore((store) => assert.equal(store.residualShare("support-bot", "behavior", "never"), 0));
  });

  test("counts per theme per window, with window totals for share math", () => {
    withTempStore((store) => {
      seed(store);
      const stats = store.themeCountsByWindow("support-bot", "behavior");
      assert.deepEqual(stats.windows, ["v1.2", "v1.3"]);
      assert.equal(stats.totals.get("v1.2"), 4);
      assert.equal(stats.counts.get("v1.2")!.get("SIFT-1"), 2);
      assert.equal(stats.counts.get("v1.3")!.get("SIFT-1"), 1);
      assert.equal(stats.residuals.get("v1.2"), 1);
    });
  });

  test("window totals include residuals, so shares add to less than 1 when discovery is behind", () => {
    withTempStore((store) => {
      seed(store);
      const stats = store.themeCountsByWindow("support-bot", "behavior");
      const assignedShare = [...stats.counts.get("v1.2")!.values()].reduce((a, b) => a + b, 0) / stats.totals.get("v1.2")!;
      assert.equal(assignedShare, 0.75);
    });
  });

  test("lists windows in order for sparklines", () => {
    withTempStore((store) => {
      seed(store);
      assert.deepEqual(store.windowsForFacet("support-bot", "behavior"), ["v1.2", "v1.3"]);
    });
  });

  test("fetches a theme's traces, most similar first", () => {
    withTempStore((store) => {
      store.insertTheme(theme());
      store.insertTrace(trace({ id: "low" }));
      store.insertTrace(trace({ id: "high" }));
      store.insertAssignment({ traceId: "low", agentId: "support-bot", facet: "behavior", themeId: "SIFT-1", similarity: 0.5, window: "w" });
      store.insertAssignment({ traceId: "high", agentId: "support-bot", facet: "behavior", themeId: "SIFT-1", similarity: 0.95, window: "w" });
      assert.deepEqual(store.tracesForTheme("SIFT-1").map((t) => t.id), ["high", "low"]);
    });
  });

  test("counts a theme's assignments in a specific window", () => {
    withTempStore((store) => {
      seed(store);
      assert.equal(store.themeCountInWindow("SIFT-1", "behavior", "v1.2"), 2);
      assert.equal(store.themeCountInWindow("SIFT-2", "behavior", "v1.3"), 0);
    });
  });

  test("residual summaries are retrievable for re-discovery", () => {
    withTempStore((store) => {
      seed(store);
      for (const id of ["d", "f"]) {
        store.insertSummary({ traceId: id, facet: "behavior", summary: "odd one out", embedding: [0, 1] });
      }
      const residual = store.summariesForFacet("behavior", { unassignedOnly: true }).map((s) => s.traceId).sort();
      assert.deepEqual(residual, ["d", "f"]);
    });
  });
});

describe("transactions", () => {
  test("a throwing transaction rolls everything back", () => {
    withTempStore((store) => {
      assert.throws(() =>
        store.transaction(() => {
          store.insertTrace(trace({ id: "a" }));
          store.insertTrace(trace({ id: "b" }));
          throw new Error("boom");
        }),
      );
      assert.equal(store.countTraces(), 0);
    });
  });

  test("a successful transaction commits and returns its value", () => {
    withTempStore((store) => {
      const n = store.transaction(() => {
        store.insertTrace(trace({ id: "a" }));
        return 1;
      });
      assert.equal(n, 1);
      assert.equal(store.countTraces(), 1);
    });
  });

  test("takes the write lock at BEGIN, so a read-then-write is not stranded mid-flight", () => {
    // The bug this pins: a deferred BEGIN fixes a read snapshot, and if another
    // connection commits before the transaction upgrades to a write, SQLite
    // answers SQLITE_BUSY_SNAPSHOT *without* consulting busy_timeout. That is
    // `sift analyze` on a cron exiting 1 while `sift serve` flushes. Probing
    // with busy_timeout = 0 is how a single-threaded test can tell an IMMEDIATE
    // transaction from a deferred one: only the former locks out the probe.
    withTempStore((store, dir) => {
      const probe = new DatabaseSync(join(dir, "sift.db"));
      probe.exec("PRAGMA busy_timeout = 0");
      let probeError = "";
      store.transaction(() => {
        store.getTrace("nothing-yet");
        try {
          probe
            .prepare(`INSERT INTO traces (id, agent_id, started_at, text, meta) VALUES (?, ?, ?, ?, ?)`)
            .run("interloper", "other-bot", "2026-07-01T00:00:00.000Z", "", "{}");
        } catch (err) {
          probeError = (err as Error).message;
        }
        store.insertTrace(trace({ id: "mine" }));
      });
      probe.close();

      assert.match(probeError, /busy|locked/i, "a concurrent writer got in between the read and the write");
      assert.ok(store.getTrace("mine"), "the transaction's own write must still land");
    });
  });
});

describe("meta", () => {
  test("stores and reads arbitrary keys", () => {
    withTempStore((store) => {
      assert.equal(store.getMeta("nope"), undefined);
      store.setMeta("last_run", "2026-07-30");
      assert.equal(store.getMeta("last_run"), "2026-07-30");
      store.setMeta("last_run", "2026-07-31");
      assert.equal(store.getMeta("last_run"), "2026-07-31");
    });
  });
});
