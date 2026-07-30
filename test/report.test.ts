import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildFacetReport, sparkline } from "../src/report/model.ts";
import { renderIssuesList, renderDeltaTerminal } from "../src/report/terminal.ts";
import { renderThemeMarkdown, renderDeltaMarkdown } from "../src/report/markdown.ts";
import { computeDeltas } from "../src/delta/index.ts";
import { SiftStore } from "../src/store/db.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { Theme } from "../src/types.ts";

const FACET = "behavior";

function store(): SiftStore {
  return new SiftStore(":memory:");
}

function addTheme(s: SiftStore, id: string, over: Partial<Theme> = {}): void {
  s.insertTheme({
    id,
    facet: FACET,
    label: `label ${id}`,
    description: `description of ${id}`,
    state: "active",
    centroid: [1, 0],
    memberCount: 0,
    exemplarTraceIds: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  });
}

function addWindow(s: SiftStore, window: string, rows: Array<[string | null, number]>): void {
  let n = 0;
  for (const [themeId, count] of rows) {
    for (let i = 0; i < count; i++) {
      const traceId = `${window}-${themeId ?? "res"}-${n++}`;
      s.insertTrace({ id: traceId, agentId: "support-bot", version: window, startedAt: "2026-07-01T00:00:00.000Z", text: "", meta: {} });
      s.insertAssignment({ traceId, facet: FACET, themeId, similarity: themeId ? 0.9 : 0.1, window });
    }
  }
}

/** The README's example registry: a regression, a steady theme, a new one. */
function demoStore(): SiftStore {
  const s = store();
  addTheme(s, "SIFT-14", { label: "tool-retry loop on search_kb", state: "regressed", memberCount: 300 });
  addTheme(s, "SIFT-3", { label: "user asks for refund, agent deflects", memberCount: 200 });
  addTheme(s, "SIFT-21", { label: "context lost after long tool output", state: "new", memberCount: 41 });
  addWindow(s, "v1.2", [["SIFT-14", 2], ["SIFT-3", 8], [null, 90]]);
  addWindow(s, "v1.3", [["SIFT-14", 11], ["SIFT-3", 8], ["SIFT-21", 4], [null, 77]]);
  return s;
}

describe("sparkline", () => {
  test("renders one block per point", () => {
    assert.equal(sparkline([0, 0.5, 1]).length, 3);
  });

  test("scales to the series maximum", () => {
    const line = sparkline([0, 1]);
    assert.equal(line[0], "▁");
    assert.equal(line[1], "█");
  });

  test("a flat series is flat, not noise", () => {
    assert.equal(sparkline([0.4, 0.4, 0.4]), "▄▄▄");
  });

  test("an all-zero series renders as the baseline", () => {
    assert.equal(sparkline([0, 0, 0]), "▁▁▁");
  });

  test("an empty series renders as nothing", () => {
    assert.equal(sparkline([]), "");
  });
});

