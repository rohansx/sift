import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { AnthropicSummarizer, OpenAiSummarizer, HttpLabeler, clipTrace, parseFacetJson, createSummarizer, createLabeler } from "../src/facets/summarize.ts";
import { HashEmbedder, OpenAICompatEmbedder, createEmbedder } from "../src/embed/index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { cosine, norm } from "../src/cluster/vectors.ts";
import { KeywordSummarizer, ModeEmbedder, ScriptedSummarizer, StubLabeler } from "../src/testing/fakes.ts";
import { PARAPHRASE_BANKS, PARAPHRASE_CONCEPTS, ParaphraseSummarizer } from "../src/testing/paraphrase.ts";
import type { FacetDef, Trace } from "../src/types.ts";

const FACETS: FacetDef[] = [
  { name: "goal", instruction: "what the user wanted, one sentence" },
  { name: "behavior", instruction: "what the agent did, one sentence" },
];

const TRACE: Trace = {
  id: "t1",
  agentId: "support-bot",
  startedAt: "2026-07-01T00:00:00.000Z",
  text: "## chat\ninput: where is my refund\noutput: let me check",
  meta: {},
};

/** A fetch stub that records calls and replays scripted responses. */
function stubFetch(responses: Array<{ status?: number; body: unknown } | Error>) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  let i = 0;
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    const next = responses[Math.min(i, responses.length - 1)]!;
    i++;
    calls.push({
      url: String(url),
      init,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    if (next instanceof Error) throw next;
    const status = next.status ?? 200;
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls, get count() { return i; } };
}

const anthropicBody = (text: string) => ({ content: [{ type: "text", text }] });
const openAiBody = (text: string) => ({ choices: [{ message: { content: text } }] });

describe("parseFacetJson", () => {
  test("parses a bare JSON object", () => {
    assert.deepEqual(parseFacetJson('{"goal":"a","behavior":"b"}'), { goal: "a", behavior: "b" });
  });

  test("strips markdown fences models add despite being told not to", () => {
    assert.deepEqual(parseFacetJson('```json\n{"goal":"a"}\n```'), { goal: "a" });
  });

  test("recovers an object embedded in prose", () => {
    assert.deepEqual(parseFacetJson('Sure! Here you go:\n{"goal": "a"}\nHope that helps.'), { goal: "a" });
  });

  test("ignores non-string values rather than corrupting a summary", () => {
    assert.deepEqual(parseFacetJson('{"goal":"a","behavior":{"nested":1},"n":3}'), { goal: "a", n: "3" });
  });

  test("unparseable output throws with the raw text so failures are debuggable", () => {
    assert.throws(() => parseFacetJson("I refuse to answer"), /I refuse to answer/);
  });
});

describe("clipTrace", () => {
  test("leaves short traces alone", () => {
    assert.equal(clipTrace("short", 100), "short");
  });

  test("keeps the head and the tail, where the failure usually is", () => {
    const text = "HEAD" + "x".repeat(5000) + "TAIL";
    const clipped = clipTrace(text, 200);
    assert.ok(clipped.length < 400);
    assert.match(clipped, /^HEAD/);
    assert.match(clipped, /TAIL$/);
    assert.match(clipped, /truncated/);
  });
});

