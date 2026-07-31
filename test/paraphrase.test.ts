import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import { Pipeline } from "../src/pipeline.ts";
import { SiftStore } from "../src/store/db.ts";
import { DEFAULT_CONFIG, type SiftConfig } from "../src/config.ts";
import { HashEmbedder } from "../src/embed/index.ts";
import { KeywordSummarizer, StubLabeler } from "../src/testing/fakes.ts";
import {
  ConceptEmbedder,
  PARAPHRASE_CONCEPTS,
  ParaphraseSummarizer,
  REAL_EMBEDDING_GEOMETRY,
} from "../src/testing/paraphrase.ts";
import { discoverClusters } from "../src/cluster/bootstrap.ts";
import { cosine } from "../src/cluster/vectors.ts";
import { generateDemoTraces, type DemoTraceRecord } from "../src/examples/generate-demo-traces.ts";
import { buildFacetReport } from "../src/report/model.ts";
import type { Embedder, FacetDef } from "../src/types.ts";

/**
 * Does clustering survive lexical variation?
 *
 * e2e.test.ts cannot answer that. Its summarizer emits a byte-identical line
 * for every instance of the planted failure, so its 95%-purity number is very
 * nearly a tautology: identical strings embed to identical vectors and group at
 * cosine 1.0 under any embedder whatsoever. Test 1 below pins that, so nobody
 * reads the e2e number as evidence about grouping.
 *
 * Everything here runs the *shipped* defaults — assignThreshold 0.72,
 * mergeThreshold 0.35, minClusterSize 5 — over the same 800 demo traces, with
 * a summarizer that says the same thing a different way every time.
 *
 * Two results, both stated as assertions:
 *   - with the offline HashEmbedder, clustering does NOT survive paraphrase.
 *     It produces one theme per phrasing (30 themes for 5 behaviors) and
 *     recovers 21% of the planted failure. It fragments; it never mixes.
 *   - at the geometry a real embedding model is assumed to have (0.80 intra /
 *     0.45 inter), it recovers exactly one theme per behavior at 100% purity
 *     and 100% recall.
 *
 * The second result is measured against an oracle (see src/testing/paraphrase.ts)
 * and is therefore conditional on that assumed geometry, which nothing offline
 * can verify.
 */

const TRACES_PER_VERSION = 400;
const BEHAVIORS = 5; // scenarios generateDemoTraces plants
const FACETS: FacetDef[] = [{ name: "behavior", instruction: "What did the agent do? One sentence." }];

interface Run {
  store: SiftStore;
  pipeline: Pipeline;
  cfg: SiftConfig;
  summarizer: ParaphraseSummarizer;
  records: Map<string, DemoTraceRecord>;
}

/** One full pipeline run over the demo corpus, paraphrased. ~0.6s each. */
async function runPipeline(embedderFor: (s: ParaphraseSummarizer) => Embedder, seed = 11): Promise<Run> {
  const demo = generateDemoTraces({ tracesPerVersion: TRACES_PER_VERSION, seed: 424242 });
  const store = new SiftStore(":memory:");
  const summarizer = new ParaphraseSummarizer({ seed });
  const cfg: SiftConfig = {
    ...DEFAULT_CONFIG,
    facets: FACETS,
    embeddings: { ...DEFAULT_CONFIG.embeddings, provider: "hash", dimensions: 512 },
  };
  const pipeline = new Pipeline(store, cfg, {
    summarizer,
    embedder: embedderFor(summarizer),
    labeler: new StubLabeler(),
    clock: () => new Date("2026-07-30T00:00:00.000Z"),
  });
  await pipeline.analyze({ jsonl: demo.jsonl });
  return { store, pipeline, cfg, summarizer, records: new Map(demo.records.map((r) => [r.traceId, r])) };
}

interface ThemeScore {
  themeId: string;
  size: number;
  /** the scenario most of its members really are, and how much of it they are */
  scenario: string;
  dominantShare: number;
  matching: number;
}

