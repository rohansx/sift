import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ThemeRegistry } from "../src/registry/index.ts";
import { SiftStore } from "../src/store/db.ts";
import { DEFAULT_CONFIG, type SiftConfig } from "../src/config.ts";
import { cosine, mean } from "../src/cluster/vectors.ts";
import { StubLabeler } from "../src/testing/fakes.ts";
import type { Clock, FacetSummary, Theme, Trace } from "../src/types.ts";

const FACET = "behavior";

function fixedClock(iso = "2026-07-30T12:00:00.000Z"): Clock {
  return () => new Date(iso);
}

interface Harness {
  store: SiftStore;
  registry: ThemeRegistry;
  cfg: SiftConfig;
  /** insert a trace + an embedded summary for FACET */
  seed(id: string, summary: string, embedding: number[], opts?: { version?: string; startedAt?: string }): FacetSummary;
  /** insert a theme directly, bypassing discovery */
  plant(over?: Partial<Theme>): Theme;
}

function harness(overrides: Partial<SiftConfig> = {}, clock: Clock = fixedClock()): Harness {
  const store = new SiftStore(":memory:");
  const cfg: SiftConfig = { ...DEFAULT_CONFIG, minClusterSize: 3, ...overrides };
  const registry = new ThemeRegistry(store, cfg, { labeler: new StubLabeler(), clock });

  return {
    store,
    registry,
    cfg,
    seed(id, summary, embedding, opts = {}) {
      const trace: Trace = {
        id,
        agentId: "support-bot",
        startedAt: opts.startedAt ?? "2026-07-01T00:00:00.000Z",
        text: `trace ${id}`,
        meta: {},
      };
      if (opts.version) trace.version = opts.version;
      store.insertTrace(trace);
      const s: FacetSummary = { traceId: id, facet: FACET, summary, embedding };
      store.insertSummary(s);
      return s;
    },
    plant(over = {}) {
      const t: Theme = {
        id: over.id ?? store.nextThemeId(),
        facet: FACET,
        label: "planted theme",
        description: "",
        state: "active",
        centroid: [1, 0, 0],
        memberCount: 10,
        exemplarTraceIds: [],
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        ...over,
      };
      store.insertTheme(t);
      return t;
    },
  };
}

