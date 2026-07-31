import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { estimateCost, renderDoctor, runDoctor, type DoctorResult } from "../src/doctor/index.ts";
import { priceFor } from "../src/doctor/prices.ts";
import { DEFAULT_CONFIG, resolveFacets, type SiftConfig } from "../src/config.ts";
import { buildFacetPrompt } from "../src/facets/summarize.ts";
import { withTempStore } from "../src/testing/temp.ts";
import type { SiftStore } from "../src/store/db.ts";
import type { Trace } from "../src/types.ts";

/**
 * The preflight, offline. Every probe goes through an injected fetch, so this
 * file proves the thing doctor exists to prove — that a broken hosted setup is
 * reported in one screen — without a key or a socket.
 */

/**
 * A fetch stub that records calls and replays scripted responses. Copied from
 * providers.test.ts rather than shared: the two files script different response
 * sequences, and this one has to honour `signal` so the timeout case is real.
 */
function stubFetch(responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> } | Error>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let i = 0;
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    const next = responses[Math.min(i, responses.length - 1)]!;
    i++;
    calls.push({ url: String(url), body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    if (next instanceof Error) throw next;
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: next.headers ?? {},
    });
  }) as unknown as typeof fetch;
  return { impl, calls, get count() { return i; } };
}

/** Never answers, but honours the abort — a black hole, which is the interesting case. */
const hangingFetch = (async (_url: string | URL, init: RequestInit = {}) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
  })) as unknown as typeof fetch;

const KEY = "sk-ant-secret-value-do-not-print";

function hostedConfig(over: Partial<SiftConfig> = {}): SiftConfig {
  return {
    ...DEFAULT_CONFIG,
    llm: { ...DEFAULT_CONFIG.llm, apiKey: KEY },
    embeddings: { ...DEFAULT_CONFIG.embeddings, apiKey: "sk-embed-secret", dimensions: 4 },
    ...over,
  };
}

const FACET_REPLY = JSON.stringify({
  goal: "wants the nightly job looked at",
  outcome: "unresolved, the log service was unreachable",
  behavior: "called read_logs once and gave up on a timeout",
  sentiment: "mildly frustrated",
});

/** Two paraphrases and a stranger, in the order the embed probe sends them. */
const GOOD_VECTORS = { data: [0, 1, 2].map((index) => ({ index, embedding: [[1, 0, 0, 0], [0.94, 0.34, 0, 0], [0, 0, 0, 1]][index]! })) };

function check(r: DoctorResult, name: string) {
  const found = r.checks.find((c) => c.name === name);
  assert.ok(found, `no check named ${name} in ${r.checks.map((c) => c.name).join(", ")}`);
  return found;
}

function doctor(cfg: SiftConfig, opts: Partial<Parameters<typeof runDoctor>[1]> = {}) {
  return withTempStore(async (store: SiftStore) => runDoctor(cfg, { store, ...opts }));
}

describe("runDoctor: offline configuration", () => {
  test("the fully offline config skips both probes and passes", async () => {
    const cfg: SiftConfig = {
      ...DEFAULT_CONFIG,
      llm: { ...DEFAULT_CONFIG.llm, provider: "fake" },
      embeddings: { ...DEFAULT_CONFIG.embeddings, provider: "hash" },
    };
    const fetchStub = stubFetch([{ body: {} }]);
    const r = await doctor(cfg, { fetchImpl: fetchStub.impl });

    assert.equal(r.ok, true);
    assert.equal(fetchStub.count, 0, "doctor must not call anything when there is nothing to call");
    assert.equal(check(r, "llm probe").status, "skip");
    assert.equal(check(r, "embed probe").status, "skip");
    assert.match(renderDoctor(r), /–/, "a skip should render as a skip, not as a pass");
  });

  test("an openai provider left on the anthropic base URL fails, with the env var that fixes it", async () => {
    const cfg = hostedConfig({ llm: { ...DEFAULT_CONFIG.llm, provider: "openai", apiKey: KEY } });
    const r = await doctor(cfg, { probe: false });

    const coherence = check(r, "coherence");
    assert.equal(coherence.status, "fail");
    assert.equal(r.ok, false);
    assert.match(coherence.detail, /api\.anthropic\.com/);
    assert.match(coherence.fix ?? "", /SIFT_LLM_BASE_URL/);
  });

  test("an anthropic provider pointed at a non-Claude model fails coherence", async () => {
    const cfg = hostedConfig({ llm: { ...DEFAULT_CONFIG.llm, model: "gpt-4o-mini", apiKey: KEY } });
    const r = await doctor(cfg, { probe: false });
    assert.equal(check(r, "coherence").status, "fail");
    assert.match(check(r, "coherence").fix ?? "", /SIFT_LLM_MODEL/);
  });

  test("a missing key fails before anything is spent", async () => {
    const cfg = hostedConfig();
    delete cfg.llm.apiKey;
    const fetchStub = stubFetch([{ body: {} }]);
    const r = await doctor(cfg, { fetchImpl: fetchStub.impl });

    assert.equal(r.ok, false);
    assert.equal(check(r, "llm key").status, "fail");
    assert.match(check(r, "llm key").fix ?? "", /SIFT_LLM_API_KEY/);
    assert.equal(check(r, "llm probe").status, "skip", "no key means no call, not a 401 per trace");
  });

  test("a key is described but never printed, in the render or the JSON", async () => {
    const fetchStub = stubFetch([{ body: { content: [{ type: "text", text: FACET_REPLY }] } }, { body: GOOD_VECTORS }]);
    const r = await doctor(hostedConfig(), { fetchImpl: fetchStub.impl, keySources: { llm: "SIFT_LLM_API_KEY" } });

    const rendered = renderDoctor(r);
    const json = JSON.stringify(r);
    // Doctor output gets pasted into issues. Asserted on the raw strings
    // because "we only ever store the length" is a claim, not a guarantee.
    assert.ok(!rendered.includes(KEY), "the key value must not appear in the rendered report");
    assert.ok(!json.includes(KEY), "the key value must not appear in --json");
    assert.match(check(r, "llm key").detail, new RegExp(`${KEY.length} chars, from SIFT_LLM_API_KEY`));
  });

  test("a key that came from a config file is a warning, not a pass", async () => {
    const r = await doctor(hostedConfig(), { probe: false, keySources: { llm: "sift.config.json" } });
    assert.equal(check(r, "llm key").status, "warn");
    assert.match(check(r, "llm key").fix ?? "", /gets committed/);
    assert.equal(r.ok, true, "a warning must not fail the preflight");
  });

  test("privacy off against a hosted model warns about what leaves the machine", async () => {
    const cfg = hostedConfig({ privacy: { mode: "off", scope: "trace" } });
    const r = await doctor(cfg, { probe: false });
    assert.equal(check(r, "privacy").status, "warn");
    assert.match(check(r, "privacy").detail, /raw trace text/);
  });

  test("--no-probe makes exactly zero network calls", async () => {
    const fetchStub = stubFetch([{ body: {} }]);
    const r = await doctor(hostedConfig(), { fetchImpl: fetchStub.impl, probe: false });
    assert.equal(fetchStub.count, 0);
    assert.equal(check(r, "llm probe").detail, "--no-probe");
  });
});