describe("buildFacetReport", () => {
  test("uses the latest window by default and computes shares there", () => {
    const report = buildFacetReport(demoStore(), DEFAULT_CONFIG, { facet: FACET });
    assert.equal(report.window, "v1.3");
    assert.equal(report.totalAssignments, 100);

    const retry = report.rows.find((r) => r.id === "SIFT-14")!;
    assert.equal(retry.count, 11);
    assert.ok(Math.abs(retry.share - 0.11) < 1e-9);
    assert.ok(Math.abs(retry.previousShare! - 0.02) < 1e-9);
    assert.ok(Math.abs(retry.delta! - 0.09) < 1e-9);
  });

  test("can report on an explicitly chosen window", () => {
    const report = buildFacetReport(demoStore(), DEFAULT_CONFIG, { facet: FACET, window: "v1.2" });
    assert.equal(report.window, "v1.2");
    assert.equal(report.rows.find((r) => r.id === "SIFT-14")!.count, 2);
    assert.equal(report.rows.find((r) => r.id === "SIFT-14")!.previousShare, undefined);
  });

  test("surfaces the residual pile and the threshold that would re-run discovery", () => {
    const report = buildFacetReport(demoStore(), DEFAULT_CONFIG, { facet: FACET });
    assert.equal(report.residualCount, 77);
    assert.ok(Math.abs(report.residualShare - 0.77) < 1e-9);
    assert.equal(report.rediscoverThreshold, DEFAULT_CONFIG.rediscoverResidualShare);
  });

  test("orders by current share, biggest first", () => {
    const report = buildFacetReport(demoStore(), DEFAULT_CONFIG, { facet: FACET });
    const shares = report.rows.map((r) => r.share);
    assert.deepEqual(shares, [...shares].sort((a, b) => b - a));
  });

  test("carries a sparkline of every window, not just the two being compared", () => {
    const report = buildFacetReport(demoStore(), DEFAULT_CONFIG, { facet: FACET });
    assert.deepEqual(report.windows, ["v1.2", "v1.3"]);
    assert.equal(report.rows.find((r) => r.id === "SIFT-21")!.history.length, 2);
  });

  test("includes themes that have no assignments at all, so a dead theme is visible", () => {
    const s = demoStore();
    addTheme(s, "SIFT-99", { label: "never seen again", state: "resolved" });
    const report = buildFacetReport(s, DEFAULT_CONFIG, { facet: FACET });
    const dead = report.rows.find((r) => r.id === "SIFT-99")!;
    assert.equal(dead.count, 0);
    assert.equal(dead.share, 0);
  });

  test("an empty facet reports zeroes rather than throwing", () => {
    const report = buildFacetReport(store(), DEFAULT_CONFIG, { facet: "nothing" });
    assert.deepEqual(report.rows, []);
    assert.equal(report.totalAssignments, 0);
    assert.equal(report.residualShare, 0);
    assert.equal(report.window, undefined);
  });
});

