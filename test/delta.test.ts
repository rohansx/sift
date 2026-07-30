import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { computeDeltas, themeSeries, type DeltaReport } from "../src/delta/index.ts";
import { SiftStore } from "../src/store/db.ts";
import type { DeltaFinding, Theme, ThemeState } from "../src/types.ts";

const FACET = "behavior";
const AGENT = "support-bot";

function store(): SiftStore {
  return new SiftStore(":memory:");
}

function addTheme(s: SiftStore, id: string, over: Partial<Theme> = {}): void {
  s.insertTheme({
    id,
    agentId: AGENT,
    facet: FACET,
    label: `label for ${id}`,
    description: "",
    state: "active",
    centroid: [1, 0],
    memberCount: 0,
    exemplarTraceIds: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  });
}

/** window -> [themeId | null, count][] */
function addWindow(s: SiftStore, window: string, rows: Array<[string | null, number]>): void {
  let n = 0;
  for (const [themeId, count] of rows) {
    for (let i = 0; i < count; i++) {
      const traceId = `${window}-${themeId ?? "residual"}-${n++}`;
      s.insertAssignment({ traceId, agentId: AGENT, facet: FACET, themeId, similarity: themeId ? 0.9 : 0.1, window });
    }
  }
}

function findingFor(report: DeltaReport, id: string): DeltaFinding {
  const found = report.findings.find((f) => f.themeId === id);
  assert.ok(found, `no finding for ${id}; got ${report.findings.map((f) => f.themeId).join(", ") || "none"}`);
  return found;
}

describe("share math", () => {
  test("computes from/to shares and the absolute change", () => {
    const s = store();
    addTheme(s, "SIFT-1");
    addWindow(s, "v1", [["SIFT-1", 2], [null, 8]]);
    addWindow(s, "v2", [["SIFT-1", 6], [null, 4]]);

    const report = computeDeltas(s, AGENT, FACET, "v1", "v2", { sigma: 2 });
    const f = findingFor(report, "SIFT-1");
    assert.equal(f.fromCount, 2);
    assert.equal(f.toCount, 6);
    assert.equal(f.fromShare, 0.2);
    assert.equal(f.toShare, 0.6);
    assert.ok(Math.abs(f.delta - 0.4) < 1e-9);
  });

  test("residuals stay in the denominator, so shares reflect real traffic", () => {
    // If residuals were excluded, a window where discovery is behind would show
    // inflated shares and invent regressions that are really coverage gaps.
    const s = store();
    addTheme(s, "SIFT-1");
    addWindow(s, "v1", [["SIFT-1", 5], [null, 5]]);
    const report = computeDeltas(s, AGENT, FACET, "v1", "v1", { sigma: 2 });
    assert.equal(findingFor(report, "SIFT-1").fromShare, 0.5);
    assert.equal(report.fromResidualShare, 0.5);
    assert.equal(report.fromTotal, 10);
  });

  test("reports totals and residual share for both windows", () => {
    const s = store();
    addTheme(s, "SIFT-1");
    addWindow(s, "v1", [["SIFT-1", 9], [null, 1]]);
    addWindow(s, "v2", [["SIFT-1", 15], [null, 5]]);
    const report = computeDeltas(s, AGENT, FACET, "v1", "v2", { sigma: 2 });
    assert.equal(report.fromTotal, 10);
    assert.equal(report.toTotal, 20);
    assert.ok(Math.abs(report.fromResidualShare - 0.1) < 1e-9);
    assert.equal(report.toResidualShare, 0.25);
  });
});

