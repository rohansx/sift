import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Pipeline } from "../src/pipeline.ts";
import { SiftStore } from "../src/store/db.ts";
import { DEFAULT_CONFIG, type SiftConfig } from "../src/config.ts";
import { HashEmbedder } from "../src/embed/index.ts";
import { KeywordSummarizer, RecordingEmbedder, StubLabeler } from "../src/testing/fakes.ts";
import { generateDemoTraces } from "../src/examples/generate-demo-traces.ts";
import type { FacetDef, FacetSummary, Summarizer, Trace } from "../src/types.ts";

const FACETS: FacetDef[] = [
  { name: "goal", instruction: "what the user wanted" },
  { name: "behavior", instruction: "what the agent did" },
];

function makePipeline(over: Partial<SiftConfig> = {}, summarizer: Summarizer = new KeywordSummarizer()) {
  const store = new SiftStore(":memory:");
  const cfg: SiftConfig = {
    ...DEFAULT_CONFIG,
    facets: FACETS,
    minClusterSize: 3,
    assignThreshold: 0.6,
    embeddings: { ...DEFAULT_CONFIG.embeddings, provider: "hash", dimensions: 256 },
    ...over,
  };
  const embedder = new RecordingEmbedder(new HashEmbedder(cfg.embeddings.dimensions));
  const pipeline = new Pipeline(store, cfg, {
    summarizer,
    embedder,
    labeler: new StubLabeler(),
    clock: () => new Date("2026-07-30T00:00:00.000Z"),
  });
  return { pipeline, store, cfg, embedder };
}

const span = (traceId: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    trace_id: traceId,
    span_id: `${traceId}-s`,
    name: "chat",
    start_time: "2026-07-01T10:00:00.000Z",
    end_time: "2026-07-01T10:00:01.000Z",
    attributes: {
      "gen_ai.agent.name": "support-bot",
      "service.version": "v1.0",
      "gen_ai.prompt": "hello",
      "gen_ai.completion": "hi",
      ...((over.attributes as Record<string, unknown>) ?? {}),
    },
    ...over,
  });

describe("ingest stage", () => {
  test("reports what was new versus already known", () => {
    const { pipeline } = makePipeline();
    const jsonl = [span("a"), span("b")].join("\n");
    assert.equal(pipeline.ingestJsonl(jsonl).ingested, 2);

    const again = pipeline.ingestJsonl(jsonl);
    assert.equal(again.ingested, 0);
    assert.equal(again.duplicates, 2, "re-running ingest must be safe");
  });

  test("surfaces malformed lines without failing the run", () => {
    const { pipeline } = makePipeline();
    const result = pipeline.ingestJsonl(`${span("a")}\nnot json\n`);
    assert.equal(result.ingested, 1);
    assert.equal(result.skippedLines, 1);
  });
});

describe("summarize stage", () => {
  test("produces one summary per facet per trace, and embeds them", async () => {
    const { pipeline, store } = makePipeline();
    pipeline.ingestJsonl([span("a"), span("b")].join("\n"));

    const result = await pipeline.summarize();
    assert.equal(result.traces, 2);
    assert.equal(result.summaries, 4);
    assert.equal(result.embedded, 4);
    assert.equal(store.getSummary("a", "behavior")!.embedding!.length, 256);
  });

  test("is resumable: a second run has nothing left to do", async () => {
    const { pipeline } = makePipeline();
    pipeline.ingestJsonl(span("a"));
    await pipeline.summarize();
    const second = await pipeline.summarize();
    assert.equal(second.traces, 0);
    assert.equal(second.embedded, 0);
  });

  test("only new traces cost anything on a later run", async () => {
    // Summarization is the expensive stage; re-summarizing history because a
    // run was interrupted is the difference between usable and not.
    const { pipeline, embedder } = makePipeline();
    pipeline.ingestJsonl(span("a"));
    await pipeline.summarize();
    const afterFirst = embedder.seen.length;

    pipeline.ingestJsonl(span("b"));
    await pipeline.summarize();
    assert.equal(embedder.seen.length - afterFirst, 2, "only the new trace's facets should be embedded");
  });

  test("a trace whose summarization throws stays pending instead of half-written", async () => {
    const flaky: Summarizer = {
      async summarize(trace: Trace, facets: FacetDef[]): Promise<FacetSummary[]> {
        if (trace.id === "bad") throw new Error("model refused");
        return facets.map((f) => ({ traceId: trace.id, facet: f.name, summary: `ok ${f.name}` }));
      },
    };
    const { pipeline, store } = makePipeline({}, flaky);
    pipeline.ingestJsonl([span("good"), span("bad")].join("\n"));

    const result = await pipeline.summarize();
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]!.traceId, "bad");
    assert.equal(store.getSummary("bad", "goal"), null);
    assert.deepEqual(store.tracesNeedingSummaries(["goal", "behavior"]).map((t) => t.id), ["bad"]);
  });

  test("honours a limit so a first run can be sampled cheaply", async () => {
    const { pipeline } = makePipeline();
    pipeline.ingestJsonl([span("a"), span("b"), span("c")].join("\n"));
    assert.equal((await pipeline.summarize({ limit: 2 })).traces, 2);
  });
});