describe("runDoctor: probes", () => {
  test("a fenced JSON reply passes, and costs exactly two calls", async () => {
    const fetchStub = stubFetch([
      { body: { content: [{ type: "text", text: `\`\`\`json\n${FACET_REPLY}\n\`\`\`` }] } },
      { body: GOOD_VECTORS },
    ]);
    const r = await doctor(hostedConfig(), { fetchImpl: fetchStub.impl });

    assert.equal(r.ok, true, JSON.stringify(r.checks));
    assert.equal(fetchStub.count, 2, "a preflight is one summarizer call and one embed call, no more");
    assert.match(check(r, "llm probe").detail, /answered all 4 facets/);
    // The probe trace is synthetic and stays synthetic.
    assert.match(JSON.stringify(fetchStub.calls[0]!.body), /nightly job/);
  });

  test("a model that answers in prose fails, and the reply is in the report", async () => {
    const fetchStub = stubFetch([
      { body: { content: [{ type: "text", text: "I'm sorry, I can't summarize conversations." }] } },
      { body: GOOD_VECTORS },
    ]);
    const r = await doctor(hostedConfig(), { fetchImpl: fetchStub.impl });

    assert.equal(r.ok, false);
    assert.equal(check(r, "llm probe").status, "fail");
    assert.match(check(r, "llm probe").detail, /can't summarize/, "the raw head is what makes this diagnosable");
  });

  test("a 401 is reported as one line, not as a thousand failed traces", async () => {
    const fetchStub = stubFetch([
      { status: 401, body: { error: { type: "authentication_error", message: "invalid x-api-key" } } },
      { body: GOOD_VECTORS },
    ]);
    const r = await doctor(hostedConfig(), { fetchImpl: fetchStub.impl });
    assert.equal(check(r, "llm probe").status, "fail");
    assert.match(check(r, "llm probe").detail, /401/);
    assert.equal(fetchStub.count, 2, "a 401 must not be retried");
  });

  test("an embedder of the wrong width fails with the dimensions to set", async () => {
    const fetchStub = stubFetch([
      { body: { content: [{ type: "text", text: FACET_REPLY }] } },
      { body: { data: [0, 1, 2].map((index) => ({ index, embedding: [1, 0, 0, 0, 0, 0, 0, 0] })) } },
    ]);
    const r = await doctor(hostedConfig(), { fetchImpl: fetchStub.impl });

    assert.equal(check(r, "embed probe").status, "fail");
    assert.match(check(r, "embed probe").fix ?? "", /SIFT_EMBED_DIMENSIONS=8/);
  });

  test("an embedder with no geometry warns, because it will fragment every theme", async () => {
    const flat = { data: [0, 1, 2].map((index) => ({ index, embedding: [1, 0.02 * index, 0, 0] })) };
    const fetchStub = stubFetch([{ body: { content: [{ type: "text", text: FACET_REPLY }] } }, { body: flat }]);
    const r = await doctor(hostedConfig(), { fetchImpl: fetchStub.impl });

    assert.equal(check(r, "embed probe").status, "warn");
    assert.match(check(r, "embed probe").fix ?? "", /one theme per phrasing/);
    assert.equal(r.ok, true, "a bad embedder is a warning: it works, it just works badly");
  });

  test("an endpoint that never answers fails on the timeout instead of hanging", async () => {
    const r = await doctor(hostedConfig(), { fetchImpl: hangingFetch, timeoutMs: 25 });
    assert.equal(check(r, "llm probe").status, "fail");
    assert.match(check(r, "llm probe").detail, /abort/i);
    assert.equal(check(r, "embed probe").status, "fail");
  });
});

describe("estimateCost", () => {
  const facets = resolveFacets(DEFAULT_CONFIG);

  test("the chat preset's prompt overhead is 733 chars", () => {
    // Pinned because docs/COST.md quotes it and the estimate is built on it.
    // If an edit to buildFacetPrompt moves this, both should move together.
    const empty: Trace = { id: "", agentId: "", startedAt: "", text: "", meta: {} };
    assert.equal(buildFacetPrompt(empty, facets, 0).length, 733);
  });

  test("token counts are the hand-computed ones, with long traces clipped", () => {
    // 25,000 chars of trace text: 1,000 from the short one and 24,000 from the
    // 30,000-char one, because that is what clipTrace actually sends.
    const stats = { traces: 2, chars: 25_000 };
    const e = estimateCost(stats, DEFAULT_CONFIG, facets);

    assert.equal(e.inputTokens, Math.ceil((25_000 + 733 * 2) / 3.5));
    assert.equal(e.inputTokens, 7562);
    assert.equal(e.outputTokens, 2 * 30 * 4);
    assert.equal(e.embedTokens, 2 * 4 * 25);
    assert.equal(e.priced, true);
    assert.equal(e.llmCost, (7562 / 1e6) * 1 + (240 / 1e6) * 5);
  });

  test("a model with no published price yields tokens and no dollar figure at all", () => {
    const cfg: SiftConfig = { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, model: "some-model-nobody-priced" } };
    const e = estimateCost({ traces: 10, chars: 10_000 }, cfg, facets);

    assert.equal(e.llmCost, null);
    assert.equal(e.priced, false);
    assert.ok(e.inputTokens > 0, "tokens are still worth printing");
    assert.ok(e.assumptions.some((a) => a.includes("no published price on file")));

    const rendered = renderDoctor({ checks: [], estimate: e, ok: true });
    assert.ok(!rendered.includes("$"), `a guessed price is worse than none:\n${rendered}`);
  });

  test("--price-in/--price-out override the table", () => {
    const cfg: SiftConfig = { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, model: "some-model-nobody-priced" } };
    const e = estimateCost({ traces: 10, chars: 10_000 }, cfg, facets, { in: 2, out: 8 });
    assert.equal(e.priced, true);
    assert.equal(e.llmCost, (e.inputTokens / 1e6) * 2 + (e.outputTokens / 1e6) * 8);
  });

  test("the fully offline configuration costs nothing", () => {
    const cfg: SiftConfig = {
      ...DEFAULT_CONFIG,
      llm: { ...DEFAULT_CONFIG.llm, provider: "fake" },
      embeddings: { ...DEFAULT_CONFIG.embeddings, provider: "hash" },
    };
    const e = estimateCost({ traces: 5000, chars: 10_000_000 }, cfg, facets);
    assert.equal(e.llmCost, 0);
    assert.equal(e.embedCost, 0);
  });

  test("every assumption behind the number is printed with it", () => {
    const e = estimateCost({ traces: 100, chars: 100_000 }, DEFAULT_CONFIG, facets);
    const rendered = renderDoctor({ checks: [], estimate: e, ok: true });
    for (const assumption of e.assumptions) assert.ok(rendered.includes(assumption), `missing: ${assumption}`);
    assert.match(rendered, /this is an estimate, not a quote/);
    assert.match(rendered, /list prices as of \d{4}-\d{2}-\d{2}/);
  });

  test("the estimate is built from the corpus in the database, not a guess", async () => {
    await withTempStore(async (store) => {
      store.insertTraces([
        { id: "short", agentId: "a", startedAt: "2026-07-01T00:00:00.000Z", text: "x".repeat(1000), meta: {} },
        { id: "long", agentId: "a", startedAt: "2026-07-01T00:00:01.000Z", text: "y".repeat(30_000), meta: {} },
      ]);
      const cfg = hostedConfig();
      const r = await runDoctor(cfg, { store, probe: false });
      assert.equal(r.estimate!.traces, 2);
      assert.equal(r.estimate!.inputTokens, Math.ceil((25_000 + 733 * 2) / 3.5));
    });
  });
});

describe("price table", () => {
  test("a dated Anthropic model id matches its family by longest prefix", () => {
    assert.deepEqual(priceFor("claude-haiku-4-5-20251001"), { in: 1, out: 5 });
    assert.deepEqual(priceFor("text-embedding-3-large"), { in: 0.13, out: 0 });
    assert.equal(priceFor("llama3.1:8b"), null);
  });
});
