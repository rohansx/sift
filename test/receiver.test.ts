import { test, describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import { startReceiver, type ReceiverOptions } from "../src/ingest/receiver.ts";
import { flushSettledTraces } from "../src/ingest/pending.ts";
import { SiftStore } from "../src/store/db.ts";

/**
 * The receiver over a real loopback socket on an ephemeral port. Nothing here
 * touches the network or a temp file, and every server registers its own
 * shutdown — a leaked listener does not fail a test, it hangs the whole run.
 */
async function serve(t: TestContext, opts: Partial<ReceiverOptions> = {}) {
  const store = new SiftStore(":memory:");
  const receiver = await startReceiver({ store, port: 0, ...opts });
  t.after(async () => {
    await receiver.close();
    store.close();
  });
  return { store, url: receiver.url };
}

function post(url: string, body: string | Buffer, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

/** A real ExportTraceServiceRequest, down to the nanosecond-string timestamps. */
function batch(spans: Array<Record<string, unknown>>, resource: Record<string, string> = {}): string {
  const attrs = { "service.name": "support-bot", "service.version": "v1.3", ...resource };
  return JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: value } })),
        },
        scopeSpans: [{ scope: { name: "@opentelemetry/instrumentation-anthropic" }, spans }],
      },
    ],
  });
}

function span(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    name: "chat anthropic",
    kind: 3,
    startTimeUnixNano: "1782000000000000000",
    endTimeUnixNano: "1782000001500000000",
    attributes: [
      { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
      { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-4-5" } },
      { key: "gen_ai.prompt", value: { stringValue: "where is my refund" } },
    ],
    ...over,
  };
}

describe("receiving OTLP/JSON", () => {
  test("a real export request lands as a trace once it settles", async (t) => {
    const { store, url } = await serve(t);

    const res = await post(url, batch([span()]));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"partialSuccess":{}}');

    assert.equal(store.countTraces(), 0, "nothing is a trace until it settles");
    assert.deepEqual(flushSettledTraces(store, { settleMs: 0 }), { traces: 1, spans: 1, duplicates: 0 });

    const trace = store.getTrace("4bf92f3577b34da6a3ce929d0e0e4736")!;
    assert.equal(trace.agentId, "support-bot");
    assert.equal(trace.version, "v1.3");
    assert.match(trace.text, /where is my refund/);
    assert.equal(trace.startedAt, "2026-06-21T00:00:00.000Z");
    assert.equal(store.countPendingSpans(), 0);
  });

  /**
   * The regression test for the whole design: a BatchSpanProcessor flushes on a
   * size or a timer, so one conversation arrives in pieces. If the receiver ever
   * goes back to writing a Trace per request, this fails — and it fails loudly
   * rather than silently summarizing half a conversation.
   */
  test("one trace split across two POSTs assembles into a single trace", async (t) => {
    const { store, url } = await serve(t);

    await post(url, batch([span({ spanId: "aaaa000000000001" })]));
    await post(
      url,
      batch([
        span({
          spanId: "bbbb000000000002",
          startTimeUnixNano: "1782000002000000000",
          endTimeUnixNano: "1782000004000000000",
          attributes: [
            { key: "gen_ai.operation.name", value: { stringValue: "execute_tool" } },
            { key: "gen_ai.tool.name", value: { stringValue: "search_kb" } },
          ],
        }),
      ]),
    );

    assert.deepEqual(flushSettledTraces(store, { settleMs: 0 }), { traces: 1, spans: 2, duplicates: 0 });
    assert.equal(store.countTraces(), 1);

    const trace = store.getTrace("4bf92f3577b34da6a3ce929d0e0e4736")!;
    assert.equal(trace.meta.spanCount, 2);
    assert.ok(trace.text.indexOf("chat") < trace.text.indexOf("execute_tool"), `spans out of order:\n${trace.text}`);
    assert.equal(trace.startedAt, "2026-06-21T00:00:00.000Z");
    assert.equal(trace.endedAt, "2026-06-21T00:00:04.000Z");
    assert.deepEqual(trace.meta.tools, ["search_kb"]);
  });

  test("a trace is not assembled until it has been quiet for settleMs", async (t) => {
    const { store, url } = await serve(t);
    await post(url, batch([span()]));
    const now = new Date();

    assert.deepEqual(flushSettledTraces(store, { settleMs: 30_000, now }), { traces: 0, spans: 0, duplicates: 0 });
    assert.equal(store.countPendingSpans(), 1, "an unsettled trace stays staged");

    const later = new Date(now.getTime() + 31_000);
    assert.equal(flushSettledTraces(store, { settleMs: 30_000, now: later }).traces, 1);
  });

  test("an exporter retrying a batch does not duplicate its spans", async (t) => {
    const { store, url } = await serve(t);

    await post(url, batch([span()]));
    assert.equal(store.countPendingSpans(), 1);
    const res = await post(url, batch([span()]));
    assert.equal(res.status, 200);
    assert.equal(store.countPendingSpans(), 1, "same span id, same trace: staged once");

    flushSettledTraces(store, { settleMs: 0 });
    assert.equal(store.getTrace("4bf92f3577b34da6a3ce929d0e0e4736")!.meta.spanCount, 1);
  });

  test("an empty batch is a success, not an error", async (t) => {
    const { url } = await serve(t);
    const res = await post(url, JSON.stringify({ resourceSpans: [] }));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"partialSuccess":{}}');
  });

  test("gzip bodies are accepted", async (t) => {
    const { store, url } = await serve(t);
    const res = await post(url, gzipSync(Buffer.from(batch([span()]))), { "content-encoding": "gzip" });
    assert.equal(res.status, 200);
    assert.equal(flushSettledTraces(store, { settleMs: 0 }).traces, 1);
  });
});

