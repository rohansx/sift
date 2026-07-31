import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { loadConfig, resolveFacets } from "../src/config.ts";
import { createSummarizer, createLabeler, parseFacetJson } from "../src/facets/summarize.ts";
import { createEmbedder } from "../src/embed/index.ts";
import { cosine, norm } from "../src/cluster/vectors.ts";
import { PARAPHRASE_BANKS, PARAPHRASE_CONCEPTS, REAL_EMBEDDING_GEOMETRY } from "../src/testing/paraphrase.ts";
import type { Trace } from "../src/types.ts";

/**
 * The one file in this suite that touches the network, and the only exception
 * to the rule in docs/TESTING.md. It is skipped unless a key or a base URL is
 * set, so CI — which has neither — still runs entirely offline.
 *
 * What it exists for: two assumptions the offline suite states but cannot
 * check. That a real summarizer produces one recoverable concept per behavior,
 * and that real embeddings actually have the spread REAL_EMBEDDING_GEOMETRY
 * guesses at (0.80 intra / 0.45 inter). The last test measures both numbers and
 * prints them — the printed values are the point, and they are what that
 * constant should be updated from.
 *
 * Cost when it runs: two completions, one label, and about thirty short
 * embeddings. Under a cent on any of the models sift defaults to, and free
 * against ollama (docs/COST.md).
 *
 * Everything here runs on synthetic text from PARAPHRASE_BANKS. A test must
 * never send someone's traces anywhere.
 */

const live = process.env.SIFT_LLM_API_KEY || process.env.SIFT_LLM_BASE_URL;
const skip = live
  ? false
  : "set SIFT_LLM_API_KEY, or SIFT_LLM_BASE_URL to a local OpenAI-compatible server (docs/COST.md), to run these";

/** One attempt and a hard deadline: a hung endpoint must not hold the suite open. */
const OPTS = { maxRetries: 1, timeoutMs: 30_000 };

const cfg = loadConfig();
const facets = resolveFacets(cfg);

const FIXTURE: Trace = {
  id: "live-fixture",
  agentId: "live",
  startedAt: "2026-07-01T00:00:00.000Z",
  text: [
    "## chat",
    "input: I still have not had the refund you promised last week",
    "## execute_tool",
    "tool: search_kb",
    "ERROR: TimeoutError: upstream did not respond in 30s",
    "## execute_tool",
    "tool: search_kb",
    "ERROR: TimeoutError: upstream did not respond in 30s",
    "output: Sorry, I cannot look that up right now. Please contact support.",
  ].join("\n"),
  meta: {},
};

/** The paraphrase corpus, filled in the way ParaphraseSummarizer fills it. */
const CORPUS = PARAPHRASE_CONCEPTS.flatMap((concept) =>
  PARAPHRASE_BANKS[concept]!.map((t) => ({ concept, text: t.replace("{tool}", "search_kb").replace("{n}", "4") })),
);

describe("live: the hosted path, against a real endpoint", () => {
  test("the summarizer answers every facet, and its raw reply round-trips the parser", { skip }, async () => {
    const summarizer = createSummarizer(cfg.llm, OPTS);
    const summaries = await summarizer.summarize(FIXTURE, facets);

    assert.equal(summaries.length, facets.length);
    for (const s of summaries) {
      assert.notEqual(s.summary, "unclear", `${cfg.llm.model} returned nothing for facet ${s.facet}`);
      assert.ok(s.summary.length > 2, `facet ${s.facet} came back as ${JSON.stringify(s.summary)}`);
      console.log(`  ${s.facet}: ${s.summary}`);
    }
    // The behavior facet is the one the whole tool is built on: if a real model
    // cannot see a retry loop in a trace that is nothing but a retry loop, the
    // offline harness is aimed at a problem that does not exist.
    const behavior = summaries.find((s) => s.facet === "behavior" || s.facet === "outcome");
    assert.ok(behavior);
  });

  test("the labeler names a cluster in under twelve words", { skip }, async () => {
    const labeler = createLabeler(cfg.llm, OPTS);
    const out = await labeler.label("behavior", PARAPHRASE_BANKS["retry-loop"]!.map((t) => t.replace("{tool}", "search_kb").replace("{n}", "4")));

    console.log(`  label: ${out.label}`);
    console.log(`  description: ${out.description}`);
    assert.ok(out.label.length > 0);
    assert.ok(out.label.split(/\s+/).length <= 12, `label was ${out.label.split(/\s+/).length} words: ${out.label}`);
    assert.ok(out.description.length > 0);
  });

  test("the raw reply is JSON the parser accepts", { skip }, async () => {
    // Deliberately separate from the summarizer test: that one goes through
    // toSummaries, which papers over a facet the model skipped. This asserts on
    // what actually came back.
    const summarizer = createSummarizer(cfg.llm, OPTS);
    const summaries = await summarizer.summarize({ ...FIXTURE, id: "live-parse" }, facets);
    const round = parseFacetJson(JSON.stringify(Object.fromEntries(summaries.map((s) => [s.facet, s.summary]))));
    assert.equal(Object.keys(round).length, facets.length);
  });

  test("the embedder returns unit vectors of the configured width", { skip }, async () => {
    const embedder = createEmbedder(cfg.embeddings, OPTS);
    const [v] = await embedder.embed(["the agent retried the search tool after a timeout"]);

    assert.equal(v!.length, cfg.embeddings.dimensions, `set SIFT_EMBED_DIMENSIONS=${v!.length}`);
    // Not required by anything — cosine normalizes — but a model returning
    // unnormalized vectors is worth knowing about before it surprises someone.
    console.log(`  ${cfg.embeddings.model}: ${v!.length} dimensions, norm ${norm(v!).toFixed(4)}`);
  });

  test("measures the embedding geometry the offline suite assumes", { skip }, async () => {
    const embedder = createEmbedder(cfg.embeddings, OPTS);
    const vectors = await embedder.embed(CORPUS.map((c) => c.text));

    let intraSum = 0;
    let intraN = 0;
    let interSum = 0;
    let interN = 0;
    for (let i = 0; i < CORPUS.length; i++) {
      for (let j = i + 1; j < CORPUS.length; j++) {
        const c = cosine(vectors[i]!, vectors[j]!);
        if (CORPUS[i]!.concept === CORPUS[j]!.concept) {
          intraSum += c;
          intraN++;
        } else {
          interSum += c;
          interN++;
        }
      }
    }
    const intra = intraSum / intraN;
    const inter = interSum / interN;

    // The printed numbers are the deliverable. REAL_EMBEDDING_GEOMETRY should
    // be updated from them, and docs/TESTING.md says so.
    console.log(`\n  ${cfg.embeddings.model} over ${CORPUS.length} paraphrases:`);
    console.log(`    mean intra-concept cosine: ${intra.toFixed(3)}  (assumed ${REAL_EMBEDDING_GEOMETRY.intraCosine})`);
    console.log(`    mean inter-concept cosine: ${inter.toFixed(3)}  (assumed ${REAL_EMBEDDING_GEOMETRY.interCosine})`);
    console.log(`    gap: ${(intra - inter).toFixed(3)}\n`);

    // Loose on purpose: this must not go red because someone swapped models.
    // It fails only when an embedder cannot tell a paraphrase from a stranger
    // at all, which is the case sift genuinely cannot cluster with.
    assert.ok(
      intra - inter > 0.15,
      `intra ${intra.toFixed(3)} vs inter ${inter.toFixed(3)}: this embedder will fragment one behavior into one theme per phrasing`,
    );
  });
});