describe("AnthropicSummarizer", () => {
  test("returns one summary per facet and posts to the messages API", async () => {
    const fetchStub = stubFetch([{ body: anthropicBody('{"goal":"wants a refund","behavior":"checked the order"}') }]);
    const s = new AnthropicSummarizer({ ...DEFAULT_CONFIG.llm, apiKey: "sk-test" }, { fetchImpl: fetchStub.impl });

    const out = await s.summarize(TRACE, FACETS);
    assert.deepEqual(out, [
      { traceId: "t1", facet: "goal", summary: "wants a refund" },
      { traceId: "t1", facet: "behavior", summary: "checked the order" },
    ]);

    const call = fetchStub.calls[0]!;
    assert.match(call.url, /\/v1\/messages$/);
    assert.equal((call.init.headers as Record<string, string>)["x-api-key"], "sk-test");
    assert.equal((call.init.headers as Record<string, string>)["anthropic-version"], "2023-06-01");
  });

  test("sends the facet instructions and the trace text", async () => {
    const fetchStub = stubFetch([{ body: anthropicBody('{"goal":"g","behavior":"b"}') }]);
    await new AnthropicSummarizer(DEFAULT_CONFIG.llm, { fetchImpl: fetchStub.impl }).summarize(TRACE, FACETS);
    const prompt = JSON.stringify(fetchStub.calls[0]!.body);
    assert.match(prompt, /what the user wanted/);
    assert.match(prompt, /where is my refund/);
    // the privacy posture starts here: the summarizer is told to drop identifiers
    assert.match(prompt, /identifier/i);
  });

  test("a facet the model omitted becomes 'unclear' rather than a missing row", async () => {
    const fetchStub = stubFetch([{ body: anthropicBody('{"goal":"only this one"}') }]);
    const out = await new AnthropicSummarizer(DEFAULT_CONFIG.llm, { fetchImpl: fetchStub.impl }).summarize(TRACE, FACETS);
    assert.equal(out[1]!.summary, "unclear");
  });

  test("retries on 429 and on 5xx, then succeeds", async () => {
    const fetchStub = stubFetch([
      { status: 429, body: { error: "slow down" } },
      { status: 503, body: { error: "upstream" } },
      { body: anthropicBody('{"goal":"g","behavior":"b"}') },
    ]);
    const slept: number[] = [];
    const s = new AnthropicSummarizer(DEFAULT_CONFIG.llm, {
      fetchImpl: fetchStub.impl,
      sleep: async (ms) => void slept.push(ms),
    });
    const out = await s.summarize(TRACE, FACETS);
    assert.equal(out[0]!.summary, "g");
    assert.equal(fetchStub.count, 3);
    assert.deepEqual(slept.length, 2);
    assert.ok(slept[1]! > slept[0]!, "backoff should grow");
  });

  test("does not retry a 400 — a bad request will stay bad", async () => {
    const fetchStub = stubFetch([{ status: 400, body: { error: "bad model" } }]);
    const s = new AnthropicSummarizer(DEFAULT_CONFIG.llm, { fetchImpl: fetchStub.impl, sleep: async () => {} });
    await assert.rejects(() => s.summarize(TRACE, FACETS), /400/);
    assert.equal(fetchStub.count, 1);
  });

  test("gives up after maxRetries and includes the status and body", async () => {
    const fetchStub = stubFetch([{ status: 500, body: "boom" }]);
    const s = new AnthropicSummarizer(DEFAULT_CONFIG.llm, { fetchImpl: fetchStub.impl, maxRetries: 2, sleep: async () => {} });
    await assert.rejects(() => s.summarize(TRACE, FACETS), /500.*boom/s);
    assert.equal(fetchStub.count, 3, "initial attempt plus 2 retries");
  });

  test("retries a transport error too", async () => {
    const fetchStub = stubFetch([new Error("ECONNRESET"), { body: anthropicBody('{"goal":"g","behavior":"b"}') }]);
    const s = new AnthropicSummarizer(DEFAULT_CONFIG.llm, { fetchImpl: fetchStub.impl, sleep: async () => {} });
    assert.equal((await s.summarize(TRACE, FACETS))[0]!.summary, "g");
  });
});

describe("OpenAiSummarizer", () => {
  test("posts to chat/completions with a bearer token", async () => {
    const fetchStub = stubFetch([{ body: openAiBody('{"goal":"g","behavior":"b"}') }]);
    const s = new OpenAiSummarizer(
      { ...DEFAULT_CONFIG.llm, provider: "openai", baseUrl: "http://localhost:11434", apiKey: "k" },
      { fetchImpl: fetchStub.impl },
    );
    const out = await s.summarize(TRACE, FACETS);
    assert.equal(out[0]!.summary, "g");
    assert.match(fetchStub.calls[0]!.url, /\/v1\/chat\/completions$/);
    assert.equal((fetchStub.calls[0]!.init.headers as Record<string, string>)["authorization"], "Bearer k");
  });
});

describe("HttpLabeler", () => {
  test("turns member summaries into a label and description", async () => {
    const fetchStub = stubFetch([
      { body: anthropicBody('{"label":"tool retry loop on search_kb","description":"the agent retries after timeouts"}') },
    ]);
    const labeler = new HttpLabeler(DEFAULT_CONFIG.llm, { fetchImpl: fetchStub.impl });
    const out = await labeler.label("behavior", ["retried search_kb", "retried search_kb again"]);
    assert.equal(out.label, "tool retry loop on search_kb");
    assert.match(out.description, /retries/);
    assert.match(JSON.stringify(fetchStub.calls[0]!.body), /retried search_kb/);
  });

  test("samples large clusters instead of sending thousands of lines", async () => {
    const fetchStub = stubFetch([{ body: anthropicBody('{"label":"l","description":"d"}') }]);
    const labeler = new HttpLabeler(DEFAULT_CONFIG.llm, { fetchImpl: fetchStub.impl, labelSampleSize: 5 });
    await labeler.label("behavior", Array.from({ length: 500 }, (_, i) => `summary number ${i}`));
    const prompt = JSON.stringify(fetchStub.calls[0]!.body);
    assert.ok(!prompt.includes("summary number 400"), "should not send the whole cluster");
  });

  test("a label that comes back empty falls back to something usable", async () => {
    const fetchStub = stubFetch([{ body: anthropicBody('{"label":"","description":""}') }]);
    const labeler = new HttpLabeler(DEFAULT_CONFIG.llm, { fetchImpl: fetchStub.impl });
    const out = await labeler.label("behavior", ["the agent retried the search tool"]);
    assert.ok(out.label.length > 0);
  });
});

