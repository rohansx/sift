import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ingestOtlpJsonlFile, parseOtlpJsonl } from "../src/ingest/otlp.ts";
import { windowForTrace } from "../src/window.ts";
import { withTempDir } from "../src/testing/temp.ts";

const jsonl = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join("\n");

/** The flat-attributes shape Langfuse/Phoenix/OpenLIT JSON exports tend to use. */
const flatSpan = (over: Record<string, unknown> = {}) => ({
  trace_id: "trace-a",
  span_id: "s1",
  name: "chat",
  start_time: "2026-07-01T10:00:00.000Z",
  end_time: "2026-07-01T10:00:01.000Z",
  attributes: {
    "gen_ai.operation.name": "chat",
    "gen_ai.agent.name": "support-bot",
    "service.version": "v1.3",
    "gen_ai.prompt": "where is my refund",
    "gen_ai.completion": "let me check that",
    ...((over.attributes as Record<string, unknown>) ?? {}),
  },
  ...over,
});

describe("grouping", () => {
  test("groups spans into one trace per trace_id", () => {
    const result = parseOtlpJsonl(
      jsonl(
        flatSpan({ trace_id: "a", span_id: "1" }),
        flatSpan({ trace_id: "a", span_id: "2" }),
        flatSpan({ trace_id: "b", span_id: "3" }),
      ),
    );
    assert.equal(result.traces.length, 2);
    assert.equal(result.spanCount, 3);
    assert.deepEqual(result.traces.map((t) => t.id).sort(), ["a", "b"]);
    assert.equal(result.traces.find((t) => t.id === "a")!.meta.spanCount, 2);
  });

  test("orders spans by start time regardless of file order", () => {
    const result = parseOtlpJsonl(
      jsonl(
        flatSpan({ span_id: "late", start_time: "2026-07-01T10:00:09.000Z", attributes: { "gen_ai.operation.name": "second" } }),
        flatSpan({ span_id: "early", start_time: "2026-07-01T10:00:01.000Z", attributes: { "gen_ai.operation.name": "first" } }),
      ),
    );
    const text = result.traces[0]!.text;
    assert.ok(text.indexOf("first") < text.indexOf("second"), `spans out of order:\n${text}`);
  });

  test("trace start and end span the whole span set", () => {
    const result = parseOtlpJsonl(
      jsonl(
        flatSpan({ span_id: "1", start_time: "2026-07-01T10:00:05.000Z", end_time: "2026-07-01T10:00:06.000Z" }),
        flatSpan({ span_id: "2", start_time: "2026-07-01T10:00:01.000Z", end_time: "2026-07-01T10:00:20.000Z" }),
      ),
    );
    const t = result.traces[0]!;
    assert.equal(t.startedAt, "2026-07-01T10:00:01.000Z");
    assert.equal(t.endedAt, "2026-07-01T10:00:20.000Z");
    assert.equal(t.meta.durationMs, 19000);
  });

  test("accepts camelCase keys as well as snake_case", () => {
    const result = parseOtlpJsonl(
      jsonl({
        traceId: "camel",
        spanId: "s1",
        name: "chat",
        startTime: "2026-07-01T10:00:00.000Z",
        endTime: "2026-07-01T10:00:01.000Z",
        attributes: { "gen_ai.agent.name": "bot" },
      }),
    );
    assert.equal(result.traces[0]!.id, "camel");
    assert.equal(result.traces[0]!.agentId, "bot");
  });
});

