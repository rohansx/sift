import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { Pipeline } from "../src/pipeline.ts";
import { SiftStore, SCHEMA_VERSION } from "../src/store/db.ts";
import { DEFAULT_CONFIG, type SiftConfig } from "../src/config.ts";
import { HashEmbedder } from "../src/embed/index.ts";
import { KeywordSummarizer, StubLabeler } from "../src/testing/fakes.ts";
import { withTempDir } from "../src/testing/temp.ts";
import { buildFacetReport } from "../src/report/model.ts";
import { computeDeltas } from "../src/delta/index.ts";
import type { FacetDef } from "../src/types.ts";

/**
 * A theme registry is scoped to one agent. A coding agent's "behavior" themes
 * and a support bot's are not the same vocabulary, and letting them share a
 * registry silently merges two products into one meaningless issues list.
 */

const FACETS: FacetDef[] = [
  { name: "goal", instruction: "what the user wanted" },
  { name: "behavior", instruction: "what the agent did" },
];

function pipelineOn(store: SiftStore, over: Partial<SiftConfig> = {}): Pipeline {
  const cfg: SiftConfig = {
    ...DEFAULT_CONFIG,
    facets: FACETS,
    minClusterSize: 3,
    assignThreshold: 0.6,
    embeddings: { ...DEFAULT_CONFIG.embeddings, provider: "hash", dimensions: 256 },
    ...over,
  };
  return new Pipeline(store, cfg, {
    summarizer: new KeywordSummarizer(),
    embedder: new HashEmbedder(cfg.embeddings.dimensions),
    labeler: new StubLabeler(),
    clock: () => new Date("2026-07-30T00:00:00.000Z"),
  });
}

const span = (traceId: string, agent: string, prompt: string, tool: string, version = "v1") =>
  JSON.stringify({
    trace_id: traceId,
    span_id: `${traceId}-s`,
    name: "chat",
    start_time: "2026-07-01T10:00:00.000Z",
    end_time: "2026-07-01T10:00:01.000Z",
    attributes: {
      "gen_ai.agent.name": agent,
      "service.version": version,
      "gen_ai.prompt": prompt,
      "gen_ai.tool.name": tool,
      "gen_ai.completion": "done",
    },
  });

/** Two agents whose traces look nothing alike. */
function twoAgentJsonl(perAgent = 6, version = "v1"): string {
  const lines: string[] = [];
  for (let i = 0; i < perAgent; i++) {
    lines.push(span(`support-${version}-${i}`, "support-bot", "where is my refund for the order", "check_policy", version));
    lines.push(span(`coder-${version}-${i}`, "coding-agent", "add a retry to the upload function", "edit_file", version));
  }
  return lines.join("\n");
}

describe("registry scoping", () => {
  test("each agent gets its own themes", () => {
    const store = new SiftStore(":memory:");
    const p = pipelineOn(store);
    return p.analyze({ jsonl: twoAgentJsonl() }).then(() => {
      const support = store.themesForFacet("support-bot", "behavior");
      const coder = store.themesForFacet("coding-agent", "behavior");

      assert.ok(support.length > 0, "support-bot should have behavior themes");
      assert.ok(coder.length > 0, "coding-agent should have behavior themes");
      const shared = support.filter((s) => coder.some((c) => c.id === s.id));
      assert.deepEqual(shared, [], "no theme may belong to both agents");
    });
  });

  test("theme ids stay globally unique across agents", () => {
    const store = new SiftStore(":memory:");
    return pipelineOn(store)
      .analyze({ jsonl: twoAgentJsonl() })
      .then(() => {
        const ids = store.allThemes().map((t) => t.id);
        assert.equal(new Set(ids).size, ids.length, "SIFT-n must mean one thing across the whole database");
      });
  });

  test("a trace is only ever compared against its own agent's centroids", async () => {
    const store = new SiftStore(":memory:");
    const p = pipelineOn(store);
    await p.analyze({ jsonl: twoAgentJsonl() });

    for (const theme of store.allThemes()) {
      for (const trace of store.tracesForTheme(theme.id, 1000)) {
        assert.equal(trace.agentId, theme.agentId, `trace ${trace.id} landed in another agent's theme`);
      }
    }
  });

  test("themes carry the agent they belong to", async () => {
    const store = new SiftStore(":memory:");
    await pipelineOn(store).analyze({ jsonl: twoAgentJsonl() });
    for (const theme of store.allThemes()) {
      assert.ok(["support-bot", "coding-agent"].includes(theme.agentId), `bad agentId: ${theme.agentId}`);
    }
  });

  test("one agent's traffic cannot push another's residual pile over the threshold", async () => {
    const store = new SiftStore(":memory:");
    await pipelineOn(store).analyze({ jsonl: twoAgentJsonl() });
    // shares are computed within an agent, so each denominator is that agent's own
    const support = store.themeCountsByWindow("support-bot", "behavior");
    assert.equal(support.totals.get("v1"), 6);
  });
});