describe("severity", () => {
  test("a theme that only appears in the newer window is NEW", () => {
    const s = store();
    addTheme(s, "SIFT-1");
    addTheme(s, "SIFT-2", { state: "new" });
    addWindow(s, "v1", [["SIFT-1", 10]]);
    addWindow(s, "v2", [["SIFT-1", 8], ["SIFT-2", 2]]);

    const report = computeDeltas(s, AGENT, FACET, "v1", "v2", { sigma: 2 });
    assert.equal(findingFor(report, "SIFT-2").severity, "new");
    assert.equal(findingFor(report, "SIFT-2").fromCount, 0);
  });

  test("traffic returning to a resolved theme is a REGRESSION", () => {
    const s = store();
    addTheme(s, "SIFT-1", { state: "regressed" });
    addWindow(s, "v1", [["SIFT-1", 0], [null, 10]]);
    addWindow(s, "v2", [["SIFT-1", 4], [null, 6]]);

    const report = computeDeltas(s, AGENT, FACET, "v1", "v2", { sigma: 2 });
    assert.equal(findingFor(report, "SIFT-1").severity, "regression");
  });

  test("a resolved theme that stays quiet is not a regression", () => {
    const s = store();
    addTheme(s, "SIFT-1", { state: "resolved" });
    addWindow(s, "v1", [["SIFT-1", 5], [null, 5]]);
    addWindow(s, "v2", [[null, 10]]);
    const report = computeDeltas(s, AGENT, FACET, "v1", "v2", { sigma: 2 });
    assert.notEqual(findingFor(report, "SIFT-1").severity, "regression");
  });

  test("a large move on an active theme is NOTABLE", () => {
    const s = store();
    addTheme(s, "SIFT-1");
    addWindow(s, "v1", [["SIFT-1", 2], [null, 98]]);
    addWindow(s, "v2", [["SIFT-1", 30], [null, 70]]);
    assert.equal(findingFor(computeDeltas(s, AGENT, FACET, "v1", "v2", { sigma: 2 }), "SIFT-1").severity, "notable");
  });

  test("a change smaller than the floor is never notable, however quiet the history", () => {
    const s = store();
    addTheme(s, "SIFT-1");
    addWindow(s, "v1", [["SIFT-1", 100], [null, 900]]);
    addWindow(s, "v2", [["SIFT-1", 103], [null, 897]]);
    const report = computeDeltas(s, AGENT, FACET, "v1", "v2", { sigma: 2, minAbsDelta: 0.01 });
    assert.equal(findingFor(report, "SIFT-1").severity, "info");
  });

  test("a noisy theme needs a bigger move than a steady one", () => {
    // Two themes end at the same share change; only the historically stable one
    // should be flagged. This is what sigma is for.
    const s = store();
    addTheme(s, "STEADY");
    addTheme(s, "NOISY");
    const history: Array<[string, number, number]> = [
      ["w1", 20, 2],
      ["w2", 20, 38],
      ["w3", 20, 5],
      ["w4", 20, 35],
    ];
    for (const [w, steady, noisy] of history) {
      addWindow(s, w, [["STEADY", steady], ["NOISY", noisy], [null, 100 - steady - noisy]]);
    }
    addWindow(s, "w5", [["STEADY", 35], ["NOISY", 35], [null, 30]]);

    const report = computeDeltas(s, AGENT, FACET, "w4", "w5", { sigma: 2 });
    assert.equal(findingFor(report, "STEADY").severity, "notable");
    assert.equal(findingFor(report, "NOISY").severity, "info");
  });

  test("reports how many sigmas the change is worth", () => {
    const s = store();
    addTheme(s, "SIFT-1");
    addWindow(s, "w1", [["SIFT-1", 10], [null, 90]]);
    addWindow(s, "w2", [["SIFT-1", 20], [null, 80]]);
    addWindow(s, "w3", [["SIFT-1", 60], [null, 40]]);
    const f = findingFor(computeDeltas(s, AGENT, FACET, "w2", "w3", { sigma: 2 }), "SIFT-1");
    assert.ok(f.sigmas > 2, `expected a multi-sigma move, got ${f.sigmas}`);
    assert.ok(Number.isFinite(f.sigmas));
  });

  test("with no history at all, sigmas is 0 rather than Infinity", () => {
    const s = store();
    addTheme(s, "SIFT-1");
    addWindow(s, "v2", [["SIFT-1", 10]]);
    const f = findingFor(computeDeltas(s, AGENT, FACET, "v1", "v2", { sigma: 2 }), "SIFT-1");
    assert.equal(f.sigmas, 0);
  });
});