describe("attribute shapes", () => {
  test("reads OTLP protobuf-JSON attribute arrays", () => {
    const result = parseOtlpJsonl(
      jsonl({
        traceId: "otlp",
        spanId: "s1",
        name: "chat",
        startTimeUnixNano: "1782000000000000000",
        endTimeUnixNano: "1782000001000000000",
        attributes: [
          { key: "gen_ai.agent.name", value: { stringValue: "otlp-bot" } },
          { key: "service.version", value: { stringValue: "v2.0" } },
          { key: "gen_ai.usage.input_tokens", value: { intValue: "1200" } },
          { key: "gen_ai.prompt", value: { stringValue: "hello" } },
        ],
      }),
    );
    const t = result.traces[0]!;
    assert.equal(t.agentId, "otlp-bot");
    assert.equal(t.version, "v2.0");
    assert.match(t.text, /hello/);
  });

  test("reads a full ExportTraceServiceRequest envelope", () => {
    // What `otel-cli`/collector file exporters write: one request object per line.
    const result = parseOtlpJsonl(
      jsonl({
        resourceSpans: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "pipeline-agent" } }] },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "envelope",
                    spanId: "s1",
                    name: "invoke_agent",
                    startTimeUnixNano: "1782000000000000000",
                    endTimeUnixNano: "1782000002000000000",
                    attributes: [{ key: "gen_ai.prompt", value: { stringValue: "run the batch" } }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    assert.equal(result.traces.length, 1);
    assert.equal(result.traces[0]!.id, "envelope");
    assert.equal(result.traces[0]!.agentId, "pipeline-agent", "resource attributes should supply the agent name");
    assert.match(result.traces[0]!.text, /run the batch/);
  });

  test("nanosecond timestamps convert to ISO", () => {
    const result = parseOtlpJsonl(
      jsonl({ traceId: "n", spanId: "s", startTimeUnixNano: "1782000000000000000", endTimeUnixNano: "1782000000500000000" }),
    );
    assert.equal(result.traces[0]!.startedAt, new Date(1782000000000).toISOString());
    assert.equal(result.traces[0]!.meta.durationMs, 500);
  });

  test("epoch-millisecond numbers also work", () => {
    const result = parseOtlpJsonl(jsonl({ traceId: "m", spanId: "s", start_time: 1782000000000, end_time: 1782000000250 }));
    assert.equal(result.traces[0]!.startedAt, new Date(1782000000000).toISOString());
  });
});

describe("trace identity", () => {
  test("agent name falls back through the documented chain", () => {
    const from = (attrs: Record<string, unknown>) =>
      parseOtlpJsonl(jsonl({ traceId: "x", spanId: "s", start_time: 0, attributes: attrs }), { agentId: "fallback" })
        .traces[0]!.agentId;

    assert.equal(from({ "gen_ai.agent.name": "a", "service.name": "b" }), "a");
    assert.equal(from({ "service.name": "b" }), "b");
    assert.equal(from({}), "fallback");
  });

  test("version comes from service.version or deployment tags", () => {
    const from = (attrs: Record<string, unknown>) =>
      parseOtlpJsonl(jsonl({ traceId: "x", spanId: "s", start_time: 0, attributes: attrs })).traces[0]!.version;

    assert.equal(from({ "service.version": "v1.3" }), "v1.3");
    assert.equal(from({ "deployment.environment.version": "v9" }), "v9");
    assert.equal(from({}), undefined);
  });

  test("any span in a trace can supply the agent name, not just the first", () => {
    const result = parseOtlpJsonl(
      jsonl(
        { traceId: "x", spanId: "1", start_time: 0, attributes: {} },
        { traceId: "x", spanId: "2", start_time: 1, attributes: { "gen_ai.agent.name": "late-bot" } },
      ),
    );
    assert.equal(result.traces[0]!.agentId, "late-bot");
  });
});