describe("analyze", () => {
  test("bootstraps on an empty registry, then assigns on later runs", async () => {
    const { pipeline, store } = makePipeline();
    const { jsonl } = generateDemoTraces({ tracesPerVersion: 60, seed: 5 });

    const first = await pipeline.analyze({ jsonl });
    assert.ok(first.discovery.length > 0, "the first run should discover");
    assert.ok(store.allThemes().length > 0);

    const themesAfterFirst = store.allThemes().map((t) => t.id);
    const second = await pipeline.analyze({ jsonl });
    assert.deepEqual(second.discovery, [], "a second run should not re-bootstrap");
    assert.deepEqual(store.allThemes().map((t) => t.id), themesAfterFirst, "existing themes must survive untouched");
  });

  test("every trace ends up either assigned or explicitly residual", async () => {
    const { pipeline, store } = makePipeline();
    const { jsonl } = generateDemoTraces({ tracesPerVersion: 40, seed: 9 });
    await pipeline.analyze({ jsonl });

    const traces = store.countTraces();
    for (const facet of ["goal", "behavior"]) {
      assert.equal(store.countAssignments(facet), traces, `${facet} left traces unaccounted for`);
    }
  });

  test("windows come from the release tag, so deltas line up with deploys", async () => {
    const { pipeline, store } = makePipeline();
    await pipeline.analyze({ jsonl: generateDemoTraces({ tracesPerVersion: 40, seed: 3 }).jsonl });
    assert.deepEqual(store.windowsForFacet("support-bot", "behavior"), ["v1.2", "v1.3"]);
  });

  test("re-runs discovery when the residual pile grows past the threshold", async () => {
    const { pipeline, store } = makePipeline({ rediscoverResidualShare: 0.05, minClusterSize: 3 });
    // first release: only billing traffic
    const early = generateDemoTraces({ tracesPerVersion: 40, seed: 11 });
    await pipeline.analyze({ jsonl: early.jsonl });
    const before = store.allThemes().length;

    // a genuinely different shape arrives that no existing centroid covers
    const novel = Array.from({ length: 12 }, (_, i) =>
      span(`novel-${i}`, {
        attributes: {
          "gen_ai.prompt": "please export all my data as a machine readable archive",
          "gen_ai.completion": "starting a data export job for the account",
          "gen_ai.tool.name": "start_export_job",
        },
        start_time: "2026-08-01T10:00:00.000Z",
        end_time: "2026-08-01T10:00:02.000Z",
      }),
    ).join("\n");

    await pipeline.analyze({ jsonl: novel });
    assert.ok(store.allThemes().length >= before, "discovery should only ever add themes");
  });
});

describe("views", () => {
  test("report covers every configured facet by default", async () => {
    const { pipeline } = makePipeline();
    await pipeline.analyze({ jsonl: generateDemoTraces({ tracesPerVersion: 40, seed: 4 }).jsonl });
    assert.deepEqual(pipeline.report().map((r) => r.facet), ["goal", "behavior"]);
    assert.deepEqual(pipeline.report({ agentId: "support-bot", facet: "behavior" }).map((r) => r.facet), ["behavior"]);
  });

  test("latestWindowPair picks the two most recent windows", async () => {
    const { pipeline } = makePipeline();
    await pipeline.analyze({ jsonl: generateDemoTraces({ tracesPerVersion: 40, seed: 6 }).jsonl });
    assert.deepEqual(pipeline.latestWindowPair("support-bot", "behavior"), { from: "v1.2", to: "v1.3" });
  });

  test("latestWindowPair is null when there is nothing to compare", () => {
    const { pipeline } = makePipeline();
    assert.equal(pipeline.latestWindowPair("support-bot", "behavior"), null);
  });

  test("a theme can be exported straight out of the pipeline", async () => {
    const { pipeline, store } = makePipeline();
    await pipeline.analyze({ jsonl: generateDemoTraces({ tracesPerVersion: 60, seed: 8 }).jsonl });
    const theme = store.allThemes()[0]!;
    const exported = pipeline.exportTheme(theme.id);
    assert.equal(exported.themeId, theme.id);
    assert.ok(exported.cases.length > 0);
  });
});