describe("what gets reported", () => {
  test("muted themes are excluded: they are known and accepted", () => {
    const s = store();
    addTheme(s, "SIFT-1", { state: "muted" });
    addTheme(s, "SIFT-2");
    addWindow(s, "v1", [["SIFT-1", 5], ["SIFT-2", 5]]);
    addWindow(s, "v2", [["SIFT-1", 50], ["SIFT-2", 5]]);

    const report = computeDeltas(s, AGENT, FACET, "v1", "v2", { sigma: 2 });
    assert.deepEqual(report.findings.map((f) => f.themeId), ["SIFT-2"]);
  });

  test("a theme that vanished is reported with a negative delta", () => {
    const s = store();
    addTheme(s, "SIFT-1");
    addWindow(s, "v1", [["SIFT-1", 10]]);
    addWindow(s, "v2", [[null, 10]]);
    const f = findingFor(computeDeltas(s, AGENT, FACET, "v1", "v2", { sigma: 2 }), "SIFT-1");
    assert.equal(f.toCount, 0);
    assert.ok(f.delta < 0);
    assert.notEqual(f.severity, "new");
  });

  test("carries the theme's label and state for display", () => {
    const s = store();
    addTheme(s, "SIFT-1", { label: "tool-retry loop on search_kb", state: "regressed" });
    addWindow(s, "v1", [["SIFT-1", 1], [null, 9]]);
    addWindow(s, "v2", [["SIFT-1", 5], [null, 5]]);
    const f = findingFor(computeDeltas(s, AGENT, FACET, "v1", "v2", { sigma: 2 }), "SIFT-1");
    assert.equal(f.label, "tool-retry loop on search_kb");
    assert.equal(f.state, "regressed" as ThemeState);
  });

  test("orders by severity first, then by size of change", () => {
    const s = store();
    addTheme(s, "REG", { state: "resolved" });
    addTheme(s, "BIG");
    addTheme(s, "SMALL");
    addWindow(s, "v1", [["REG", 0], ["BIG", 5], ["SMALL", 40], [null, 55]]);
    addWindow(s, "v2", [["REG", 5], ["BIG", 40], ["SMALL", 38], [null, 17]]);

    const order = computeDeltas(s, AGENT, FACET, "v1", "v2", { sigma: 2 }).findings.map((f) => f.themeId);
    assert.equal(order[0], "REG", "regressions lead the list");
    assert.ok(order.indexOf("BIG") < order.indexOf("SMALL"));
  });

  test("an assignment referencing a deleted theme does not crash the report", () => {
    const s = store();
    addWindow(s, "v1", [["GHOST", 5], [null, 5]]);
    addWindow(s, "v2", [["GHOST", 8], [null, 2]]);
    const report = computeDeltas(s, AGENT, FACET, "v1", "v2", { sigma: 2 });
    assert.deepEqual(report.findings, []);
  });

  test("unknown windows produce an empty report rather than an error", () => {
    const s = store();
    addTheme(s, "SIFT-1");
    addWindow(s, "v1", [["SIFT-1", 5]]);
    const report = computeDeltas(s, AGENT, FACET, "nope-1", "nope-2", { sigma: 2 });
    assert.deepEqual(report.findings, []);
    assert.equal(report.toTotal, 0);
  });

  test("comparing a window against itself shows no change", () => {
    const s = store();
    addTheme(s, "SIFT-1");
    addWindow(s, "v1", [["SIFT-1", 5], [null, 5]]);
    const f = findingFor(computeDeltas(s, AGENT, FACET, "v1", "v1", { sigma: 2 }), "SIFT-1");
    assert.equal(f.delta, 0);
    assert.equal(f.severity, "info");
  });
});

describe("themeSeries", () => {
  test("returns each theme's share in every window, zeros included", () => {
    const s = store();
    addTheme(s, "SIFT-1");
    addTheme(s, "SIFT-2");
    addWindow(s, "v1", [["SIFT-1", 5], [null, 5]]);
    addWindow(s, "v2", [["SIFT-1", 2], ["SIFT-2", 8]]);

    const series = themeSeries(s, AGENT, FACET);
    assert.deepEqual(series.windows, ["v1", "v2"]);
    assert.deepEqual(series.byTheme.get("SIFT-1")!.map((p) => p.share), [0.5, 0.2]);
    // a theme absent from a window is 0, not missing — sparklines need the gap
    assert.deepEqual(series.byTheme.get("SIFT-2")!.map((p) => p.share), [0, 0.8]);
    assert.deepEqual(series.byTheme.get("SIFT-2")!.map((p) => p.count), [0, 8]);
  });

  test("includes the residual pile as its own series", () => {
    const s = store();
    addTheme(s, "SIFT-1");
    addWindow(s, "v1", [["SIFT-1", 9], [null, 1]]);
    const series = themeSeries(s, AGENT, FACET);
    assert.deepEqual(series.residual.map((p) => p.share), [0.1]);
  });

  test("an empty facet yields empty series rather than throwing", () => {
    const series = themeSeries(store(), AGENT, "nothing");
    assert.deepEqual(series.windows, []);
    assert.equal(series.byTheme.size, 0);
  });
});