describe("assignment", () => {
  test("assigns to the nearest theme above the threshold", () => {
    const h = harness({ assignThreshold: 0.7 });
    h.plant({ id: "SIFT-1", centroid: [1, 0, 0] });
    h.plant({ id: "SIFT-2", centroid: [0, 1, 0] });
    const s = h.seed("t1", "retry loop", [0.95, 0.05, 0]);

    const result = h.registry.assign(s, "v1.0");
    assert.equal(result.themeId, "SIFT-1");
    assert.ok(result.similarity > 0.9);
    assert.equal(h.store.getTheme("SIFT-2")!.memberCount, 10, "the losing theme must be untouched");
  });

  test("below the threshold the trace lands in the residual pile", () => {
    const h = harness({ assignThreshold: 0.9 });
    h.plant({ id: "SIFT-1", centroid: [1, 0, 0] });
    const s = h.seed("t1", "something new", [0, 1, 0]);

    const result = h.registry.assign(s, "v1.0");
    assert.equal(result.themeId, null);
    // the residual row still records how close it got: useful for tuning τ
    assert.equal(h.store.residualShare(FACET, "v1.0"), 1);
    assert.ok(Math.abs(result.similarity) < 1e-9);
  });

  test("with an empty registry everything is residual", () => {
    const h = harness();
    const result = h.registry.assign(h.seed("t1", "first ever", [1, 0, 0]), "v1.0");
    assert.equal(result.themeId, null);
    assert.equal(h.store.countAssignments(FACET), 1);
  });

  test("only themes of the same facet are candidates", () => {
    const h = harness({ assignThreshold: 0.5 });
    h.plant({ id: "SIFT-1", facet: "goal", centroid: [1, 0, 0] });
    const result = h.registry.assign(h.seed("t1", "x", [1, 0, 0]), "v1.0");
    assert.equal(result.themeId, null);
  });

  test("the centroid stays the exact mean of everything assigned to it", () => {
    // If centroids drift, "SIFT-14 means the same thing next week" stops being
    // true, and every downstream promise depends on it.
    const h = harness({ assignThreshold: 0.0 });
    const members = [
      [1, 0, 0],
      [0.9, 0.4, 0],
      [0.8, 0.1, 0.5],
    ];
    h.plant({ id: "SIFT-1", centroid: members[0]!, memberCount: 1 });
    h.seed("t2", "b", members[1]!);
    h.seed("t3", "c", members[2]!);

    h.registry.assign(h.store.getSummary("t2", FACET)!, "w");
    h.registry.assign(h.store.getSummary("t3", FACET)!, "w");

    const expected = mean(members);
    const got = h.store.getTheme("SIFT-1")!;
    assert.equal(got.memberCount, 3);
    for (let i = 0; i < expected.length; i++) {
      assert.ok(Math.abs(got.centroid[i]! - expected[i]!) < 1e-9, `centroid drifted at ${i}`);
    }
  });

  test("records the window and updates lastSeenWindow", () => {
    const h = harness({ assignThreshold: 0.5 });
    h.plant({ id: "SIFT-1", centroid: [1, 0, 0] });
    h.registry.assign(h.seed("t1", "x", [1, 0, 0]), "v1.3");
    assert.equal(h.store.getTheme("SIFT-1")!.lastSeenWindow, "v1.3");
    assert.equal(h.store.themeCountInWindow("SIFT-1", FACET, "v1.3"), 1);
  });

  test("a summary with no embedding is a programming error, not a silent skip", () => {
    const h = harness();
    assert.throws(() => h.registry.assign({ traceId: "t1", facet: FACET, summary: "x" }, "w"), /embedding/i);
  });

  test("assignPending derives each trace's window from its version tag", () => {
    const h = harness({ assignThreshold: 0.5 });
    h.plant({ id: "SIFT-1", centroid: [1, 0, 0] });
    h.seed("a", "x", [1, 0, 0], { version: "v1.2" });
    h.seed("b", "x", [1, 0, 0], { version: "v1.3" });
    h.seed("c", "x", [1, 0, 0], { startedAt: "2026-06-05T00:00:00.000Z" });

    const summary = h.registry.assignPending(FACET);
    assert.equal(summary.assigned, 3);
    assert.equal(summary.residual, 0);
    assert.deepEqual(h.store.windowsForFacet(FACET), ["2026-06-05", "v1.2", "v1.3"]);
  });

  test("assignPending skips traces that are already assigned", () => {
    const h = harness({ assignThreshold: 0.5 });
    h.plant({ id: "SIFT-1", centroid: [1, 0, 0] });
    h.seed("a", "x", [1, 0, 0], { version: "v1" });
    assert.equal(h.registry.assignPending(FACET).assigned, 1);
    assert.equal(h.registry.assignPending(FACET).assigned, 0, "second pass should find nothing to do");
  });

  test("assignPending retries the residual pile as new themes appear", () => {
    const h = harness({ assignThreshold: 0.5 });
    h.seed("a", "x", [1, 0, 0], { version: "v1" });
    assert.equal(h.registry.assignPending(FACET).residual, 1);

    h.plant({ id: "SIFT-1", centroid: [1, 0, 0] });
    const second = h.registry.assignPending(FACET);
    assert.equal(second.assigned, 1, "a residual should be reconsidered once a theme covers it");
  });
});