describe("OpenAICompatEmbedder", () => {
  test("returns vectors in request order even when the API reorders them", async () => {
    const fetchStub = stubFetch([
      { body: { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] } },
    ]);
    const e = new OpenAICompatEmbedder({ ...DEFAULT_CONFIG.embeddings, dimensions: 2 }, { fetchImpl: fetchStub.impl });
    assert.deepEqual(await e.embed(["a", "b"]), [[1, 0], [0, 1]]);
  });

  test("batches long inputs and concatenates in order", async () => {
    const responses = [0, 1].map((batch) => ({
      body: { data: Array.from({ length: batch === 0 ? 2 : 1 }, (_, i) => ({ index: i, embedding: [batch, i] })) },
    }));
    const fetchStub = stubFetch(responses);
    const e = new OpenAICompatEmbedder({ ...DEFAULT_CONFIG.embeddings, dimensions: 2 }, { fetchImpl: fetchStub.impl, batchSize: 2 });
    assert.deepEqual(await e.embed(["a", "b", "c"]), [[0, 0], [0, 1], [1, 0]]);
    assert.equal(fetchStub.count, 2);
  });

  test("embedding nothing makes no HTTP call", async () => {
    const fetchStub = stubFetch([{ body: { data: [] } }]);
    const e = new OpenAICompatEmbedder(DEFAULT_CONFIG.embeddings, { fetchImpl: fetchStub.impl });
    assert.deepEqual(await e.embed([]), []);
    assert.equal(fetchStub.count, 0);
  });

  test("a dimension mismatch against the configured value is an error", async () => {
    const fetchStub = stubFetch([{ body: { data: [{ index: 0, embedding: [1, 2, 3] }] } }]);
    const e = new OpenAICompatEmbedder({ ...DEFAULT_CONFIG.embeddings, dimensions: 2 }, { fetchImpl: fetchStub.impl });
    await assert.rejects(() => e.embed(["a"]), /dimension/i);
  });
});

describe("HashEmbedder", () => {
  const e = new HashEmbedder(64);

  test("is deterministic across instances", async () => {
    const a = await e.embed(["tool retry loop on search_kb"]);
    const b = await new HashEmbedder(64).embed(["tool retry loop on search_kb"]);
    assert.deepEqual(a, b);
  });

  test("produces unit vectors of the configured width", async () => {
    const [v] = await e.embed(["some agent behavior"]);
    assert.equal(v!.length, 64);
    assert.ok(Math.abs(norm(v!) - 1) < 1e-9);
  });

  test("near-duplicate phrasings land closer than unrelated ones", async () => {
    // The most this shows: text sharing nearly every content word groups. These
    // two strings differ by "the" and "after"/"following". The next test is the
    // other half of the picture.
    const [retryA, retryB, thanks] = await e.embed([
      "the agent retried the search_kb tool after a timeout",
      "agent retried search_kb tool following a timeout",
      "the user thanked the agent and ended the conversation",
    ]);
    assert.ok(cosine(retryA!, retryB!) > cosine(retryA!, thanks!), "similar text should be nearer");
    assert.ok(cosine(retryA!, retryB!) > 0.5);
  });

  test("a paraphrase with no shared content words is invisible to it", async () => {
    // The ceiling on the offline default, stated as a number. Over the
    // paraphrase corpus it scores two ways of describing one behavior at 0.111
    // and two unrelated behaviors at 0.099 — a 0.012 gap, where the clusterer
    // needs 0.65 to merge anything. See test/paraphrase.test.ts for what that
    // costs end to end (one theme per phrasing, 21% recall).
    const corpus = PARAPHRASE_CONCEPTS.flatMap((concept) =>
      PARAPHRASE_BANKS[concept]!.map((t) => ({ concept, text: t.replace("{tool}", "search_kb").replace("{n}", "4") })),
    );
    const vectors = await new HashEmbedder(512).embed(corpus.map((c) => c.text));

    const pairs = { intra: [0, 0], inter: [0, 0] };
    for (let i = 0; i < corpus.length; i++) {
      for (let j = i + 1; j < corpus.length; j++) {
        const bucket = corpus[i]!.concept === corpus[j]!.concept ? pairs.intra : pairs.inter;
        bucket[0]! += cosine(vectors[i]!, vectors[j]!);
        bucket[1]!++;
      }
    }
    const intra = pairs.intra[0]! / pairs.intra[1]!;
    const inter = pairs.inter[0]! / pairs.inter[1]!;
    assert.ok(intra < 0.2, `mean intra-concept cosine was ${intra.toFixed(3)} — has HashEmbedder become semantic?`);
    assert.ok(intra - inter < 0.1, `intra beat inter by ${(intra - inter).toFixed(3)}; the comment above is now stale`);
  });

  test("empty text yields a zero vector rather than NaN", async () => {
    const [v] = await e.embed([""]);
    assert.equal(norm(v!), 0);
  });
});

