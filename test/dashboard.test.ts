import { test, describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";

import { startReceiver, type ReceiverOptions } from "../src/ingest/receiver.ts";
import { MAX_TRACE_TEXT } from "../src/serve/api.ts";
import { Pipeline } from "../src/pipeline.ts";
import { SiftStore } from "../src/store/db.ts";
import { DEFAULT_CONFIG, type SiftConfig } from "../src/config.ts";
import { buildFacetReport } from "../src/report/model.ts";
import { computeDeltas } from "../src/delta/index.ts";
import { HashEmbedder } from "../src/embed/index.ts";
import { KeywordSummarizer, StubLabeler } from "../src/testing/fakes.ts";
import type { Theme } from "../src/types.ts";

/**
 * The read-only dashboard API over a real loopback socket.
 *
 * The point of most of these assertions is not that the endpoint returns
 * something shaped right — it is that it returns *the same object the CLI
 * prints*, byte for byte through JSON. `sift report` and the browser disagreeing
 * about a share is the failure this whole file exists to make impossible, so the
 * expectations are calls to buildFacetReport and computeDeltas rather than
 * hand-written numbers that could drift with them.
 *
 * The registry is seeded directly instead of clustered: what the pipeline puts
 * in the store is e2e.test.ts's subject, and what the API does with what is in
 * the store is this one's.
 */

const AGENT = "support-bot";
/** The first facet of the default (chat) preset — what the API picks unasked. */
const FACET = "goal";

function addTheme(s: SiftStore, id: string, over: Partial<Theme> = {}): void {
  s.insertTheme({
    id,
    agentId: AGENT,
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

function addTrace(s: SiftStore, id: string, text: string, version = "v1.3"): void {
  s.insertTrace({ id, agentId: AGENT, version, startedAt: "2026-07-02T00:00:00.000Z", text, meta: {} });
}

function addWindow(s: SiftStore, window: string, rows: Array<[string | null, number]>): void {
  let n = 0;
  for (const [themeId, count] of rows) {
    for (let i = 0; i < count; i++) {
      const traceId = `${window}-${themeId ?? "res"}-${n++}`;
      addTrace(s, traceId, "", window);
      s.insertAssignment({ traceId, agentId: AGENT, facet: FACET, themeId, similarity: themeId ? 0.9 : 0.1, window });
    }
  }
}

/** One regressed theme, one steady, one new, over two release windows. */
function seedDemo(s: SiftStore): void {
  addTheme(s, "SIFT-14", {
    label: "tool-retry loop on search_kb",
    state: "regressed",
    memberCount: 13,
    // The third id is dangling on purpose: an exemplar list outlives a purged
    // trace, and the theme page has to render rather than 500.
    exemplarTraceIds: ["t-retry-1", "t-retry-2", "t-purged"],
  });
  addTheme(s, "SIFT-3", { label: "user asks for refund, agent deflects", memberCount: 16 });
  addTheme(s, "SIFT-21", { label: "context lost after long tool output", state: "new", memberCount: 4 });

  addWindow(s, "v1.2", [["SIFT-14", 2], ["SIFT-3", 8], [null, 90]]);
  addWindow(s, "v1.3", [["SIFT-14", 11], ["SIFT-3", 8], ["SIFT-21", 4], [null, 77]]);

  addTrace(s, "t-retry-1", "user: where is my refund\ntool: search_kb\ntool: search_kb\nERROR: timeout\n");
  addTrace(s, "t-retry-2", "y".repeat(MAX_TRACE_TEXT + 500));
  s.insertSummaries([
    { traceId: "t-retry-1", facet: FACET, summary: "user wants the status of a refund" },
    { traceId: "t-retry-2", facet: FACET, summary: "user wants the status of a refund" },
  ]);
}

interface World {
  store: SiftStore;
  cfg: SiftConfig;
  url: string;
}

async function serve(
  t: TestContext,
  opts: Partial<ReceiverOptions> & { seed?: (s: SiftStore) => void } = {},
): Promise<World> {
  const { seed = seedDemo, ...receiverOpts } = opts;
  const store = new SiftStore(":memory:");
  seed(store);

  // Offline providers, none of which this file ever calls: the API only reads.
  const cfg: SiftConfig = { ...DEFAULT_CONFIG, dbPath: ":memory:" };
  const pipeline = new Pipeline(store, cfg, {
    summarizer: new KeywordSummarizer(),
    embedder: new HashEmbedder(64),
    labeler: new StubLabeler(),
  });

  const receiver = await startReceiver({ store, port: 0, pipeline, ...receiverOpts });
  t.after(async () => {
    await receiver.close();
    store.close();
  });
  return { store, cfg, url: receiver.url };
}

function get(url: string, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}${path}`, { headers });
}

/** A GET whose path reaches the server exactly as written, escapes and all. */
function raw(url: string, path: string): Promise<string> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port) }, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: sift.invalid\r\nConnection: close\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

/** The `{error}` line off a rejection, which is the only shape a rejection has. */
async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

/** What the endpoint would have to return to be indistinguishable from the CLI. */
function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("the dashboard API reads what the CLI reads", () => {
  test("/api/meta names the agents and facets the pickers can ask for", async (t) => {
    const { url } = await serve(t);

    const res = await get(url, "/api/meta");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), {
      agents: [AGENT],
      facets: ["goal", "outcome", "behavior", "sentiment"],
      dbPath: ":memory:",
    });
  });

  test("/api/themes is buildFacetReport, not a second opinion about it", async (t) => {
    const { url, store, cfg } = await serve(t);

    const res = await get(url, "/api/themes");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), asJson(buildFacetReport(store, cfg, { agentId: AGENT, facet: FACET })));
  });

  test("agent and facet default to the first of each, and can be named", async (t) => {
    const { url } = await serve(t);

    const implicit = await (await get(url, "/api/themes")).json();
    const explicit = await (await get(url, `/api/themes?agent=${AGENT}&facet=${FACET}`)).json();
    assert.deepEqual(implicit, explicit);
  });

  test("?window= reports an older window, exactly as --window does", async (t) => {
    const { url, store, cfg } = await serve(t);

    const res = await get(url, "/api/themes?window=v1.2");
    const body = (await res.json()) as { window: string };
    assert.equal(body.window, "v1.2");
    assert.deepEqual(body, asJson(buildFacetReport(store, cfg, { agentId: AGENT, facet: FACET, window: "v1.2" })));
  });

  test("/api/delta defaults to the latest pair and equals computeDeltas", async (t) => {
    const { url, store, cfg } = await serve(t);

    const expected = asJson(computeDeltas(store, AGENT, FACET, "v1.2", "v1.3", { sigma: cfg.deltaSigma }));
    assert.deepEqual(await (await get(url, "/api/delta")).json(), expected);
    assert.deepEqual(await (await get(url, "/api/delta?from=v1.2&to=v1.3")).json(), expected);
  });

  test("/api/theme/:id carries the facet summary the CLI's --json drops", async (t) => {
    const { url } = await serve(t);

    const res = await get(url, "/api/theme/SIFT-14");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      theme: Theme;
      exemplars: Array<{ trace: { id: string }; summary: string | null; truncated: boolean; fullTextLength: number }>;
    };

    assert.equal(body.theme.id, "SIFT-14");
    assert.equal(body.theme.state, "regressed");
    assert.equal("centroid" in body.theme, false, "the embedding coordinate is not the browser's business");
    // Two of the three exemplar ids resolve; the purged one is dropped, not null.
    assert.deepEqual(
      body.exemplars.map((e) => e.trace.id),
      ["t-retry-1", "t-retry-2"],
    );
    assert.equal(body.exemplars[0]!.summary, "user wants the status of a refund");
    assert.equal(body.exemplars[0]!.truncated, false);
  });

  test("a huge trace is cut server-side and says by how much", async (t) => {
    const { url } = await serve(t);

    const body = (await (await get(url, "/api/theme/SIFT-14")).json()) as {
      exemplars: Array<{ trace: { text: string }; truncated: boolean; fullTextLength: number }>;
    };
    const big = body.exemplars[1]!;
    assert.equal(big.truncated, true);
    assert.equal(big.trace.text.length, MAX_TRACE_TEXT);
    assert.equal(big.fullTextLength, MAX_TRACE_TEXT + 500);
  });
});

describe("the dashboard API on an empty database", () => {
  const empty = () => {};

  test("/api/meta is empty rather than absent, so the UI can say so", async (t) => {
    const { url } = await serve(t, { seed: empty });

    assert.deepEqual((await (await get(url, "/api/meta")).json()) as { agents: string[] }, {
      agents: [],
      facets: ["goal", "outcome", "behavior", "sentiment"],
      dbPath: ":memory:",
    });
  });

  test("/api/themes says there is nothing here yet and what to run", async (t) => {
    const { url } = await serve(t, { seed: empty });

    const res = await get(url, "/api/themes");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "no traces in :memory: yet; run `sift analyze` first" });
  });

  test("/api/delta needs two windows before it can diff anything", async (t) => {
    const { url } = await serve(t, {
      seed: (s) => {
        addTheme(s, "SIFT-1");
        addWindow(s, "v1.0", [["SIFT-1", 3]]);
      },
    });

    const res = await get(url, "/api/delta");
    assert.equal(res.status, 404);
    assert.match(await errorOf(res), /has 1 window\(s\), so there is nothing to diff yet/);
  });
});

describe("the dashboard API refuses rather than guesses", () => {
  test("an unknown agent or facet 404s with the valid values", async (t) => {
    const { url } = await serve(t);

    const agent = await get(url, "/api/themes?agent=nope");
    assert.equal(agent.status, 404);
    assert.deepEqual(await agent.json(), { error: `no agent "nope"; known: ${AGENT}` });

    const facet = await get(url, "/api/themes?facet=vibes");
    assert.equal(facet.status, 404);
    assert.match(await errorOf(facet), /no facet "vibes"; the configured facets are goal, outcome/);
  });

  test("an unknown window 404s instead of reporting a clean release", async (t) => {
    const { url } = await serve(t);

    for (const path of ["/api/themes?window=v9.9", "/api/delta?from=v1.2&to=v9.9"]) {
      const res = await get(url, path);
      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), { error: `no window "v9.9" for ${AGENT}/${FACET}; known: v1.2, v1.3` });
    }
  });

  test("an unknown theme or endpoint is a 404, never a crash", async (t) => {
    const { url } = await serve(t);

    assert.deepEqual(await (await get(url, "/api/theme/SIFT-999")).json(), { error: "no such theme SIFT-999" });
    for (const path of ["/api/", "/api/nope", "/api/theme/", "/api/theme/a/b"]) {
      const res = await get(url, path);
      assert.equal(res.status, 404, path);
      assert.match(await errorOf(res), /the dashboard API is \/api\/meta/, path);
    }
  });

  test("a percent-encoded path is matched literally, not decoded into something else", async (t) => {
    const { url } = await serve(t);

    // Over a raw socket because fetch() collapses %2e%2e to .. before sending,
    // so the interesting request never leaves the client. There is no fs access
    // behind /api today, but a route table that decodes before matching is how
    // that stops being true quietly, and this catches it either way.
    for (const path of ["/api/%2e%2e/%2e%2e/etc/passwd", "/api/theme/%2e%2e%2f%2e%2e%2fetc%2fpasswd", "/api/..%5c..%5cx"]) {
      const res = await raw(url, path);
      assert.match(res, /^HTTP\/1\.1 404 /, path);
      assert.doesNotMatch(res, /root:/, path);
    }

    // A mangled id misses the lookup and says so; it never reaches a decoder
    // that could throw and turn a typo into a 503.
    const encoded = await get(url, "/api/theme/SIFT%2D14");
    assert.equal(encoded.status, 404);
    assert.deepEqual(await encoded.json(), { error: "no such theme SIFT%2D14" });
  });

  test("every mutating method is a 405, because there is no write path", async (t) => {
    const { url } = await serve(t);

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${url}/api/themes`, { method });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get("allow"), "GET");
      assert.deepEqual(await res.json(), { error: `${method} not allowed; the dashboard API is read-only` });
    }
  });
});