describe("lifecycle", () => {
  test("a new theme becomes active once enough traces land in it", () => {
    const h = harness({ assignThreshold: 0.5, activateAfter: 3 });
    h.plant({ id: "SIFT-1", state: "new", memberCount: 1, centroid: [1, 0, 0] });

    h.seed("a", "x", [1, 0, 0]);
    h.registry.assign(h.store.getSummary("a", FACET)!, "w");
    assert.equal(h.store.getTheme("SIFT-1")!.state, "new");

    h.seed("b", "x", [1, 0, 0]);
    const result = h.registry.assign(h.store.getSummary("b", FACET)!, "w");
    assert.equal(h.store.getTheme("SIFT-1")!.state, "active");
    assert.deepEqual(result.transition, { themeId: "SIFT-1", from: "new", to: "active" });
  });

  test("assignments resuming on a resolved theme is a regression", () => {
    // This is the alert-worthy transition, and the reason themes need identity
    // at all: you cannot regress something that gets renamed every week.
    const h = harness({ assignThreshold: 0.5 });
    h.plant({ id: "SIFT-1", state: "resolved", centroid: [1, 0, 0] });
    h.seed("a", "x", [1, 0, 0]);

    const result = h.registry.assign(h.store.getSummary("a", FACET)!, "v2.0");
    assert.equal(h.store.getTheme("SIFT-1")!.state, "regressed");
    assert.deepEqual(result.transition, { themeId: "SIFT-1", from: "resolved", to: "regressed" });
  });

  test("a regressed theme stays regressed until someone resolves it again", () => {
    const h = harness({ assignThreshold: 0.5 });
    h.plant({ id: "SIFT-1", state: "regressed", centroid: [1, 0, 0] });
    h.seed("a", "x", [1, 0, 0]);
    const result = h.registry.assign(h.store.getSummary("a", FACET)!, "w");
    assert.equal(h.store.getTheme("SIFT-1")!.state, "regressed");
    assert.equal(result.transition, undefined);
  });

  test("a muted theme still collects traces but never changes state", () => {
    const h = harness({ assignThreshold: 0.5, activateAfter: 1 });
    h.plant({ id: "SIFT-1", state: "muted", memberCount: 0, centroid: [1, 0, 0] });
    h.seed("a", "x", [1, 0, 0]);

    const result = h.registry.assign(h.store.getSummary("a", FACET)!, "w");
    const theme = h.store.getTheme("SIFT-1")!;
    assert.equal(theme.state, "muted");
    assert.equal(theme.memberCount, 1, "muted means 'do not alert', not 'do not count'");
    assert.equal(result.transition, undefined);
  });

  test("resolve, mute and reopen are explicit operations with notes", () => {
    const h = harness();
    h.plant({ id: "SIFT-1", state: "active" });

    h.registry.resolve("SIFT-1", "fixed in v1.4");
    let t = h.store.getTheme("SIFT-1")!;
    assert.equal(t.state, "resolved");
    assert.equal(t.note, "fixed in v1.4");
    assert.equal(t.updatedAt, "2026-07-30T12:00:00.000Z");

    h.registry.mute("SIFT-1", "expected behavior");
    assert.equal(h.store.getTheme("SIFT-1")!.state, "muted");

    h.registry.reopen("SIFT-1");
    t = h.store.getTheme("SIFT-1")!;
    assert.equal(t.state, "active");
    assert.equal(t.note, undefined, "reopening clears the resolution note");
  });

  test("lifecycle operations on an unknown theme name the id", () => {
    const h = harness();
    assert.throws(() => h.registry.resolve("SIFT-99"), /SIFT-99/);
    assert.throws(() => h.registry.mute("SIFT-99"), /SIFT-99/);
    assert.throws(() => h.registry.reopen("SIFT-99"), /SIFT-99/);
  });

  test("relabel changes the words without touching the identity", () => {
    const h = harness();
    h.plant({ id: "SIFT-1", label: "vague label" });
    h.registry.relabel("SIFT-1", "tool-retry loop on search_kb", "the agent retries after a timeout");
    const t = h.store.getTheme("SIFT-1")!;
    assert.equal(t.id, "SIFT-1");
    assert.equal(t.label, "tool-retry loop on search_kb");
    assert.equal(t.description, "the agent retries after a timeout");
  });
});