describe("rejecting what it cannot use", () => {
  /**
   * Partial success rather than 400: a 400 makes the exporter drop the whole
   * batch, and the two good spans in it are then gone for good.
   */
  test("a batch with one unusable span keeps the rest and says how many it dropped", async (t) => {
    const { store, url } = await serve(t);

    const res = await post(
      url,
      batch([
        span({ spanId: "aaaa000000000001" }),
        span({ spanId: "bbbb000000000002", traceId: undefined }),
        span({ spanId: "cccc000000000003", traceId: "9f8e7d6c5b4a39281706f5e4d3c2b1a0" }),
      ]),
    );

    assert.equal(res.status, 200);
    const body = (await res.json()) as { partialSuccess: { rejectedSpans: string; errorMessage: string } };
    assert.equal(body.partialSuccess.rejectedSpans, "1");
    assert.equal(typeof body.partialSuccess.rejectedSpans, "string", "proto3 JSON encodes int64 as a string");
    assert.match(body.partialSuccess.errorMessage, /trace id/);

    assert.equal(store.countPendingSpans(), 2);
    assert.equal(flushSettledTraces(store, { settleMs: 0 }).traces, 2);
  });

  test("protobuf by content-type is 415 with the env var to set", async (t) => {
    const { store, url } = await serve(t);
    const res = await post(url, Buffer.from([0x0a, 0x02, 0x08, 0x01]), { "content-type": "application/x-protobuf" });

    assert.equal(res.status, 415);
    assert.match(((await res.json()) as { error: string }).error, /OTEL_EXPORTER_OTLP_PROTOCOL=http\/json/);
    assert.equal(store.countPendingSpans(), 0);
  });

  test("protobuf sniffed from its leading byte gets the same answer", async (t) => {
    const { store, url } = await serve(t);
    // No content-type at all: the exporter's default protobuf request shape.
    const res = await post(url, Buffer.from([0x0a, 0x02, 0x08, 0x01]), { "content-type": "" });

    assert.equal(res.status, 415);
    assert.match(((await res.json()) as { error: string }).error, /http\/json/);
    assert.equal(store.countPendingSpans(), 0);
  });

  test("a body over the cap is 413 and never reaches the database", async (t) => {
    const { store, url } = await serve(t, { maxBodyBytes: 512 });
    const res = await post(url, batch(Array.from({ length: 50 }, (_, i) => span({ spanId: `span${i}` }))));

    assert.equal(res.status, 413);
    assert.match(((await res.json()) as { error: string }).error, /512 byte limit/);
    assert.equal(store.countPendingSpans(), 0);
  });

  test("invalid JSON is 400", async (t) => {
    const { store, url } = await serve(t);
    const res = await post(url, "{not json");
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /not valid JSON/);
    assert.equal(store.countPendingSpans(), 0);
  });

  test("valid JSON that is not an export request is 400 naming resourceSpans", async (t) => {
    const { url } = await serve(t);
    const res = await post(url, JSON.stringify({ spans: [span()] }));
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /resourceSpans/);
  });

  test("an unsupported content-encoding is 415", async (t) => {
    const { url } = await serve(t);
    const res = await post(url, batch([span()]), { "content-encoding": "br" });
    assert.equal(res.status, 415);
    assert.match(((await res.json()) as { error: string }).error, /gzip/);
  });
});

describe("the rest of the surface", () => {
  test("a token, when set, is required", async (t) => {
    const { store, url } = await serve(t, { token: "s3cret" });

    assert.equal((await post(url, batch([span()]))).status, 401);
    assert.equal((await post(url, batch([span()]), { authorization: "Bearer wrong" })).status, 401);
    assert.equal(store.countPendingSpans(), 0);

    assert.equal((await post(url, batch([span()]), { authorization: "Bearer s3cret" })).status, 200);
    assert.equal(store.countPendingSpans(), 1);
  });

  test("healthz reports what is waiting to be assembled", async (t) => {
    const { url } = await serve(t);
    await post(url, batch([span()]));
    const res = await fetch(`${url}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok", pendingSpans: 1 });
  });

  test("wrong method, wrong signal and wrong path all say what to do instead", async (t) => {
    const { url } = await serve(t);

    const method = await fetch(`${url}/v1/traces`);
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "POST");

    const metrics = await fetch(`${url}/v1/metrics`, { method: "POST", body: "{}" });
    assert.equal(metrics.status, 404);
    assert.match(((await metrics.json()) as { error: string }).error, /traces only/);

    const nope = await fetch(`${url}/nope`);
    assert.equal(nope.status, 404);
    assert.match(((await nope.json()) as { error: string }).error, /\/v1\/traces/);
  });
});
