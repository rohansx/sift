import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { exportTheme, toMastraScorerModule, toEvalCasesModule, toJsonl, scorerIdentifier } from "../src/export/evals.ts";
import { SiftStore } from "../src/store/db.ts";
import type { Theme } from "../src/types.ts";

const FACET = "behavior";

function seeded(over: Partial<Theme> = {}): SiftStore {
  const s = new SiftStore(":memory:");
  s.insertTheme({
    id: "SIFT-14",
    facet: FACET,
    label: "tool-retry loop on search_kb",
    description: "the agent retries search_kb after it times out, without backing off",
    state: "regressed",
    centroid: [1, 0],
    memberCount: 42,
    exemplarTraceIds: ["best", "second"],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...over,
  });

  for (const [id, sim] of [["best", 0.98], ["second", 0.91], ["third", 0.80]] as const) {
    s.insertTrace({
      id,
      agentId: "support-bot",
      version: "v1.3",
      startedAt: "2026-07-15T00:00:00.000Z",
      text: `## chat (120ms)\ninput: where is my refund for order\noutput: let me look\n## execute_tool (30000ms)\ntool: search_kb args: {"q":"refund"}\nERROR: TimeoutError: search_kb timed out`,
      meta: { tools: ["search_kb"], hasError: true },
    });
    s.insertSummary({ traceId: id, facet: FACET, summary: "retried search_kb after a timeout", embedding: [1, 0] });
    s.insertAssignment({ traceId: id, facet: FACET, themeId: "SIFT-14", similarity: sim, window: "v1.3" });
  }
  return s;
}

describe("exportTheme", () => {
  test("carries the theme's identity and description", () => {
    const exp = exportTheme(seeded(), "SIFT-14");
    assert.equal(exp.themeId, "SIFT-14");
    assert.equal(exp.facet, FACET);
    assert.equal(exp.label, "tool-retry loop on search_kb");
    assert.equal(exp.state, "regressed");
    assert.equal(exp.memberCount, 42);
    assert.match(exp.description, /retries search_kb/);
  });

  test("seeds cases from the real traces that matched, best match first", () => {
    const exp = exportTheme(seeded(), "SIFT-14");
    assert.deepEqual(exp.cases.map((c) => c.sourceTraceId), ["best", "second", "third"]);
    assert.ok(exp.cases.every((c) => c.themeId === "SIFT-14"));
  });

  test("each case's input is the user's opening request, not the whole trace", () => {
    // The point is a reproducible fixture: replay this input, see if the agent
    // still does the thing. Pasting the whole trace back in would be circular.
    const exp = exportTheme(seeded(), "SIFT-14");
    assert.equal(exp.cases[0]!.input, "where is my refund for order");
    assert.ok(!exp.cases[0]!.input.includes("TimeoutError"));
  });

  test("falls back to the head of the trace when no input line is recognisable", () => {
    const s = seeded();
    s.insertTrace({ id: "odd", agentId: "x", startedAt: "2026-07-15T00:00:00.000Z", text: "## mystery_step\nsomething happened", meta: {} });
    s.insertAssignment({ traceId: "odd", facet: FACET, themeId: "SIFT-14", similarity: 0.99, window: "v1.3" });
    const exp = exportTheme(s, "SIFT-14");
    assert.match(exp.cases[0]!.input, /mystery_step|something happened/);
  });

  test("each case carries the facet summary that put it in the theme", () => {
    const exp = exportTheme(seeded(), "SIFT-14");
    assert.equal(exp.cases[0]!.symptom, "retried search_kb after a timeout");
  });

  test("cases keep the source trace's metadata for filtering and drill-down", () => {
    const exp = exportTheme(seeded(), "SIFT-14");
    assert.equal(exp.cases[0]!.version, "v1.3");
    assert.deepEqual(exp.cases[0]!.meta.tools, ["search_kb"]);
  });

  test("caps how many cases it emits", () => {
    assert.equal(exportTheme(seeded(), "SIFT-14", { maxCases: 2 }).cases.length, 2);
  });

  test("the scorer prompt names the failure mode and demands a parseable verdict", () => {
    const exp = exportTheme(seeded(), "SIFT-14");
    assert.match(exp.scorerPrompt, /tool-retry loop on search_kb/);
    assert.match(exp.scorerPrompt, /retries search_kb after it times out/);
    assert.match(exp.scorerPrompt, /JSON/);
    assert.match(exp.scorerPrompt, /score/i);
    // grounded in what the traces actually looked like, not just the label
    assert.match(exp.scorerPrompt, /retried search_kb after a timeout/);
  });

  test("scoring convention is stated unambiguously in the prompt", () => {
    // A scorer where 0 and 1 are ambiguous silently inverts every eval built on it,
    // so both directions must be spelled out, not just one.
    const exp = exportTheme(seeded(), "SIFT-14");
    assert.match(exp.scorerPrompt, /1 if the trace does NOT exhibit/i);
    assert.match(exp.scorerPrompt, /0 if the trace exhibits/i);
  });

  test("a theme with no assignments still exports, and says the fixtures are empty", () => {
    const s = new SiftStore(":memory:");
    s.insertTheme({
      id: "SIFT-1", facet: FACET, label: "lonely", description: "", state: "new",
      centroid: [1], memberCount: 0, exemplarTraceIds: [], createdAt: "x", updatedAt: "x",
    });
    const exp = exportTheme(s, "SIFT-1");
    assert.deepEqual(exp.cases, []);
    assert.match(exp.warnings.join(" "), /no traces/i);
  });

  test("an unknown theme names the id it could not find", () => {
    assert.throws(() => exportTheme(seeded(), "SIFT-99"), /SIFT-99/);
  });
});