describe("auto-resolve sweep", () => {
  function seedWindows(h: Harness, themeId: string, windows: Array<[string, number]>) {
    let n = 0;
    for (const [window, count] of windows) {
      for (let i = 0; i < count; i++) {
        const id = `${themeId}-${window}-${n++}`;
        h.seed(id, "x", [1, 0, 0], { version: window });
        h.store.insertAssignment({ traceId: id, facet: FACET, themeId, similarity: 0.9, window });
      }
    }
  }

  test("is off unless configured", () => {
    const h = harness({ autoResolveAfterEmptyWindows: 0 });
    h.plant({ id: "SIFT-1", state: "active" });
    seedWindows(h, "SIFT-1", [["v1", 5]]);
    // three later windows with nothing
    for (const w of ["v2", "v3", "v4"]) h.store.insertAssignment({ traceId: `filler-${w}`, facet: FACET, themeId: null, similarity: 0, window: w });

    assert.deepEqual(h.registry.sweepAutoResolve(FACET), []);
    assert.equal(h.store.getTheme("SIFT-1")!.state, "active");
  });

  test("resolves a theme that has been silent for K windows", () => {
    const h = harness({ autoResolveAfterEmptyWindows: 2 });
    h.plant({ id: "SIFT-1", state: "active" });
    seedWindows(h, "SIFT-1", [["v1", 5]]);
    for (const w of ["v2", "v3"]) h.store.insertAssignment({ traceId: `filler-${w}`, facet: FACET, themeId: null, similarity: 0, window: w });

    const transitions = h.registry.sweepAutoResolve(FACET);
    assert.deepEqual(transitions, [{ themeId: "SIFT-1", from: "active", to: "resolved" }]);
    const t = h.store.getTheme("SIFT-1")!;
    assert.equal(t.state, "resolved");
    assert.match(t.note!, /auto-resolved/i);
  });

  test("a theme seen in a recent window is left alone", () => {
    const h = harness({ autoResolveAfterEmptyWindows: 2 });
    h.plant({ id: "SIFT-1", state: "active" });
    seedWindows(h, "SIFT-1", [["v1", 3], ["v3", 1]]);
    h.store.insertAssignment({ traceId: "filler-v2", facet: FACET, themeId: null, similarity: 0, window: "v2" });

    assert.deepEqual(h.registry.sweepAutoResolve(FACET), []);
    assert.equal(h.store.getTheme("SIFT-1")!.state, "active");
  });

  test("never auto-resolves muted or already-resolved themes", () => {
    const h = harness({ autoResolveAfterEmptyWindows: 1 });
    h.plant({ id: "SIFT-1", state: "muted" });
    h.plant({ id: "SIFT-2", state: "resolved" });
    for (const w of ["v1", "v2"]) h.store.insertAssignment({ traceId: `filler-${w}`, facet: FACET, themeId: null, similarity: 0, window: w });
    assert.deepEqual(h.registry.sweepAutoResolve(FACET), []);
  });

  test("does nothing before there is enough window history to judge", () => {
    const h = harness({ autoResolveAfterEmptyWindows: 3 });
    h.plant({ id: "SIFT-1", state: "active" });
    seedWindows(h, "SIFT-1", [["v1", 3]]);
    assert.deepEqual(h.registry.sweepAutoResolve(FACET), []);
  });
});

describe("discovery", () => {
  /** three separated groups: 5 "retry", 5 "refund", 2 stragglers */
  function seedResidualPile(h: Harness) {
    for (let i = 0; i < 5; i++) h.seed(`retry-${i}`, "tool retry loop", [1, 0.02 * i, 0], { version: "v1" });
    for (let i = 0; i < 5; i++) h.seed(`refund-${i}`, "refund deflected", [0.02 * i, 1, 0], { version: "v1" });
    for (let i = 0; i < 2; i++) h.seed(`odd-${i}`, `one off ${i}`, [0, 0.02 * i, 1], { version: "v1" });
  }

  test("turns the residual pile into themes with fresh stable ids", async () => {
    const h = harness({ minClusterSize: 3 });
    seedResidualPile(h);

    const created = await h.registry.discover(FACET);
    assert.equal(created.length, 2);
    assert.deepEqual(created.map((t) => t.id).sort(), ["SIFT-1", "SIFT-2"]);
    assert.ok(created.every((t) => t.state === "new"));
    assert.ok(created.every((t) => t.facet === FACET));
  });

  test("labels come from the labeler, one call per cluster", async () => {
    const h = harness({ minClusterSize: 3 });
    seedResidualPile(h);
    const created = await h.registry.discover(FACET);
    const labels = created.map((t) => t.label).sort();
    assert.deepEqual(labels, ["refund deflected", "tool retry loop"]);
    assert.ok(created.every((t) => t.description.length > 0));
  });

  test("members are retro-assigned with their own trace's window", async () => {
    const h = harness({ minClusterSize: 3 });
    for (let i = 0; i < 3; i++) h.seed(`a-${i}`, "tool retry loop", [1, 0.01 * i, 0], { version: "v1.2" });
    for (let i = 0; i < 3; i++) h.seed(`b-${i}`, "tool retry loop", [1, 0.01 * i, 0.01], { version: "v1.3" });

    const [theme] = await h.registry.discover(FACET);
    assert.equal(h.store.themeCountInWindow(theme!.id, FACET, "v1.2"), 3);
    assert.equal(h.store.themeCountInWindow(theme!.id, FACET, "v1.3"), 3);
    assert.equal(theme!.lastSeenWindow, "v1.3");
  });

  test("points too sparse to be a theme are written to the residual pile, not lost", async () => {
    const h = harness({ minClusterSize: 3 });
    seedResidualPile(h);
    await h.registry.discover(FACET);

    const residual = h.store.summariesForFacet(FACET, { unassignedOnly: true }).map((s) => s.traceId).sort();
    assert.deepEqual(residual, ["odd-0", "odd-1"]);
    assert.ok(h.store.residualShare(FACET, "v1") > 0, "residual traces must still count toward the share");
  });

  test("exemplars are the members nearest the centroid, capped at maxExemplars", async () => {
    const h = harness({ minClusterSize: 3, maxExemplars: 2 });
    h.seed("near-a", "tool retry loop", [1, 0, 0], { version: "v1" });
    h.seed("near-b", "tool retry loop", [1, 0.01, 0], { version: "v1" });
    h.seed("far", "tool retry loop", [0.8, 0.3, 0], { version: "v1" });

    const [theme] = await h.registry.discover(FACET);
    assert.equal(theme!.exemplarTraceIds.length, 2);
    assert.ok(!theme!.exemplarTraceIds.includes("far"), "the outlier should not represent the theme");
  });

  test("too few summaries to form any cluster yields no themes and no damage", async () => {
    const h = harness({ minClusterSize: 5 });
    h.seed("a", "x", [1, 0, 0]);
    assert.deepEqual(await h.registry.discover(FACET), []);
    assert.equal(h.store.allThemes().length, 0);
  });

  test("only embedded summaries participate", async () => {
    const h = harness({ minClusterSize: 3 });
    for (let i = 0; i < 3; i++) h.seed(`a-${i}`, "tool retry loop", [1, 0.01 * i, 0], { version: "v1" });
    h.store.insertTrace({ id: "no-emb", agentId: "x", startedAt: "2026-07-01T00:00:00.000Z", text: "", meta: {} });
    h.store.insertSummary({ traceId: "no-emb", facet: FACET, summary: "not embedded yet" });

    const [theme] = await h.registry.discover(FACET);
    assert.equal(theme!.memberCount, 3);
  });
});

