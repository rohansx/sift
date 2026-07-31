import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { AnthropicSummarizer, OpenAiSummarizer, HttpLabeler, clipTrace, parseFacetJson, maxTokensFor, createSummarizer, createLabeler } from "../src/facets/summarize.ts";
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
function stubFetch(responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> } | Error>) {
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
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
      status,
      headers: next.headers ?? {},
    });
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

  test("a reasoning model's scratchpad does not poison the answer", () => {
    // The documented local recipe is ollama + qwen, which thinks out loud. The
    // old first-{-to-last-} slice spanned from a brace in the scratchpad to the
    // last brace of the reply and parsed as neither.
    const raw =
      "<think>The user wants JSON like {facet: value}. Let me check the outcome field {again}.</think>\n" +
      '{"goal":"a refund","behavior":"checked the order"}';
    assert.deepEqual(parseFacetJson(raw), { goal: "a refund", behavior: "checked the order" });
  });

  test("an unterminated <think> block is dropped rather than parsed", () => {
    assert.throws(() => parseFacetJson('<think>I should answer with {"goal": "something"} probably'), /could not parse/);
  });

  test("two objects: the first one that parses is the answer", () => {
    assert.deepEqual(parseFacetJson('{"goal":"a"}\nOr alternatively: {"goal":"b"}'), { goal: "a" });
  });

  test("a brace inside a summary string does not end the object", () => {
    assert.deepEqual(parseFacetJson('Here:\n{"goal":"fix the {placeholder} bug","behavior":"b"}\nDone.'), {
      goal: "fix the {placeholder} bug",
      behavior: "b",
    });
  });

  test("an object of nothing usable is skipped in favour of the real answer", () => {
    // Two things at once: an object whose only value is a nested object yields
    // nothing usable and must not be accepted (it would write a full set of
    // "unclear" rows and mark the trace done — a silent wrong answer), and the
    // nested `{"a":1}` inside it is part of its parent, not a rival candidate.
    assert.deepEqual(parseFacetJson('{"nested":{"a":1}}\n{"goal":"the real one"}'), { goal: "the real one" });
  });

  test("a reply with nothing usable anywhere still throws", () => {
    assert.throws(() => parseFacetJson('{"nested":{"a":1}}'), /could not parse/);
  });
});

describe("maxTokensFor", () => {
  test("scales with facet count, with a floor", () => {
    assert.equal(maxTokensFor(FACETS), 400);
    assert.equal(maxTokensFor(Array.from({ length: 8 }, (_, i) => ({ name: `f${i}`, instruction: "x" }))), 960);
  });

  test("the summarizer asks for the scaled budget, not a hardcoded 400", async () => {
    const facets = Array.from({ length: 8 }, (_, i) => ({ name: `f${i}`, instruction: "x" }));
    const fetchStub = stubFetch([{ body: anthropicBody('{"f0":"a"}') }]);
    await new AnthropicSummarizer(DEFAULT_CONFIG.llm, { fetchImpl: fetchStub.impl }).summarize(TRACE, facets);
    assert.equal(fetchStub.calls[0]!.body.max_tokens, 960);
  });

  test("llm.maxTokens overrides the scaling, for the summarizer and the labeler", async () => {
    // The scaling counts facets, which is the wrong axis for a reasoning model:
    // its thinking comes out of this same budget, so 480 tokens buys no answer
    // at all — on every trace, on every run, at full price. Without a knob the
    // truncation message's advice ("use fewer facets") cannot fix it.
    const cfg = { ...DEFAULT_CONFIG.llm, maxTokens: 4000 };
    const fetchStub = stubFetch([{ body: anthropicBody('{"goal":"a"}') }]);
    await new AnthropicSummarizer(cfg, { fetchImpl: fetchStub.impl }).summarize(TRACE, FACETS);
    assert.equal(fetchStub.calls[0]!.body.max_tokens, 4000);

    const labelStub = stubFetch([{ body: anthropicBody('{"label":"a","description":"b"}') }]);
    await new HttpLabeler(cfg, { fetchImpl: labelStub.impl }).label("goal", ["a summary"]);
    assert.equal(labelStub.calls[0]!.body.max_tokens, 4000);
  });
});

