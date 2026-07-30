import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import { Pipeline } from "../src/pipeline.ts";
import { SiftStore } from "../src/store/db.ts";
import { DEFAULT_CONFIG, FACET_PRESETS, type SiftConfig } from "../src/config.ts";
import { HashEmbedder } from "../src/embed/index.ts";
import { KeywordSummarizer, StubLabeler } from "../src/testing/fakes.ts";
import { generateDemoTraces, type DemoTraceRecord } from "../src/examples/generate-demo-traces.ts";
import { renderIssuesList } from "../src/report/terminal.ts";
import { buildFacetReport } from "../src/report/model.ts";

/**
 * The demo that sells it (OVERVIEW.md §6).
 *
 * Point sift at traffic it has been told nothing about and check that it finds
 * the failure mode planted in it, groups it cleanly, and flags the release that
 * made it worse. Ground truth lives only in the test — the pipeline sees spans,
 * never scenario names.
 *
 * Everything runs offline: rule-based summaries, local hash embeddings, a
 * stubbed labeler. That is the point. If the core could only be verified with
 * a hosted model, it would not be verified.
 */

const TRACES_PER_VERSION = 400;

interface World {
  store: SiftStore;
  pipeline: Pipeline;
  records: Map<string, DemoTraceRecord>;
}

let world: World;

/** The theme whose members are mostly `scenario`, plus how cleanly it captured it. */
function themeFor(w: World, facet: string, scenario: string) {
  const themes = w.store.themesForFacet(facet);
  const scored = themes.map((theme) => {
    const members = w.store.tracesForTheme(theme.id, 10_000);
    const matching = members.filter((t) => w.records.get(t.id)?.scenario === scenario).length;
    return {
      theme,
      size: members.length,
      matching,
      /** of the traces in this theme, how many are the scenario */
      purity: members.length === 0 ? 0 : matching / members.length,
    };
  });
  const total = [...w.records.values()].filter((r) => r.scenario === scenario).length;
  const best = scored.filter((s) => s.purity > 0.5).sort((a, b) => b.matching - a.matching)[0];
  return best ? { ...best, recall: best.matching / total } : null;
}

before(async () => {
  const demo = generateDemoTraces({ tracesPerVersion: TRACES_PER_VERSION, seed: 424242 });
  const store = new SiftStore(":memory:");
  const cfg: SiftConfig = {
    ...DEFAULT_CONFIG,
    preset: "chat",
    minClusterSize: 8,
    assignThreshold: 0.6,
    embeddings: { ...DEFAULT_CONFIG.embeddings, provider: "hash", dimensions: 512 },
  };
  const pipeline = new Pipeline(store, cfg, {
    summarizer: new KeywordSummarizer(),
    embedder: new HashEmbedder(512),
    labeler: new StubLabeler(),
    clock: () => new Date("2026-07-30T00:00:00.000Z"),
  });

  await pipeline.analyze({ jsonl: demo.jsonl });

  world = { store, pipeline, records: new Map(demo.records.map((r) => [r.traceId, r])) };
});

describe("the whole pipeline, offline", () => {
  test("ingests every trace and accounts for every one of them", () => {
    assert.equal(world.store.countTraces(), TRACES_PER_VERSION * 2);
    for (const facet of FACET_PRESETS.chat!.map((f) => f.name)) {
      assert.equal(
        world.store.countAssignments(facet),
        TRACES_PER_VERSION * 2,
        `${facet}: every trace must be assigned or explicitly residual`,
      );
    }
  });

  test("discovers themes without being told what to look for", () => {
    const behavior = world.store.themesForFacet("behavior");
    assert.ok(behavior.length >= 2, `expected several behavior themes, got ${behavior.length}`);
    assert.ok(behavior.every((t) => t.label.length > 0), "every theme must be labeled");
  });

  test("windows follow the release tag", () => {
    assert.deepEqual(world.store.windowsForFacet("behavior"), ["v1.2", "v1.3"]);
  });
});

describe("it finds the planted failure mode", () => {
  test("the retry loop becomes its own theme", () => {
    const hit = themeFor(world, "behavior", "search-retry-loop");
    assert.ok(hit, "sift did not isolate the planted retry-loop scenario at all");
    assert.match(hit.theme.label, /retry|search_kb/i, `theme label does not describe the failure: ${hit.theme.label}`);
  });

  test("the grouping is clean: almost nothing else lands in it", () => {
    // Precision matters more than recall here. A theme that mixes two
    // behaviors is worse than no theme: someone resolves it and the other
    // half of it goes quiet without being fixed.
    const hit = themeFor(world, "behavior", "search-retry-loop")!;
    assert.ok(hit.purity > 0.95, `theme purity was ${(hit.purity * 100).toFixed(1)}%`);
  });

  test("and it catches nearly all of them", () => {
    const hit = themeFor(world, "behavior", "search-retry-loop")!;
    assert.ok(hit.recall > 0.9, `theme recall was ${(hit.recall * 100).toFixed(1)}%`);
  });

  test("the theme's exemplars really are traces that timed out", () => {
    const hit = themeFor(world, "behavior", "search-retry-loop")!;
    assert.ok(hit.theme.exemplarTraceIds.length > 0);
    for (const id of hit.theme.exemplarTraceIds) {
      const trace = world.store.getTrace(id)!;
      assert.match(trace.text, /TimeoutError/, `exemplar ${id} is not an instance of the failure`);
    }
  });
});