describe("stability: what makes a theme an issue", () => {
  test("re-discovery adds themes and never renames or renumbers existing ones", async () => {
    // The whole product claim. Mastra full-re-clusters and labels rename weekly;
    // here an existing theme is untouched no matter what arrives later.
    const h = harness({ minClusterSize: 3, assignThreshold: 0.9 });
    for (let i = 0; i < 4; i++) h.seed(`retry-${i}`, "tool retry loop", [1, 0.01 * i, 0], { version: "v1" });

    const first = await h.registry.discover(FACET);
    assert.equal(first.length, 1);
    const before = h.store.getTheme(first[0]!.id)!;

    // a completely new failure mode shows up next release
    for (let i = 0; i < 4; i++) h.seed(`refund-${i}`, "refund deflected", [0, 1, 0.01 * i], { version: "v2" });
    h.registry.assignPending(FACET);
    const second = await h.registry.discover(FACET);

    assert.equal(second.length, 1);
    assert.notEqual(second[0]!.id, before.id);
    const after = h.store.getTheme(before.id)!;
    assert.equal(after.id, before.id);
    assert.equal(after.label, before.label);
    assert.equal(after.createdAt, before.createdAt);
  });

  test("an established theme absorbs matching traffic instead of spawning a duplicate", async () => {
    const h = harness({ minClusterSize: 3, assignThreshold: 0.8 });
    for (let i = 0; i < 4; i++) h.seed(`retry-${i}`, "tool retry loop", [1, 0.01 * i, 0], { version: "v1" });
    const [theme] = await h.registry.discover(FACET);

    for (let i = 0; i < 6; i++) h.seed(`more-${i}`, "tool retry loop", [1, 0.02 * i, 0], { version: "v2" });
    const summary = h.registry.assignPending(FACET);
    assert.equal(summary.assigned, 6);

    assert.equal(h.store.allThemes().length, 1);
    assert.equal(h.store.getTheme(theme!.id)!.memberCount, 10);
  });

  test("theme ids keep counting up across discovery runs", async () => {
    const h = harness({ minClusterSize: 3 });
    for (let i = 0; i < 3; i++) h.seed(`a-${i}`, "alpha", [1, 0.01 * i, 0], { version: "v1" });
    await h.registry.discover(FACET);
    for (let i = 0; i < 3; i++) h.seed(`b-${i}`, "beta", [0, 1, 0.01 * i], { version: "v1" });
    const second = await h.registry.discover(FACET);
    assert.equal(second[0]!.id, "SIFT-2");
  });
});