describe("issues list (terminal)", () => {
  const render = (over = {}) =>
    renderIssuesList(buildFacetReport(demoStore(), DEFAULT_CONFIG, { facet: FACET }), { agentId: "support-bot", ...over });

  test("leads with the agent, facet and trace count", () => {
    const out = render();
    assert.match(out, /THEMES/);
    assert.match(out, /support-bot/);
    assert.match(out, /behavior/);
    assert.match(out, /100/);
  });

  test("shows id, label and share for every theme", () => {
    const out = render();
    assert.match(out, /SIFT-14\s+tool-retry loop on search_kb/);
    assert.match(out, /11\.0%/);
    assert.match(out, /SIFT-21/);
  });

  test("marks direction of change and the previous share", () => {
    const out = render();
    const line = out.split("\n").find((l) => l.includes("SIFT-14"))!;
    assert.match(line, /↑/);
    assert.match(line, /was 2\.0%/);
  });

  test("calls out regressed and new themes by state", () => {
    const out = render();
    assert.match(out.split("\n").find((l) => l.includes("SIFT-14"))!, /REGRESSED/);
    assert.match(out.split("\n").find((l) => l.includes("SIFT-21"))!, /NEW/);
    assert.match(out.split("\n").find((l) => l.includes("SIFT-3"))!, /active/);
  });

  test("ends with the residual pile and when discovery will re-run", () => {
    const out = render();
    assert.match(out, /residual pile: 77 traces \(77\.0%\)/);
    assert.match(out, /8(\.0)?%/);
  });

  test("stays plain text unless colour is asked for", () => {
    // eslint-disable-next-line no-control-regex
    const ansi = /\[/;
    assert.ok(!ansi.test(render()), "default output must be pipe-safe");
    assert.ok(ansi.test(render({ color: true })));
  });

  test("truncates long lists and says how many were hidden", () => {
    const s = store();
    for (let i = 1; i <= 12; i++) addTheme(s, `SIFT-${i}`);
    addWindow(s, "v1", Array.from({ length: 12 }, (_, i) => [`SIFT-${i + 1}`, 12 - i] as [string, number]));
    const out = renderIssuesList(buildFacetReport(s, DEFAULT_CONFIG, { facet: FACET }), { limit: 5 });
    assert.equal(out.split("\n").filter((l) => l.includes("SIFT-")).length, 5);
    assert.match(out, /7 more/);
  });

  test("an empty registry says what to do next instead of showing an empty table", () => {
    const out = renderIssuesList(buildFacetReport(store(), DEFAULT_CONFIG, { facet: FACET }), {});
    assert.match(out, /no themes/i);
    assert.match(out, /bootstrap/i);
  });
});

describe("markdown", () => {
  test("renders one table per facet with state, label and counts", () => {
    const md = renderThemeMarkdown([buildFacetReport(demoStore(), DEFAULT_CONFIG, { facet: FACET })]);
    assert.match(md, /^# sift report/m);
    assert.match(md, /^## behavior/m);
    assert.match(md, /\| id \| state \| label \|/);
    assert.match(md, /\| SIFT-14 \|/);
    assert.match(md, /regressed/);
    assert.match(md, /tool-retry loop on search_kb/);
  });

  test("escapes pipes in labels so the table survives", () => {
    const s = store();
    addTheme(s, "SIFT-1", { label: "a | b" });
    addWindow(s, "v1", [["SIFT-1", 1]]);
    const md = renderThemeMarkdown([buildFacetReport(s, DEFAULT_CONFIG, { facet: FACET })]);
    const lines = md.split("\n");
    const header = lines.find((l) => l.startsWith("| id |"))!;
    const row = lines.find((l) => l.startsWith("| SIFT-1 "))!;
    const columnBreaks = (l: string) => (l.match(/(?<!\\)\|/g) ?? []).length;
    assert.match(row, /a \\\| b/, "the pipe in the label should be escaped");
    assert.equal(columnBreaks(row), columnBreaks(header), "an unescaped pipe would add a column");
  });

  test("notes the residual pile under the table", () => {
    const md = renderThemeMarkdown([buildFacetReport(demoStore(), DEFAULT_CONFIG, { facet: FACET })]);
    assert.match(md, /residual/i);
    assert.match(md, /77/);
  });

  test("an empty report still produces a valid document", () => {
    const md = renderThemeMarkdown([buildFacetReport(store(), DEFAULT_CONFIG, { facet: FACET })]);
    assert.match(md, /^# sift report/m);
    assert.match(md, /no themes/i);
  });
});

describe("delta rendering", () => {
  const report = () => computeDeltas(demoStore(), FACET, "v1.2", "v1.3", { sigma: 2 });

  test("markdown separates what needs attention from what is stable", () => {
    const md = renderDeltaMarkdown(report());
    assert.match(md, /# sift delta/);
    assert.match(md, /v1\.2.*v1\.3/);
    assert.match(md, /needs attention/i);
    assert.match(md, /SIFT-14/);
    assert.match(md, /REGRESSED/);
  });

  test("markdown shows both shares and the change", () => {
    const md = renderDeltaMarkdown(report());
    const line = md.split("\n").find((l) => l.includes("SIFT-14"))!;
    assert.match(line, /2\.0%/);
    assert.match(line, /11\.0%/);
    assert.match(line, /↑/);
  });

  test("terminal rendering carries the same facts", () => {
    const out = renderDeltaTerminal(report());
    assert.match(out, /SIFT-14/);
    assert.match(out, /11\.0%/);
    assert.match(out, /REGRESSED/);
  });

  test("a quiet window says so rather than printing an empty section", () => {
    const s = store();
    addTheme(s, "SIFT-1");
    addWindow(s, "v1", [["SIFT-1", 10]]);
    addWindow(s, "v2", [["SIFT-1", 10]]);
    const md = renderDeltaMarkdown(computeDeltas(s, FACET, "v1", "v2", { sigma: 2 }));
    assert.match(md, /nothing.*(changed|notable)/i);
  });

  test("flags a growing residual pile, which no theme delta would reveal", () => {
    // Coverage collapsing is itself a finding: the themes may all look stable
    // while an increasing share of traffic matches nothing at all.
    const s = store();
    addTheme(s, "SIFT-1");
    addWindow(s, "v1", [["SIFT-1", 95], [null, 5]]);
    addWindow(s, "v2", [["SIFT-1", 60], [null, 40]]);
    const md = renderDeltaMarkdown(computeDeltas(s, FACET, "v1", "v2", { sigma: 2 }));
    assert.match(md, /residual/i);
    assert.match(md, /40\.0%/);
  });
});