/** Ground-truth scoring of every theme. The pipeline never sees any of this. */
function scoreThemes(run: Run): ThemeScore[] {
  return run.store.themesForFacet("support-bot", "behavior").map((theme) => {
    const members = run.store.tracesForTheme(theme.id, 10_000);
    const counts = new Map<string, number>();
    for (const m of members) {
      const s = run.records.get(m.id)!.scenario;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const [scenario, matching] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    return { themeId: theme.id, size: members.length, scenario, dominantShare: matching / members.length, matching };
  });
}

/** The theme that captured the most of `scenario`, and what fraction that was. */
function bestFor(run: Run, scores: ThemeScore[], scenario: string) {
  const planted = [...run.records.values()].filter((r) => r.scenario === scenario).length;
  const best = scores.filter((s) => s.scenario === scenario).sort((a, b) => b.matching - a.matching)[0];
  return best ? { ...best, recall: best.matching / planted } : null;
}

function conceptEmbedder(s: ParaphraseSummarizer, geometry: { intraCosine: number; interCosine: number }): ConceptEmbedder {
  return new ConceptEmbedder({
    dimensions: 512,
    concepts: PARAPHRASE_CONCEPTS,
    conceptOf: (summary) => s.conceptOf(summary),
    ...geometry,
  });
}

let hashRun: Run;
let realRun: Run;
let degradedRun: Run;

before(async () => {
  hashRun = await runPipeline(() => new HashEmbedder(512));
  realRun = await runPipeline((s) => conceptEmbedder(s, REAL_EMBEDDING_GEOMETRY));
  degradedRun = await runPipeline((s) => conceptEmbedder(s, { intraCosine: 0.6, interCosine: 0.45 }));
});

describe("what the e2e purity number actually measures", () => {
  test("every instance of the planted failure gets the identical summary line", async () => {
    // So e2e's >95% purity says the pipeline stores and groups identical
    // strings correctly. It says nothing about grouping. If someone teaches
    // KeywordSummarizer to vary its phrasing, this fails — and the e2e claim
    // has to be re-earned rather than inherited.
    const keyword = new KeywordSummarizer();
    const lines = new Set<string>();
    let compared = 0;
    for (const [id, record] of hashRun.records) {
      if (record.scenario !== "search-retry-loop") continue;
      const [summary] = await keyword.summarize(hashRun.store.getTrace(id)!, FACETS);
      lines.add(summary!.summary);
      compared++;
    }
    assert.ok(compared > 50, `only ${compared} retry-loop traces to compare`);
    assert.equal(lines.size, 1, `KeywordSummarizer now varies its phrasing: ${[...lines].slice(0, 3).join(" | ")}`);
  });
});

describe("under paraphrase, the offline hash embedder does not cluster", () => {
  test("it produces roughly one theme per phrasing, not one per behavior", () => {
    const scores = scoreThemes(hashRun);
    const retry = bestFor(hashRun, scores, "search-retry-loop");

    // Measured: 30 themes — exactly the 5 behaviors x 6 phrasings in the bank.
    assert.ok(scores.length > BEHAVIORS * 2, `expected fragmentation, got ${scores.length} themes`);
    assert.ok(retry, "the retry loop vanished entirely");
    assert.ok(retry.recall < 0.5, `retry recall was ${(retry.recall * 100).toFixed(1)}%, better than measured 20.6%`);
  });

  test("but it fragments rather than contaminating: no theme mixes two behaviors", () => {
    // The direction that matters. A theme meaning two things gets resolved once
    // and the other half goes quiet unfixed; five themes meaning one thing each
    // is only annoying. Measured worst dominant share: 1.000.
    for (const s of scoreThemes(hashRun)) {
      assert.ok(s.dominantShare >= 0.95, `${s.themeId} mixes behaviors: ${(s.dominantShare * 100).toFixed(1)}% ${s.scenario}`);
    }
  });

  test("and the residual-share health check does not notice", () => {
    // Documents an absence. sift's one grouping-health metric measures traffic
    // that matched nothing, so a registry shattered into 30 near-duplicate
    // themes looks perfectly healthy. Measured: 0.0%.
    const report = buildFacetReport(hashRun.store, hashRun.cfg, { agentId: "support-bot", facet: "behavior", window: "v1.3" });
    assert.ok(report.residualShare < 0.05, `residual share was ${(report.residualShare * 100).toFixed(1)}%`);
  });
});

describe("at the embedding geometry a real model is assumed to have", () => {
  test("it recovers exactly one theme per planted behavior", () => {
    const scores = scoreThemes(realRun);
    assert.equal(scores.length, BEHAVIORS, `got ${scores.length} themes: ${scores.map((s) => `${s.scenario}:${s.size}`).join(", ")}`);
    assert.deepEqual(new Set(scores.map((s) => s.scenario)).size, BEHAVIORS, "two themes describe the same behavior");
  });

  test("the planted failure comes back clean and nearly whole", () => {
    // Purity is close to free in this fixture — all five concepts sit
    // equidistant at 0.45, so nothing is genuinely confusable. The adjacency
    // tests below are where purity is actually at risk. Recall is the real
    // result here: 100%, against 21% for the hash embedder on the same corpus.
    const retry = bestFor(realRun, scoreThemes(realRun), "search-retry-loop")!;
    assert.ok(retry.dominantShare > 0.95, `purity was ${(retry.dominantShare * 100).toFixed(1)}%`);
    assert.ok(retry.recall > 0.9, `recall was ${(retry.recall * 100).toFixed(1)}%`);

    const report = buildFacetReport(realRun.store, realRun.cfg, { agentId: "support-bot", facet: "behavior", window: "v1.3" });
    assert.ok(report.residualShare < 0.05, `residual share was ${(report.residualShare * 100).toFixed(1)}%`);
  });

  test("a resolved theme reopens when the behavior comes back, with room either side of assignThreshold", async () => {
    const retry = bestFor(realRun, scoreThemes(realRun), "search-retry-loop")!;
    const registry = realRun.pipeline.registryFor("support-bot");
    registry.resolve(retry.themeId, "fixed by adding backoff");

    // Not a paraphrase test, despite the second seed. The phrase bank is finite
    // and 800 traces exhaust it, so every wording this summarizer can produce is
    // already in the corpus and embeds to a vector already averaged into the
    // centroid — ConceptEmbedder seeds from the text, so an identical string is
    // an identical vector. What is load-bearing here is the lifecycle edge:
    // assigning to a resolved theme flips it to regressed. The two similarity
    // assertions below are the oracle's own 0.80/0.45 geometry read back, and
    // they are here to say where the shipped 0.72 threshold sits between them,
    // not to claim anything about real embeddings.
    const fresh = new ParaphraseSummarizer({ seed: 9090, concepts: realRun.summarizer.concepts });
    const traceId = [...realRun.records.values()].find((r) => r.scenario === "search-retry-loop")!.traceId;
    const trace = realRun.store.getTrace(traceId)!;
    const [summary] = await fresh.summarize(trace, FACETS);
    const embedder = conceptEmbedder(realRun.summarizer, REAL_EMBEDDING_GEOMETRY);
    const [vector] = await embedder.embed([summary!.summary]);
    const result = registry.assign({ ...summary!, traceId: `${traceId}-v14`, embedding: vector! }, "v1.4");

    assert.equal(result.themeId, retry.themeId, "the same behavior landed somewhere else");
    assert.deepEqual(result.transition, { themeId: retry.themeId, from: "resolved", to: "regressed" });
    // Measured 0.909 against the right theme, 0.507 against the nearest wrong
    // one — the oracle's stated spread, not evidence about a real embedder. The
    // shipped 0.72 sits between them with room on both sides; raise it past
    // ~0.85 or drop it below ~0.55 and this fails.
    assert.ok(result.similarity > 0.85, `similarity to its own theme was only ${result.similarity.toFixed(3)}`);
    const others = realRun.store
      .themesForFacet("support-bot", "behavior")
      .filter((t) => t.id !== retry.themeId)
      .map((t) => cosine(vector!, t.centroid));
    assert.ok(Math.max(...others) < 0.6, `a wrong theme scored ${Math.max(...others).toFixed(3)}`);
  });
});

describe("how it degrades when the embedder is worse than assumed", () => {
  test("it loses recall, not precision", () => {
    // intra 0.60 is below the 1 - mergeThreshold = 0.65 cut, so paraphrases of
    // one behavior stop merging. Measured: 33 themes, 17.6% recall, every one
    // of them still a single behavior.
    const scores = scoreThemes(degradedRun);
    const retry = bestFor(degradedRun, scores, "search-retry-loop")!;
    assert.ok(retry.recall < 0.5, `recall was ${(retry.recall * 100).toFixed(1)}%`);
    for (const s of scores) {
      assert.ok(s.dominantShare >= 0.95, `${s.themeId} mixes behaviors under degradation: ${s.dominantShare.toFixed(2)}`);
    }
  });
});

describe("two behaviors that read alike", () => {
  /** 100 summaries each of two concepts, straight through discovery. */
  function twoConcepts(interCosine: number) {
    const texts: string[] = [];
    for (let i = 0; i < 100; i++) texts.push(`alpha ${i}`, `beta ${i}`);
    const embedder = new ConceptEmbedder({
      dimensions: 128,
      concepts: ["alpha", "beta"],
      conceptOf: (t) => t.split(" ")[0]!,
      intraCosine: 0.8,
      interCosine,
      seed: 5,
    });
    return embedder.embed(texts).then((vectors) => {
      const result = discoverClusters(vectors, { minClusterSize: 5, mergeThreshold: DEFAULT_CONFIG.mergeThreshold });
      return result.clusters.map((c) => {
        const alpha = c.memberIndices.filter((i) => texts[i]!.startsWith("alpha")).length;
        return { size: c.memberIndices.length, purity: Math.max(alpha, c.memberIndices.length - alpha) / c.memberIndices.length };
      });
    });
  }

  test("stay apart while their summaries embed below the merge cut", async () => {
    const clusters = await twoConcepts(0.6);
    assert.equal(clusters.length, 2, `expected two themes, got ${clusters.length}`);
    for (const c of clusters) assert.equal(c.purity, 1);
  });

  test("and fuse into one meaningless theme above it", async () => {
    // The boundary sits at 1 - mergeThreshold = 0.65. Tested at 0.70 rather
    // than on the cut itself: 200 sampled vectors realize a mean cosine that
    // scatters by ±0.005 around the requested one, so a fixture asked for
    // exactly 0.65 lands either side depending on the seed, and the coin flip
    // would read as a clustering regression. Together the two tests still state
    // the contract — two behaviors separate iff their summaries embed below the
    // cut — with the sampling noise outside the assertion.
    const clusters = await twoConcepts(0.7);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0]!.size, 200);
    assert.equal(clusters[0]!.purity, 0.5);
  });
});