describe("residual pressure", () => {
  test("needsRediscovery tracks the configured share", () => {
    const h = harness({ rediscoverResidualShare: 0.08 });
    for (let i = 0; i < 20; i++) {
      h.store.insertAssignment({ traceId: `ok-${i}`, facet: FACET, themeId: null, similarity: 0, window: "w" });
    }
    assert.equal(h.registry.needsRediscovery(FACET, "w"), true);

    const h2 = harness({ rediscoverResidualShare: 0.5 });
    h2.plant({ id: "SIFT-1" });
    for (let i = 0; i < 9; i++) {
      h2.store.insertAssignment({ traceId: `ok-${i}`, facet: FACET, themeId: "SIFT-1", similarity: 0.9, window: "w" });
    }
    h2.store.insertAssignment({ traceId: "res", facet: FACET, themeId: null, similarity: 0, window: "w" });
    assert.equal(h2.registry.needsRediscovery(FACET, "w"), false);
  });

  test("an empty window never triggers discovery", () => {
    const h = harness();
    assert.equal(h.registry.needsRediscovery(FACET, "nothing-here"), false);
  });
});

describe("exemplar maintenance", () => {
  test("refreshExemplars takes the best-matching traces from the assignment record", () => {
    const h = harness({ maxExemplars: 2 });
    h.plant({ id: "SIFT-1", exemplarTraceIds: [] });
    for (const [id, sim] of [["low", 0.71], ["best", 0.99], ["mid", 0.85]] as const) {
      h.seed(id, "x", [1, 0, 0]);
      h.store.insertAssignment({ traceId: id, facet: FACET, themeId: "SIFT-1", similarity: sim, window: "w" });
    }
    h.registry.refreshExemplars("SIFT-1");
    assert.deepEqual(h.store.getTheme("SIFT-1")!.exemplarTraceIds, ["best", "mid"]);
  });

  test("a theme with room keeps collecting exemplars as traces arrive", () => {
    const h = harness({ assignThreshold: 0.5, maxExemplars: 3 });
    h.plant({ id: "SIFT-1", exemplarTraceIds: [], centroid: [1, 0, 0] });
    for (let i = 0; i < 5; i++) {
      h.seed(`t${i}`, "x", [1, 0.01 * i, 0]);
      h.registry.assign(h.store.getSummary(`t${i}`, FACET)!, "w");
    }
    assert.equal(h.store.getTheme("SIFT-1")!.exemplarTraceIds.length, 3);
  });
});

describe("cost shape", () => {
  test("steady-state assignment touches the registry, not the corpus", () => {
    // The economic claim in the README: assignment is one cosine sweep over
    // themes. If it ever scans summaries or traces, the cost story is gone.
    const h = harness({ assignThreshold: 0.5 });
    for (let i = 0; i < 5; i++) h.plant({ id: `SIFT-${i + 1}`, centroid: unit(i, 8) });
    for (let i = 0; i < 500; i++) h.seed(`old-${i}`, "history", unit(0, 8));

    const s = h.seed("new", "x", unit(0, 8));
    const comparisons: number[] = [];
    const result = h.registry.assign(s, "w", { onCompare: (n) => comparisons.push(n) });

    assert.equal(result.themeId, "SIFT-1");
    assert.deepEqual(comparisons, [5], "one comparison per theme, regardless of history size");
  });
});

function unit(i: number, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  v[i % dims] = 1;
  return v;
}

describe("integration with real geometry", () => {
  test("cosine ordering of assignments matches the geometry", () => {
    const h = harness({ assignThreshold: 0.5 });
    h.plant({ id: "SIFT-1", centroid: [1, 0, 0] });
    h.plant({ id: "SIFT-2", centroid: [0, 1, 0] });

    const near1 = h.seed("a", "x", [0.9, 0.4, 0]);
    const near2 = h.seed("b", "x", [0.4, 0.9, 0]);
    assert.equal(h.registry.assign(near1, "w").themeId, "SIFT-1");
    assert.equal(h.registry.assign(near2, "w").themeId, "SIFT-2");
    assert.ok(cosine([0.9, 0.4, 0], [1, 0, 0]) > cosine([0.9, 0.4, 0], [0, 1, 0]));
  });
});