describe("the dashboard API is exposed no wider than the write endpoint", () => {
  test("--token guards reads exactly as it guards writes", async (t) => {
    const { url } = await serve(t, { token: "s3cret" });

    const anonymous = await get(url, "/api/themes");
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get("www-authenticate"), "Bearer");
    assert.deepEqual(await anonymous.json(), { error: "missing or wrong bearer token" });

    assert.equal((await get(url, "/api/themes", { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await get(url, "/api/themes", { authorization: "Bearer s3cret" })).status, 200);
  });

  test("a non-loopback bind with no token turns the read side off and says why", async (t) => {
    // 0.0.0.0 is the realistic mistake: it used to mean "anyone can write
    // traces" and would now also mean "anyone can read every conversation".
    const { url } = await serve(t, { host: "0.0.0.0" });

    const res = await get(url, "/api/themes");
    assert.equal(res.status, 404);
    assert.match(await errorOf(res), /the dashboard is off: .*no --token.*raw trace text/);
  });

  test("a non-loopback bind with a token serves reads to whoever holds it", async (t) => {
    const { url } = await serve(t, { host: "0.0.0.0", token: "s3cret" });

    assert.equal((await get(url, "/api/themes", { authorization: "Bearer s3cret" })).status, 200);
    assert.equal((await get(url, "/api/themes")).status, 401);
  });
});

describe("mounting the dashboard changes nothing about the collector", () => {
  test("without a pipeline, /api is just another unknown path", async (t) => {
    const store = new SiftStore(":memory:");
    const receiver = await startReceiver({ store, port: 0 });
    t.after(async () => {
      await receiver.close();
      store.close();
    });

    const res = await get(receiver.url, "/api/themes");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), {
      error: "no such endpoint /api/themes; sift accepts OTLP/JSON traces at POST /v1/traces",
    });
  });

  test("with a pipeline, the OTLP and health paths answer exactly as before", async (t) => {
    const { url } = await serve(t);

    assert.deepEqual(await (await get(url, "/healthz")).json(), { status: "ok", pendingSpans: 0 });

    const accepted = await fetch(`${url}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceSpans: [] }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(await accepted.text(), '{"partialSuccess":{}}');

    const wrongMethod = await get(url, "/v1/traces");
    assert.equal(wrongMethod.status, 405);
    assert.deepEqual(await wrongMethod.json(), { error: "GET not allowed; POST OTLP/JSON to /v1/traces" });

    const wrongSignal = await get(url, "/v1/metrics");
    assert.equal(wrongSignal.status, 404);
    assert.match(await errorOf(wrongSignal), /sift receives traces only/);
  });
});