describe("ParaphraseSummarizer", () => {
  const trace: Trace = {
    ...TRACE,
    text: "## chat\ninput: where is the policy doc\n## execute_tool\ntool: search_kb\nERROR: TimeoutError\n## execute_tool\ntool: search_kb\nERROR: TimeoutError",
  };

  test("varies its wording but never for the same trace", async () => {
    // Seeded from the trace id, not from call order: a pipeline that summarizes
    // in a different order must not produce different summaries.
    const s = new ParaphraseSummarizer({ seed: 3 });
    const [first] = await s.summarize(trace, FACETS);
    const [again] = await s.summarize(trace, FACETS);
    assert.equal(first!.summary, again!.summary);
    assert.equal(s.conceptOf(first!.summary), "retry-loop");

    const lines = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const [line] = await s.summarize({ ...trace, id: `t${i}` }, FACETS);
      lines.add(line!.summary);
      assert.equal(s.conceptOf(line!.summary), "retry-loop", "one behavior must stay one concept however it is worded");
    }
    assert.ok(lines.size >= 3, `eight traces of one behavior produced ${lines.size} wordings`);
  });
});

describe("provider factories", () => {
  test("build the provider named in config", () => {
    assert.ok(createEmbedder({ ...DEFAULT_CONFIG.embeddings, provider: "hash" }) instanceof HashEmbedder);
    assert.ok(createEmbedder({ ...DEFAULT_CONFIG.embeddings, provider: "openai" }) instanceof OpenAICompatEmbedder);
    assert.ok(createSummarizer({ ...DEFAULT_CONFIG.llm, provider: "anthropic" }) instanceof AnthropicSummarizer);
    assert.ok(createSummarizer({ ...DEFAULT_CONFIG.llm, provider: "openai" }) instanceof OpenAiSummarizer);
    assert.ok(createLabeler({ ...DEFAULT_CONFIG.llm, provider: "anthropic" }) instanceof HttpLabeler);
  });

  test("the hash embedder honours the configured dimensions", () => {
    assert.equal(createEmbedder({ ...DEFAULT_CONFIG.embeddings, provider: "hash", dimensions: 32 }).dimensions, 32);
  });

  test("an HTTP provider without an API key fails loudly at construction", () => {
    assert.throws(
      () => createSummarizer({ ...DEFAULT_CONFIG.llm, provider: "anthropic", apiKey: undefined }, { requireKey: true }),
      /SIFT_LLM_API_KEY/,
    );
  });
});

describe("offline fakes", () => {
  test("KeywordSummarizer derives facet lines from trace text", async () => {
    const s = new KeywordSummarizer();
    const out = await s.summarize({ ...TRACE, text: "## chat\ntool: search_kb\nERROR: TimeoutError: timed out" }, FACETS);
    assert.equal(out.length, 2);
    assert.ok(out.every((x) => x.summary.length > 0));
    // same trace, same summaries — tests must not drift run to run
    const again = await s.summarize({ ...TRACE, text: "## chat\ntool: search_kb\nERROR: TimeoutError: timed out" }, FACETS);
    assert.deepEqual(out, again);
  });

  test("ScriptedSummarizer replays exactly what a test dictates", async () => {
    const s = new ScriptedSummarizer({ t1: { goal: "wants a refund", behavior: "deflected" } });
    const out = await s.summarize(TRACE, FACETS);
    assert.deepEqual(out.map((o) => o.summary), ["wants a refund", "deflected"]);
  });

  test("ScriptedSummarizer refuses to invent a summary for an unscripted trace", async () => {
    const s = new ScriptedSummarizer({});
    await assert.rejects(() => s.summarize(TRACE, FACETS), /t1/);
  });

  test("ModeEmbedder plants known cluster structure", async () => {
    const e = new ModeEmbedder({ dimensions: 8, modes: ["retry", "refund"], seed: 1, noise: 0.05 });
    const [a, b, c] = await e.embed(["retry one", "retry two", "refund one"]);
    assert.ok(cosine(a!, b!) > 0.9, "same mode should be tight");
    assert.ok(cosine(a!, c!) < 0.5, "different modes should be far apart");
  });

  test("StubLabeler names a cluster by its most common summary", async () => {
    const out = await new StubLabeler().label("behavior", ["retry loop", "retry loop", "something else"]);
    assert.equal(out.label, "retry loop");
  });
});