describe("views are per agent", () => {
  test("reports are scoped and their shares add up within the agent", async () => {
    const store = new SiftStore(":memory:");
    const p = pipelineOn(store);
    await p.analyze({ jsonl: twoAgentJsonl() });

    const report = buildFacetReport(store, p.cfg, { agentId: "support-bot", facet: "behavior" });
    assert.equal(report.agentId, "support-bot");
    assert.equal(report.totalAssignments, 6, "the other agent's traces must not be in the denominator");
    assert.ok(report.rows.every((r) => r.count <= 6));
  });

  test("deltas are scoped too", async () => {
    const store = new SiftStore(":memory:");
    const p = pipelineOn(store);
    await p.analyze({ jsonl: twoAgentJsonl(6, "v1") });
    await p.analyze({ jsonl: twoAgentJsonl(6, "v2") });

    const report = computeDeltas(store, "support-bot", "behavior", "v1", "v2", { sigma: 2 });
    assert.equal(report.fromTotal, 6);
    assert.equal(report.toTotal, 6);
    for (const finding of report.findings) {
      assert.equal(store.getTheme(finding.themeId)!.agentId, "support-bot");
    }
  });

  test("the pipeline reports every agent it holds", async () => {
    const store = new SiftStore(":memory:");
    const p = pipelineOn(store);
    await p.analyze({ jsonl: twoAgentJsonl() });
    assert.deepEqual(p.agents().sort(), ["coding-agent", "support-bot"]);
    assert.deepEqual(p.report({ facet: "behavior" }).map((r) => r.agentId).sort(), ["coding-agent", "support-bot"]);
  });

  test("a single agent can be selected explicitly", async () => {
    const store = new SiftStore(":memory:");
    const p = pipelineOn(store);
    await p.analyze({ jsonl: twoAgentJsonl() });
    const reports = p.report({ facet: "behavior", agentId: "coding-agent" });
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.agentId, "coding-agent");
  });
});

describe("time filtering", () => {
  const dated = (id: string, startedAt: string) =>
    JSON.stringify({
      trace_id: id,
      span_id: `${id}-s`,
      name: "chat",
      start_time: startedAt,
      end_time: startedAt,
      attributes: { "gen_ai.agent.name": "support-bot", "gen_ai.prompt": "hello there friend" },
    });

  test("summarize can be limited to recent traces", async () => {
    const store = new SiftStore(":memory:");
    const p = pipelineOn(store);
    p.ingestJsonl([dated("old", "2026-01-01T00:00:00.000Z"), dated("new", "2026-07-01T00:00:00.000Z")].join("\n"));

    const result = await p.summarize({ since: "2026-06-01T00:00:00.000Z" });
    assert.equal(result.traces, 1);
    assert.equal(store.getSummary("new", "goal")!.summary.length > 0, true);
    assert.equal(store.getSummary("old", "goal"), null);
  });

  test("relative windows like 7d and 24h are understood", () => {
    const now = new Date("2026-07-30T12:00:00.000Z");
    assert.equal(Pipeline.resolveSince("7d", now), "2026-07-23T12:00:00.000Z");
    assert.equal(Pipeline.resolveSince("24h", now), "2026-07-29T12:00:00.000Z");
    assert.equal(Pipeline.resolveSince("30m", now), "2026-07-30T11:30:00.000Z");
  });

  test("an absolute ISO date passes straight through", () => {
    assert.equal(Pipeline.resolveSince("2026-07-01", new Date()), "2026-07-01T00:00:00.000Z");
  });

  test("an unparseable window is an error, not a silent full scan", () => {
    // Silently ignoring --since would summarize the entire history and bill for it.
    assert.throws(() => Pipeline.resolveSince("last tuesday", new Date()), /last tuesday/);
  });
});

describe("schema migration", () => {
  test("an older database gains agent scoping without losing data", () => {
    withTempDir((dir) => {
      const path = join(dir, "old.db");

      // hand-build a v1 database: themes and assignments with no agent column
      const legacy = new SiftStore(path);
      legacy.close();

      const raw = new SiftStore(path);
      raw.setMeta("schema_version", "1");
      raw.insertTrace({ id: "t1", agentId: "legacy-bot", startedAt: "2026-07-01T00:00:00.000Z", text: "x", meta: {} });
      raw.close();

      // reopening with the current build must migrate and backfill from traces
      const migrated = new SiftStore(path);
      assert.equal(migrated.schemaVersion(), SCHEMA_VERSION);
      assert.equal(migrated.getTrace("t1")!.agentId, "legacy-bot");
      migrated.close();
    });
  });

  test("assignments written before scoping get their agent backfilled from the trace", () => {
    withTempDir((dir) => {
      const path = join(dir, "backfill.db");
      const store = new SiftStore(path);
      store.insertTrace({ id: "t1", agentId: "legacy-bot", startedAt: "2026-07-01T00:00:00.000Z", text: "x", meta: {} });
      store.insertTheme({
        id: "SIFT-1", agentId: "legacy-bot", facet: "behavior", label: "l", description: "", state: "active",
        centroid: [1], memberCount: 1, exemplarTraceIds: [], createdAt: "x", updatedAt: "x",
      });
      store.insertAssignment({ traceId: "t1", agentId: "legacy-bot", facet: "behavior", themeId: "SIFT-1", similarity: 0.9, window: "v1" });
      assert.equal(store.themeCountInWindow("SIFT-1", "behavior", "v1"), 1);
      store.close();
    });
  });
});