describe("it flags the release that made it worse", () => {
  test("the retry loop's share jumps between v1.2 and v1.3", () => {
    const hit = themeFor(world, "behavior", "search-retry-loop")!;
    const stats = world.store.themeCountsByWindow("behavior");
    const shareIn = (w: string) => (stats.counts.get(w)?.get(hit.theme.id) ?? 0) / (stats.totals.get(w) ?? 1);

    assert.ok(shareIn("v1.2") < 0.05, `v1.2 share was ${shareIn("v1.2")}`);
    assert.ok(shareIn("v1.3") > 0.1, `v1.3 share was ${shareIn("v1.3")}`);
  });

  test("the delta report surfaces it above the noise", () => {
    const hit = themeFor(world, "behavior", "search-retry-loop")!;
    const report = world.pipeline.delta("behavior", "v1.2", "v1.3");
    const finding = report.findings.find((f) => f.themeId === hit.theme.id);

    assert.ok(finding, "the regression is missing from the delta report entirely");
    assert.notEqual(finding.severity, "info", "the regression was written off as noise");
    assert.ok(finding.delta > 0.08, `delta was only ${finding.delta}`);
  });

  test("it is at or near the top of what needs attention", () => {
    const hit = themeFor(world, "behavior", "search-retry-loop")!;
    const attention = world.pipeline
      .delta("behavior", "v1.2", "v1.3")
      .findings.filter((f) => f.severity !== "info");
    assert.ok(
      attention.slice(0, 2).some((f) => f.themeId === hit.theme.id),
      `retry loop was ranked ${attention.findIndex((f) => f.themeId === hit.theme.id) + 1} of ${attention.length}`,
    );
  });

  test("a theme nobody touched does not move", () => {
    const billing = themeFor(world, "goal", "billing-resolved");
    if (!billing) return; // goal-facet grouping is looser; nothing to assert
    const finding = world.pipeline.delta("goal", "v1.2", "v1.3").findings.find((f) => f.themeId === billing.theme.id);
    assert.ok(!finding || Math.abs(finding.delta) < 0.08, "steady traffic should not look like a change");
  });
});

describe("the loop closes", () => {
  test("the theme exports as a runnable regression test", () => {
    const hit = themeFor(world, "behavior", "search-retry-loop")!;
    const exported = world.pipeline.exportTheme(hit.theme.id);

    assert.ok(exported.cases.length > 0);
    assert.match(exported.scorerPrompt, /retry|search_kb/i);
    for (const c of exported.cases) {
      assert.ok(c.input.length > 0, "a fixture with no input cannot be replayed");
      assert.ok(!c.input.includes("TimeoutError"), "the fixture should be the request, not the failure");
      assert.equal(world.records.get(c.sourceTraceId)?.scenario, "search-retry-loop");
    }
  });

  test("resolving it, then seeing it again, is a regression", () => {
    const hit = themeFor(world, "behavior", "search-retry-loop")!;
    world.pipeline.registry.resolve(hit.theme.id, "fixed by adding backoff");
    assert.equal(world.store.getTheme(hit.theme.id)!.state, "resolved");

    // next week's traffic still contains it
    const summary = world.store.summariesForFacet("behavior").find((s) => world.records.get(s.traceId)?.scenario === "search-retry-loop")!;
    const result = world.pipeline.registry.assign(summary, "v1.4");

    assert.equal(result.themeId, hit.theme.id, "the same behavior must land on the same theme");
    assert.deepEqual(result.transition, { themeId: hit.theme.id, from: "resolved", to: "regressed" });
  });
});

describe("the report a human reads", () => {
  test("renders an issues list naming the regression", () => {
    const hit = themeFor(world, "behavior", "search-retry-loop")!;
    const output = renderIssuesList(buildFacetReport(world.store, world.pipeline.cfg, { facet: "behavior" }), {
      agentId: "support-bot",
    });

    assert.match(output, /THEMES/);
    assert.match(output, /support-bot/);
    assert.match(output, new RegExp(hit.theme.id));
    assert.match(output, /residual pile/);

    const line = output.split("\n").find((l) => l.includes(hit.theme.id))!;
    assert.match(line, /↑/, "the regression's line should show it rising");
  });

  test("the residual pile stays small enough that the themes mean something", () => {
    // If most traffic matches nothing, the issues list is decoration.
    const report = buildFacetReport(world.store, world.pipeline.cfg, { facet: "behavior" });
    assert.ok(report.residualShare < 0.25, `residual share was ${(report.residualShare * 100).toFixed(1)}%`);
  });
});