describe("truncation", () => {
  // A truncated reply is well-formed JSON that simply stops. Reported as a
  // parse error it looks like a bad model; reported as truncation it names its
  // own fix. It happens on every trace, forever, until someone acts on it.
  test("anthropic stop_reason max_tokens is reported as truncation", async () => {
    const fetchStub = stubFetch([{ body: { content: [{ type: "text", text: '{"goal":"a' }], stop_reason: "max_tokens" } }]);
    const s = new AnthropicSummarizer(DEFAULT_CONFIG.llm, { fetchImpl: fetchStub.impl });
    await assert.rejects(() => s.summarize(TRACE, FACETS), /truncated at 400 tokens/);
    // The advice has to name a lever that exists: "use fewer facets" alone is
    // no help at one facet, which still gets the 400-token floor.
    await assert.rejects(() => s.summarize(TRACE, FACETS), /SIFT_LLM_MAX_TOKENS/);
  });

  test("openai finish_reason length is reported as truncation", async () => {
    const fetchStub = stubFetch([{ body: { choices: [{ message: { content: '{"goal":"a' }, finish_reason: "length" }] } }]);
    const s = new OpenAiSummarizer({ ...DEFAULT_CONFIG.llm, provider: "openai", baseUrl: "http://x" }, { fetchImpl: fetchStub.impl });
    await assert.rejects(() => s.summarize(TRACE, FACETS), /truncated/);
  });

  test("a normal stop_reason is not mistaken for truncation", async () => {
    const fetchStub = stubFetch([{ body: { content: [{ type: "text", text: '{"goal":"a","behavior":"b"}' }], stop_reason: "end_turn" } }]);
    const s = new AnthropicSummarizer(DEFAULT_CONFIG.llm, { fetchImpl: fetchStub.impl });
    assert.equal((await s.summarize(TRACE, FACETS))[0]!.summary, "a");
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

describe("retries and rate limits", () => {
  const summarizer = (fetchImpl: typeof fetch, sleep: (ms: number) => Promise<void>) =>
    new AnthropicSummarizer(DEFAULT_CONFIG.llm, { fetchImpl, sleep });

  test("Retry-After in seconds is honoured over the backoff schedule", async () => {
    // 500ms of backoff against a provider asking for 30s is a run that fails
    // for no reason. The provider's number wins.
    const fetchStub = stubFetch([
      { status: 429, body: { type: "error", error: { type: "rate_limit_error" } }, headers: { "retry-after": "30" } },
      { body: anthropicBody('{"goal":"g","behavior":"b"}') },
    ]);
    const slept: number[] = [];
    await summarizer(fetchStub.impl, async (ms) => void slept.push(ms)).summarize(TRACE, FACETS);
    assert.deepEqual(slept, [30_000]);
  });

  test("Retry-After as an HTTP-date is honoured too", async () => {
    const when = new Date(Date.now() + 45_000).toUTCString();
    const fetchStub = stubFetch([
      { status: 503, body: "unavailable", headers: { "retry-after": when } },
      { body: anthropicBody('{"goal":"g","behavior":"b"}') },
    ]);
    const slept: number[] = [];
    await summarizer(fetchStub.impl, async (ms) => void slept.push(ms)).summarize(TRACE, FACETS);
    assert.ok(slept[0]! > 40_000 && slept[0]! <= 45_000, `slept ${slept[0]}ms for a 45s date`);
  });

  test("an absurd Retry-After is clamped, not obeyed", async () => {
    const fetchStub = stubFetch([
      { status: 429, body: "slow down", headers: { "retry-after": "86400" } },
      { body: anthropicBody('{"goal":"g","behavior":"b"}') },
    ]);
    const slept: number[] = [];
    await summarizer(fetchStub.impl, async (ms) => void slept.push(ms)).summarize(TRACE, FACETS);
    assert.equal(slept[0], 120_000, "a day is not a retry, it is a hang");
  });

  test("a garbage Retry-After falls back to exponential backoff", async () => {
    const fetchStub = stubFetch([
      { status: 429, body: "slow down", headers: { "retry-after": "soon" } },
      { body: anthropicBody('{"goal":"g","behavior":"b"}') },
    ]);
    const slept: number[] = [];
    await summarizer(fetchStub.impl, async (ms) => void slept.push(ms)).summarize(TRACE, FACETS);
    assert.equal(slept[0], 500);
  });

  test("a 5xx with no header keeps the exponential schedule", async () => {
    const fetchStub = stubFetch([{ status: 500, body: "boom" }]);
    const slept: number[] = [];
    const s = new AnthropicSummarizer(DEFAULT_CONFIG.llm, {
      fetchImpl: fetchStub.impl,
      maxRetries: 3,
      sleep: async (ms) => void slept.push(ms),
    });
    await assert.rejects(() => s.summarize(TRACE, FACETS));
    assert.deepEqual(slept, [500, 1000, 2000]);
  });

  test("a huge error body is truncated before it becomes a thousand failure rows", async () => {
    // A proxy's HTML 500, stored per failed trace and printed by --json, is
    // megabytes of noise that says nothing the first 400 chars did not.
    const html = `<!doctype html><html><body>${"gateway error ".repeat(500)}</body></html>`;
    const fetchStub = stubFetch([{ status: 502, body: html }]);
    const s = new AnthropicSummarizer(DEFAULT_CONFIG.llm, { fetchImpl: fetchStub.impl, maxRetries: 0, sleep: async () => {} });
    await assert.rejects(
      () => s.summarize(TRACE, FACETS),
      (err: Error) => {
        assert.ok(err.message.length < 500, `error message was ${err.message.length} chars`);
        assert.match(err.message, /502/);
        assert.match(err.message, new RegExp(`\\(${html.length} bytes\\)`), "it should say how much it dropped");
        return true;
      },
    );
  });

  test("an aborted request is retried like any other transport failure", async () => {
    const aborted = new Error("This operation was aborted");
    const fetchStub = stubFetch([aborted, { body: anthropicBody('{"goal":"g","behavior":"b"}') }]);
    const s = summarizer(fetchStub.impl, async () => {});
    assert.equal((await s.summarize(TRACE, FACETS))[0]!.summary, "g");
  });

  test("every request carries a deadline, so a black-hole connection cannot hang a run", async () => {
    const fetchStub = stubFetch([{ body: anthropicBody('{"goal":"g","behavior":"b"}') }]);
    await summarizer(fetchStub.impl, async () => {}).summarize(TRACE, FACETS);
    assert.ok(fetchStub.calls[0]!.init.signal, "fetch was called with no AbortSignal");
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

  test("the one 400 that is not permanent: max_tokens renamed to max_completion_tokens", async () => {
    // Newer OpenAI models reject max_tokens and name the field they want. It is
    // the only 400 worth retrying, and postJson is right to refuse the rest.
    const fetchStub = stubFetch([
      {
        status: 400,
        body: {
          error: {
            message:
              "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            type: "invalid_request_error",
            param: "max_tokens",
            code: "unsupported_parameter",
          },
        },
      },
      { body: openAiBody('{"goal":"g","behavior":"b"}') },
    ]);
    const s = new OpenAiSummarizer(
      { ...DEFAULT_CONFIG.llm, provider: "openai", baseUrl: "https://api.openai.com", apiKey: "k" },
      { fetchImpl: fetchStub.impl, sleep: async () => {} },
    );

    assert.equal((await s.summarize(TRACE, FACETS))[0]!.summary, "g");
    assert.equal(fetchStub.count, 2, "exactly one retry, with the renamed field");
    assert.equal(fetchStub.calls[0]!.body.max_tokens, 400);
    assert.equal(fetchStub.calls[1]!.body.max_completion_tokens, 400);
    assert.equal(fetchStub.calls[1]!.body.max_tokens, undefined, "the rejected field must not be sent again");
  });

  test("any other 400 is still permanent", async () => {
    const fetchStub = stubFetch([{ status: 400, body: { error: { message: "The model `gpt-9` does not exist." } } }]);
    const s = new OpenAiSummarizer(
      { ...DEFAULT_CONFIG.llm, provider: "openai", baseUrl: "https://api.openai.com", apiKey: "k" },
      { fetchImpl: fetchStub.impl, sleep: async () => {} },
    );
    await assert.rejects(() => s.summarize(TRACE, FACETS), /does not exist/);
    assert.equal(fetchStub.count, 1);
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