describe("scorerIdentifier", () => {
  test("turns a theme id into a valid JS identifier", () => {
    assert.equal(scorerIdentifier("SIFT-14"), "sift14");
    assert.equal(scorerIdentifier("SIFT-1"), "sift1");
  });

  test("never starts with a digit", () => {
    assert.match(scorerIdentifier("14-SIFT"), /^[A-Za-z_]/);
  });
});

describe("generated modules", () => {
  /** Parse-checks generated JS without executing its imports. */
  function assertParses(code: string): void {
    const body = code
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("import "))
      .join("\n")
      .replace(/^export default /gm, "const __default = ")
      .replace(/^export /gm, "");
    assert.doesNotThrow(() => new Function(body), `generated module does not parse:\n${code}`);
  }

  test("the mastra scorer module parses and names things after the theme", () => {
    const code = toMastraScorerModule(exportTheme(seeded(), "SIFT-14"));
    assertParses(code);
    assert.match(code, /@mastra\/evals/);
    assert.match(code, /sift14Scorer/);
    assert.match(code, /sift14Cases/);
    assert.match(code, /SIFT-14/);
  });

  test("quotes and newlines in a label cannot break the generated module", () => {
    const s = seeded({ label: 'agent says "no" and\nstops', description: "back`tick ${injection}" });
    const code = toMastraScorerModule(exportTheme(s, "SIFT-14"));
    assertParses(code);
    assert.ok(!code.includes("${injection}") || code.includes("\\${injection}") || code.includes('"back`tick ${injection}"'));
  });

  test("the dependency-free cases module can actually be imported and used", async () => {
    // The strongest check available: run the thing we generated.
    const code = toEvalCasesModule(exportTheme(seeded(), "SIFT-14"));
    assertParses(code);
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
      theme: { id: string; label: string };
      scorerPrompt: string;
      cases: Array<{ input: string; sourceTraceId: string }>;
    };
    assert.equal(mod.theme.id, "SIFT-14");
    assert.equal(mod.cases.length, 3);
    assert.equal(mod.cases[0]!.input, "where is my refund for order");
    assert.match(mod.scorerPrompt, /tool-retry loop/);
  });

  test("jsonl emits one self-contained case per line", () => {
    const lines = toJsonl(exportTheme(seeded(), "SIFT-14")).trim().split("\n");
    assert.equal(lines.length, 3);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(first.themeId, "SIFT-14");
    assert.equal(first.input, "where is my refund for order");
    assert.ok(typeof first.scorerPrompt === "string", "each line must stand alone for streaming harnesses");
  });

  test("an empty theme produces a valid module rather than broken syntax", () => {
    const s = new SiftStore(":memory:");
    s.insertTheme({
      id: "SIFT-1", facet: FACET, label: "lonely", description: "", state: "new",
      centroid: [1], memberCount: 0, exemplarTraceIds: [], createdAt: "x", updatedAt: "x",
    });
    assertParses(toMastraScorerModule(exportTheme(s, "SIFT-1")));
    assert.equal(toJsonl(exportTheme(s, "SIFT-1")), "");
  });
});
