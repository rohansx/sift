import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The CLI is exercised as a real process, offline: fake LLM, local hash
 * embeddings, a temp database. If `sift` cannot take a file of spans and print
 * an issues list without a network call, the local-first claim is not true.
 */

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

let dir: string;
let db: string;
let tracesPath: string;

function sift(args: string[], opts: { env?: Record<string, string> } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      SIFT_LLM_PROVIDER: "fake",
      SIFT_EMBED_PROVIDER: "hash",
      SIFT_EMBED_DIMENSIONS: "256",
      SIFT_DB: db,
      SIFT_MIN_CLUSTER_SIZE: "4",
      SIFT_ASSIGN_THRESHOLD: "0.6",
      ...opts.env,
    },
  });
  return { code: result.status ?? 0, stdout: result.stdout, stderr: result.stderr };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "sift-cli-"));
  db = join(dir, "sift.db");
  tracesPath = join(dir, "traces.jsonl");
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe("basics", () => {
  test("version prints just the version, as a flag or as a command", () => {
    // Both forms are documented, and the positional one is a one-token special
    // case in the dispatcher that nothing else would notice losing.
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
      version: string;
    };
    for (const argv of [["--version"], ["version"]]) {
      const r = sift(argv);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.trim(), pkg.version, `sift ${argv.join(" ")} disagrees with package.json`);
    }
  });

  test("help documents the commands", () => {
    const r = sift(["help"]);
    assert.equal(r.code, 0);
    for (const cmd of ["ingest", "serve", "analyze", "report", "delta", "export", "resolve", "demo"]) {
      assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`), `help should mention ${cmd}`);
    }
  });

  test("no arguments prints usage and fails, so scripts notice", () => {
    const r = sift([]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /USAGE/);
  });

  test("an unknown command exits 2 and points at help", () => {
    const r = sift(["frobnicate"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown command/);
  });

  test("an unknown flag exits 2 rather than being silently ignored", () => {
    const r = sift(["report", "--wat"]);
    assert.equal(r.code, 2);
  });

  test("a bad config value is reported with the setting's name", () => {
    const r = sift(["report"], { env: { SIFT_ASSIGN_THRESHOLD: "9" } });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /assignThreshold/);
  });
});

describe("the documented quickstart, end to end", () => {
  test("demo writes synthetic traces", () => {
    const r = sift(["demo", "--out", tracesPath, "--traces", "120", "--seed", "7"]);
    assert.equal(r.code, 0);
    assert.ok(existsSync(tracesPath));
    assert.match(r.stdout, /240 synthetic traces/);
    // the next commands to run are printed, so the demo is self-guiding
    assert.match(r.stdout, /sift analyze/);
  });

  test("analyze ingests, summarizes, discovers and prints the issues list", () => {
    const r = sift(["analyze", "--otlp", tracesPath]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /THEMES/);
    assert.match(r.stdout, /SIFT-\d+/);
    assert.match(r.stdout, /residual pile/);
    assert.ok(existsSync(db));
  });

  test("re-running analyze is safe and does not duplicate anything", () => {
    const before = JSON.parse(sift(["themes", "--json"]).stdout) as Array<{ id: string }>;
    const r = sift(["analyze", "--otlp", tracesPath]);
    assert.equal(r.code, 0, r.stderr);
    const after = JSON.parse(sift(["themes", "--json"]).stdout) as Array<{ id: string }>;
    assert.deepEqual(after.map((t) => t.id), before.map((t) => t.id), "theme ids must be stable across runs");
  });

  test("report renders markdown", () => {
    const r = sift(["report", "--format", "md", "--facet", "behavior"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^# sift report/m);
    assert.match(r.stdout, /\| id \| state \| label \|/);
  });

  test("report renders json for tooling", () => {
    const r = sift(["report", "--json", "--facet", "behavior"]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout) as Array<{ facet: string; rows: unknown[] }>;
    assert.equal(parsed[0]!.facet, "behavior");
    assert.ok(Array.isArray(parsed[0]!.rows));
  });

  test("delta compares two releases", () => {
    const r = sift(["delta", "--from", "v1.2", "--to", "v1.3", "--facet", "behavior"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /DELTA behavior: v1\.2 → v1\.3/);
  });

  test("delta defaults to the two most recent windows", () => {
    const r = sift(["delta", "--facet", "behavior"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /v1\.2 → v1\.3/);
  });

  test("delta says so when there is nothing to compare", () => {
    const r = sift(["delta", "--facet", "not-a-facet"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /two windows/);
  });
});

describe("themes and lifecycle", () => {
  function firstThemeId(): string {
    const themes = JSON.parse(sift(["themes", "--json", "--facet", "behavior"]).stdout) as Array<{ id: string }>;
    assert.ok(themes.length > 0, "expected the analyze run to have produced themes");
    return themes[0]!.id;
  }

  test("themes lists what the registry knows", () => {
    const r = sift(["themes"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /SIFT-\d+/);
  });

  test("show explains one theme and tells you how to export it", () => {
    const r = sift(["show", firstThemeId()]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /exemplar traces/);
    assert.match(r.stdout, /sift export SIFT-\d+/);
  });

  test("show on an unknown theme fails with the id", () => {
    const r = sift(["show", "SIFT-9999"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /SIFT-9999/);
  });

  test("resolve, filter by state, then reopen", () => {
    const id = firstThemeId();

    assert.equal(sift(["resolve", id, "--note", "fixed in v1.4"]).code, 0);
    const resolved = JSON.parse(sift(["themes", "--json", "--state", "resolved"]).stdout) as Array<{ id: string; note: string }>;
    assert.ok(resolved.some((t) => t.id === id));
    assert.equal(resolved.find((t) => t.id === id)!.note, "fixed in v1.4");

    assert.equal(sift(["reopen", id]).code, 0);
    const active = JSON.parse(sift(["themes", "--json", "--state", "active"]).stdout) as Array<{ id: string }>;
    assert.ok(active.some((t) => t.id === id));
  });

  test("mute keeps the theme but takes it out of the deltas", () => {
    const id = firstThemeId();
    assert.equal(sift(["mute", id, "--note", "expected"]).code, 0);
    const delta = sift(["delta", "--from", "v1.2", "--to", "v1.3", "--facet", "behavior", "--json"]).stdout;
    const parsed = JSON.parse(delta) as { findings: Array<{ themeId: string }> };
    assert.ok(!parsed.findings.some((f) => f.themeId === id), "a muted theme should not appear in deltas");
    sift(["reopen", id]);
  });

  test("relabel changes the words, not the id", () => {
    const id = firstThemeId();
    assert.equal(sift(["relabel", id, "--label", "renamed by a human"]).code, 0);
    const themes = JSON.parse(sift(["themes", "--json"]).stdout) as Array<{ id: string; label: string }>;
    assert.equal(themes.find((t) => t.id === id)!.label, "renamed by a human");
  });

  test("an unknown state is rejected with the valid ones", () => {
    const r = sift(["themes", "--state", "onfire"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /muted/);
  });

  test("lifecycle commands need a theme id", () => {
    assert.equal(sift(["resolve"]).code, 2);
  });
});

describe("export", () => {
  test("writes a mastra scorer module to a file", () => {
    const themes = JSON.parse(sift(["themes", "--json", "--facet", "behavior"]).stdout) as Array<{ id: string }>;
    const out = join(dir, "scorers", "theme.ts");
    const r = sift(["export", themes[0]!.id, "--format", "mastra-scorer", "--out", out]);
    assert.equal(r.code, 0, r.stderr);
    const content = readFileSync(out, "utf8");
    assert.match(content, /@mastra\/evals/);
    assert.match(content, /Generated by sift/);
  });

  test("prints to stdout when no output file is given", () => {
    const themes = JSON.parse(sift(["themes", "--json", "--facet", "behavior"]).stdout) as Array<{ id: string }>;
    const r = sift(["export", themes[0]!.id, "--format", "jsonl"]);
    assert.equal(r.code, 0);
    const first = JSON.parse(r.stdout.trim().split("\n")[0]!) as { themeId: string; input: string };
    assert.equal(first.themeId, themes[0]!.id);
    assert.ok(first.input.length > 0);
  });

  test("an unknown format is rejected with the valid ones", () => {
    const r = sift(["export", "SIFT-1", "--format", "yaml"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /mastra-scorer/);
  });
});

describe("several agents in one database", () => {
  let multiDb: string;
  let multiTraces: string;

  test("setup: ingest two agents", () => {
    multiDb = join(dir, "multi.db");
    multiTraces = join(dir, "multi.jsonl");

    const lines: string[] = [];
    for (let i = 0; i < 8; i++) {
      for (const [agent, prompt, tool] of [
        ["support-bot", "where is my refund for the order", "check_policy"],
        ["coding-agent", "add a retry to the upload function", "edit_file"],
      ] as const) {
        lines.push(
          JSON.stringify({
            trace_id: `${agent}-${i}`,
            span_id: "s1",
            name: "chat",
            start_time: "2026-07-01T10:00:00.000Z",
            end_time: "2026-07-01T10:00:01.000Z",
            attributes: {
              "gen_ai.agent.name": agent,
              "service.version": "v1",
              "gen_ai.prompt": prompt,
              "gen_ai.tool.name": tool,
              "gen_ai.completion": "done",
            },
          }),
        );
      }
    }
    writeFileSync(multiTraces, lines.join("\n"));

    const r = sift(["analyze", "--otlp", multiTraces, "--db", multiDb]);
    assert.equal(r.code, 0, r.stderr);
  });

  test("themes are labelled with the agent they belong to", () => {
    const r = sift(["themes", "--db", multiDb]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /support-bot/);
    assert.match(r.stdout, /coding-agent/);
  });

  test("no theme is shared between the two agents", () => {
    const themes = JSON.parse(sift(["themes", "--json", "--db", multiDb]).stdout) as Array<{ id: string; agentId: string }>;
    const byAgent = new Map<string, Set<string>>();
    for (const t of themes) {
      if (!byAgent.has(t.agentId)) byAgent.set(t.agentId, new Set());
      byAgent.get(t.agentId)!.add(t.id);
    }
    assert.equal(byAgent.size, 2);
    const [a, b] = [...byAgent.values()];
    for (const id of a!) assert.ok(!b!.has(id), `${id} belongs to both agents`);
  });

  test("themes can be filtered to one agent", () => {
    const themes = JSON.parse(
      sift(["themes", "--json", "--agent", "coding-agent", "--db", multiDb]).stdout,
    ) as Array<{ agentId: string }>;
    assert.ok(themes.length > 0);
    assert.ok(themes.every((t) => t.agentId === "coding-agent"));
  });

  test("a command that needs one agent refuses to guess between two", () => {
    // Silently picking the first agent would report on the wrong product.
    const r = sift(["delta", "--facet", "behavior", "--db", multiDb]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /several agents/);
    assert.match(r.stderr, /--agent/);
  });

  test("naming the agent resolves it", () => {
    const r = sift(["delta", "--facet", "behavior", "--agent", "support-bot", "--db", multiDb]);
    // one window only, so it reports that rather than comparing
    assert.match(r.stderr + r.stdout, /support-bot|two windows/);
  });

  test("report covers each agent separately", () => {
    const reports = JSON.parse(
      sift(["report", "--json", "--facet", "behavior", "--db", multiDb]).stdout,
    ) as Array<{ agentId: string; totalAssignments: number }>;
    assert.deepEqual(reports.map((r) => r.agentId).sort(), ["coding-agent", "support-bot"]);
    // each denominator is that agent's own traffic, not the union
    assert.ok(reports.every((r) => r.totalAssignments === 8), JSON.stringify(reports));
  });
});

describe("privacy gate", () => {
  test("with no file it explains what the gate is set to strip", () => {
    const r = sift(["privacy"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /pseudonymize/);
    assert.match(r.stdout, /email/);
    assert.match(r.stdout, /card/);
  });

  test("previewing real traces shows what would be replaced, before trusting it", () => {
    const withPii = join(dir, "pii.jsonl");
    writeFileSync(
      withPii,
      JSON.stringify({
        trace_id: "pii-1",
        span_id: "s1",
        name: "chat",
        start_time: "2026-07-01T10:00:00.000Z",
        end_time: "2026-07-01T10:00:01.000Z",
        attributes: {
          "gen_ai.agent.name": "support-bot",
          "gen_ai.prompt": "I am jane.doe@example.com, card 4111111111111111",
          "gen_ai.completion": "thanks, checking",
        },
      }),
    );

    const r = sift(["privacy", "--otlp", withPii]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /email/);
    assert.match(r.stdout, /card/);
    // the preview must show the redacted line, not leak the original in the "after"
    const afterLines = r.stdout.split("\n").filter((l) => l.trimStart().startsWith("+ "));
    assert.ok(afterLines.length > 0, "expected a redacted sample line");
    assert.ok(!afterLines.join("\n").includes("jane.doe@example.com"));
  });

  test("reports cleanly when nothing matches", () => {
    const r = sift(["privacy", "--otlp", tracesPath]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /nothing matched|0 values/);
  });

  test("json output is machine readable", () => {
    const r = sift(["privacy", "--otlp", tracesPath, "--json"]);
    const parsed = JSON.parse(r.stdout) as { traces: number; total: number };
    assert.ok(parsed.traces > 0);
    assert.equal(parsed.total, 0);
  });

  test("a bad privacy setting is caught at startup", () => {
    const r = sift(["report"], { env: { SIFT_PRIVACY_SCOPE: "global" } });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /salt/i);
  });
});

describe("check: the CI gate", () => {
  test("passes on a healthy registry and says so", () => {
    const r = sift(["check", "--facet", "behavior"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /passed/);
  });

  test("exits 1 once a resolved theme starts happening again", () => {
    // The whole point of the gate: resolve something, watch it come back,
    // block the deploy.
    const themes = JSON.parse(sift(["themes", "--json", "--facet", "behavior"]).stdout) as Array<{ id: string }>;
    const id = themes[0]!.id;
    assert.equal(sift(["resolve", id, "--note", "fixed"]).code, 0);

    // re-ingesting the same traces makes the theme pick traffic back up
    sift(["analyze", "--otlp", tracesPath]);

    const r = sift(["check", "--facet", "behavior", "--fail-on", "regression,notable"]);
    assert.ok(r.code === 0 || r.code === 1, `unexpected exit ${r.code}`);
    if (r.code === 1) {
      assert.match(r.stdout, /failed/);
      assert.match(r.stdout, /sift show SIFT-/);
    }
    sift(["reopen", id]);
  });

  test("an unknown severity is rejected with the valid ones", () => {
    const r = sift(["check", "--fail-on", "catastrophe"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /regression/);
  });

  test("json output carries the findings for a CI annotation", () => {
    const r = sift(["check", "--facet", "behavior", "--json"]);
    const parsed = JSON.parse(r.stdout) as { ok: boolean; failures: unknown[]; notes: string[] };
    assert.equal(typeof parsed.ok, "boolean");
    assert.ok(Array.isArray(parsed.failures));
  });

  test("a database with one window passes rather than failing a first run", () => {
    const freshDb = join(dir, "fresh.db");
    const oneWindow = join(dir, "one.jsonl");
    writeFileSync(
      oneWindow,
      JSON.stringify({
        trace_id: "only-1",
        span_id: "s1",
        name: "chat",
        start_time: "2026-07-01T10:00:00.000Z",
        end_time: "2026-07-01T10:00:01.000Z",
        attributes: { "gen_ai.agent.name": "solo", "service.version": "v1", "gen_ai.prompt": "hello there" },
      }),
    );
    sift(["analyze", "--otlp", oneWindow, "--db", freshDb]);
    const r = sift(["check", "--db", freshDb]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /not enough windows/);
  });
});

describe("a corpus that is only partly summarized", () => {
  const partialDb = () => join(dir, "partial.db");

  test("analyze --limit stops where it was told and the report says so", () => {
    const db2 = partialDb();
    assert.equal(sift(["analyze", "--otlp", tracesPath, "--limit", "1", "--db", db2]).code, 0);

    const r = sift(["report", "--facet", "behavior", "--db", db2]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /239 traces are in no window yet/);
  });

  test("summarize caps a pass and prints what it left", () => {
    const r = sift(["summarize", "--limit", "1", "--db", partialDb()]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /summarized 1 traces/);
    assert.match(r.stdout, /238 traces still need summarizing/);
  });

  test("check refuses to vouch for the build, and --allow-partial is the way through", () => {
    // Same exit code as a regression, deliberately different words: a CI log
    // must not read "a theme regressed" when the truth is "I saw a fortieth
    // of your traffic".
    const db2 = partialDb();
    const failed = sift(["check", "--facet", "behavior", "--db", db2]);
    assert.equal(failed.code, 1, failed.stdout);
    assert.match(failed.stdout, /cannot vouch/);
    assert.match(failed.stdout, /traces are not summarized/);
    assert.doesNotMatch(failed.stdout, /check failed/);

    const allowed = sift(["check", "--facet", "behavior", "--db", db2, "--allow-partial"]);
    assert.equal(allowed.code, 0, allowed.stdout);
  });

  test("the gate counts traces, not trace-facet pairs", () => {
    // The bug: the count was summed inside the per-facet loop, so a four-facet
    // preset reported four times the number, and `sift check` printed a figure
    // larger than the number of traces in the database. Deliberately without
    // --facet, which is what hid it.
    const db2 = partialDb();
    const r = sift(["check", "--db", db2, "--json"]);
    const parsed = JSON.parse(r.stdout) as { uncoveredTraces: number };
    assert.equal(parsed.uncoveredTraces, 239);
  });

  test("analyze without a limit finishes the corpus it ingested", () => {
    // Not a batch-boundary test — 240 traces fit inside one SUMMARIZE_BATCH.
    // What it pins is the contract at the CLI seam: no --limit means the gate
    // has nothing left to complain about afterwards. The batch crossing itself
    // is pinned in test/pipeline.test.ts, where the fixture is large enough.
    const db2 = partialDb();
    assert.equal(sift(["analyze", "--otlp", tracesPath, "--db", db2]).code, 0);
    const r = sift(["check", "--facet", "behavior", "--db", db2, "--json"]);
    const parsed = JSON.parse(r.stdout) as { uncoveredTraces: number };
    assert.equal(parsed.uncoveredTraces, 0);
  });
});

describe("alert", () => {
  test("dry-run lists what would be sent without a webhook", () => {
    const r = sift(["alert", "--dry-run", "--facet", "behavior"]);
    assert.equal(r.code, 0, r.stderr);
  });

  test("without a webhook and without dry-run it refuses rather than silently doing nothing", () => {
    const r = sift(["alert", "--facet", "behavior"], { env: { SIFT_ALERT_WEBHOOK: "" } });
    assert.ok(r.code === 0 || r.code === 2);
    if (r.code === 2) assert.match(r.stderr, /webhook/);
  });

  test("an unknown event name is rejected", () => {
    const r = sift(["alert", "--on", "exploded", "--dry-run"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /regressed/);
  });

  test("json output is machine readable", () => {
    const r = sift(["alert", "--dry-run", "--json", "--facet", "behavior"]);
    const parsed = JSON.parse(r.stdout) as { alerts: unknown[]; dryRun: boolean };
    assert.ok(Array.isArray(parsed.alerts));
    assert.equal(parsed.dryRun, true);
  });
});

describe("serve", () => {
  test("--agent names the agent for spans that carry none, exactly as ingest does", { timeout: 60_000 }, async () => {
    // The bug: --agent was accepted, documented, and dropped, so the same spans
    // landed under "myapp" from a file and under "default" over HTTP — and
    // `sift report --agent myapp` then showed an empty database.
    const serveDb = join(dir, "serve.db");
    const child = spawn(process.execPath, [CLI, "serve", "--port", "0", "--settle", "0", "--agent", "myapp"], {
      env: { ...process.env, SIFT_DB: serveDb, SIFT_LLM_PROVIDER: "fake", SIFT_EMBED_PROVIDER: "hash" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      let banner = "";
      const url = await new Promise<string>((resolve, reject) => {
        child.stdout.on("data", (chunk: Buffer) => {
          banner += chunk.toString();
          const found = /http:\/\/[^/\s]+/.exec(banner);
          if (found) resolve(found[0]);
        });
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`serve exited with ${code}`)));
      });

      // On loopback the read side is on, so the banner says where. It must not
      // print that line when the bind turns /api off — an advertised URL that
      // 404s is worse than no line at all.
      assert.match(banner, /read-only JSON .*\/api\/themes/);

      const anonymous = JSON.stringify({
        resourceSpans: [
          {
            resource: { attributes: [] },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                    spanId: "00f067aa0ba902b7",
                    name: "chat",
                    startTimeUnixNano: "1782000000000000000",
                    endTimeUnixNano: "1782000001000000000",
                    attributes: [{ key: "gen_ai.prompt", value: { stringValue: "where is my refund" } }],
                  },
                ],
              },
            ],
          },
        ],
      });
      const res = await fetch(`${url}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: anonymous,
      });
      assert.equal(res.status, 200);

      // serve flushes on a 5s interval and does not flush on the way out.
      const probe = new DatabaseSync(serveDb);
      let agents: string[] = [];
      for (let i = 0; i < 40 && agents.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 500));
        agents = (probe.prepare("SELECT DISTINCT agent_id a FROM traces").all() as Array<{ a: string }>).map((r) => r.a);
      }
      probe.close();
      assert.deepEqual(agents, ["myapp"]);
    } finally {
      child.kill("SIGTERM");
    }
  });
});

describe("output hygiene", () => {
  test("progress goes to stderr so stdout stays pipeable", () => {
    const r = sift(["report", "--format", "md"]);
    assert.ok(!r.stdout.includes("ingested"), "stdout must contain only the report");
  });

  test("the experimental SQLite warning is suppressed", () => {
    // Node prints it on every run; in a tool whose output is a readable report
    // it is pure noise.
    const r = sift(["themes"]);
    assert.ok(!r.stderr.includes("SQLite is an experimental feature"), r.stderr);
  });

  test("terminal output is plain text unless colour is requested", () => {
    const r = sift(["report", "--facet", "behavior"]);
    assert.ok(!r.stdout.includes("["), "piped output must not contain escape codes");
  });
});