describe("rendering", () => {
  test("renders prompts, completions, tools and durations", () => {
    const result = parseOtlpJsonl(
      jsonl(
        flatSpan({
          span_id: "1",
          attributes: {
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": "some-model",
            "gen_ai.prompt": "where is my refund",
            "gen_ai.completion": "checking now",
          },
        }),
        {
          trace_id: "trace-a",
          span_id: "2",
          name: "execute_tool",
          start_time: "2026-07-01T10:00:02.000Z",
          end_time: "2026-07-01T10:00:32.000Z",
          attributes: {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": "search_kb",
            "gen_ai.tool.input": '{"q":"refund policy"}',
            "gen_ai.tool.output": "timeout after 30s",
          },
        },
      ),
    );
    const text = result.traces[0]!.text;
    assert.match(text, /## chat/);
    assert.match(text, /input: where is my refund/);
    assert.match(text, /output: checking now/);
    assert.match(text, /tool: search_kb/);
    assert.match(text, /refund policy/);
    assert.match(text, /timeout after 30s/);
    // duration matters: retry loops and timeouts are exactly what facets look for
    assert.match(text, /30000ms|30\.0s/);
  });

  test("renders chat message arrays as role: content lines", () => {
    const result = parseOtlpJsonl(
      jsonl(
        flatSpan({
          attributes: {
            "gen_ai.input.messages": JSON.stringify([
              { role: "system", content: "you are a support agent" },
              { role: "user", content: "i want a refund" },
            ]),
            "gen_ai.output.messages": JSON.stringify([{ role: "assistant", content: "i can help" }]),
          },
        }),
      ),
    );
    const text = result.traces[0]!.text;
    assert.match(text, /user: i want a refund/);
    assert.match(text, /assistant: i can help/);
  });

  test("surfaces exception events and error status", () => {
    const result = parseOtlpJsonl(
      jsonl({
        trace_id: "err",
        span_id: "s",
        name: "execute_tool",
        start_time: 0,
        end_time: 1,
        status: { code: "STATUS_CODE_ERROR", message: "upstream 503" },
        events: [
          { name: "exception", attributes: { "exception.type": "TimeoutError", "exception.message": "search_kb timed out" } },
        ],
      }),
    );
    const t = result.traces[0]!;
    assert.match(t.text, /TimeoutError/);
    assert.match(t.text, /search_kb timed out/);
    assert.match(t.text, /upstream 503/);
    assert.equal(t.meta.hasError, true);
  });

  test("meta records the tools a trace used, for drill-down and eval export", () => {
    const result = parseOtlpJsonl(
      jsonl(
        flatSpan({ span_id: "1", attributes: { "gen_ai.tool.name": "search_kb" } }),
        flatSpan({ span_id: "2", attributes: { "gen_ai.tool.name": "search_kb" } }),
        flatSpan({ span_id: "3", attributes: { "gen_ai.tool.name": "issue_refund" } }),
      ),
    );
    assert.deepEqual(result.traces[0]!.meta.tools, ["search_kb", "issue_refund"]);
  });

  test("a trace with no renderable attributes still produces non-empty text", () => {
    const result = parseOtlpJsonl(jsonl({ traceId: "bare", spanId: "s", name: "mystery_step", start_time: 0 }));
    assert.match(result.traces[0]!.text, /mystery_step/);
  });
});

describe("robustness", () => {
  test("blank lines and whitespace are ignored", () => {
    const result = parseOtlpJsonl(`\n  \n${JSON.stringify(flatSpan())}\n\n`);
    assert.equal(result.traces.length, 1);
    assert.equal(result.skippedLines, 0);
  });

  test("malformed lines are skipped and reported, not fatal", () => {
    const result = parseOtlpJsonl(jsonl(flatSpan()) + "\n{ not json\n" + jsonl(flatSpan({ trace_id: "b" })));
    assert.equal(result.traces.length, 2);
    assert.equal(result.skippedLines, 1);
    assert.match(result.errors[0]!, /line 2/);
  });

  test("strict mode turns a malformed line into a throw", () => {
    assert.throws(() => parseOtlpJsonl("{ not json", { strict: true }), /line 1/);
  });

  test("spans without a trace id are skipped and counted", () => {
    const result = parseOtlpJsonl(jsonl({ spanId: "orphan", start_time: 0 }, flatSpan()));
    assert.equal(result.traces.length, 1);
    assert.equal(result.skippedLines, 1);
  });

  test("empty input yields no traces rather than throwing", () => {
    const result = parseOtlpJsonl("");
    assert.deepEqual(result.traces, []);
  });

  test("reads from a file", () => {
    withTempDir((dir) => {
      const p = join(dir, "traces.jsonl");
      writeFileSync(p, jsonl(flatSpan()));
      assert.equal(ingestOtlpJsonlFile(p).traces.length, 1);
    });
  });

  test("a missing file names the path", () => {
    assert.throws(() => ingestOtlpJsonlFile("/nope/traces.jsonl"), /\/nope\/traces\.jsonl/);
  });
});

describe("windowForTrace", () => {
  test("prefers the version tag, so deltas line up with deploys", () => {
    assert.equal(
      windowForTrace({ id: "a", agentId: "x", version: "v1.3", startedAt: "2026-07-01T10:00:00.000Z", text: "", meta: {} }),
      "v1.3",
    );
  });

  test("falls back to the calendar day when there is no version", () => {
    assert.equal(
      windowForTrace({ id: "a", agentId: "x", startedAt: "2026-07-01T10:00:00.000Z", text: "", meta: {} }),
      "2026-07-01",
    );
  });
});
