import { test, describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publishSite, STATIC_MARKER, DATA_FILE } from "../src/publish/index.ts";
import { UI_NOT_BUILT } from "../src/serve/static.ts";
import { Pipeline } from "../src/pipeline.ts";
import { SiftStore } from "../src/store/db.ts";
import { DEFAULT_CONFIG, type SiftConfig } from "../src/config.ts";
import { buildFacetReport } from "../src/report/model.ts";
import { HashEmbedder } from "../src/embed/index.ts";
import { KeywordSummarizer, StubLabeler } from "../src/testing/fakes.ts";

/**
 * `sift publish` — the dashboard written out to somewhere sift is not running.
 *
 * Two properties carry the weight, and both fail silently if they break. The
 * bundle must say exactly what the live API says, or the published site and
 * `sift report` disagree and neither is obviously the wrong one. And it must
 * carry no raw identifiers: this is the only command that puts trace text on a
 * URL other people can reach, so the gate that guards the model path has to
 * guard this one harder.
 */

const AGENT = "support-bot";
const FACET = "goal";

const PII =
  "user: Hi, I am jane.doe@acme.co and my card 4111111111111111 was charged twice.\n" +
  "assistant: I emailed support@acme.co about 550e8400-e29b-41d4-a716-446655440000 from 10.4.221.9\n";

function seed(store: SiftStore, traceText: string): void {
  store.insertTheme({
    id: "SIFT-14",
    agentId: AGENT,
    facet: FACET,
    label: "tool-retry loop on search_kb",
    description: "traces whose goal resembles a retry loop",
    state: "regressed",
    centroid: [1, 0],
    memberCount: 4,
    exemplarTraceIds: ["t-1", "t-2"],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });

  for (const [window, counts] of [
    ["v1.2", 2],
    ["v1.3", 6],
  ] as const) {
    for (let i = 0; i < counts; i++) {
      const id = `${window}-${i}`;
      store.insertTrace({ id, agentId: AGENT, version: window, startedAt: "2026-07-02T00:00:00.000Z", text: "", meta: {} });
      store.insertAssignment({ traceId: id, agentId: AGENT, facet: FACET, themeId: "SIFT-14", similarity: 0.9, window });
    }
  }

  for (const id of ["t-1", "t-2"]) {
    store.insertTrace({ id, agentId: AGENT, version: "v1.3", startedAt: "2026-07-02T00:00:00.000Z", text: traceText, meta: {} });
  }
  store.insertSummaries([
    { traceId: "t-1", facet: FACET, summary: `contact ${"jane.doe@acme.co"} about a duplicate charge` },
    { traceId: "t-2", facet: FACET, summary: "user wants the status of a refund" },
  ]);
}

interface World {
  store: SiftStore;
  cfg: SiftConfig;
  pipeline: Pipeline;
}

function world(t: TestContext, traceText = ""): World {
  const store = new SiftStore(":memory:");
  seed(store, traceText);
  const cfg: SiftConfig = { ...DEFAULT_CONFIG, dbPath: ":memory:" };
  const pipeline = new Pipeline(store, cfg, {
    summarizer: new KeywordSummarizer(),
    embedder: new HashEmbedder(64),
    labeler: new StubLabeler(),
  });
  t.after(() => store.close());
  return { store, cfg, pipeline };
}

/**
 * A stand-in for `npm run build:ui`: `npm run check` does not build.
 *
 * Two pages, because that is what the real build emits — the landing page at
 * the root and the dashboard under app/.
 */
function fixtureUi(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "sift-pub-ui-"));
  mkdirSync(join(dir, "assets"));
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><h1>sift</h1>");
  writeFileSync(join(dir, "app", "index.html"), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dir, "assets", "index-abc123.js"), 'console.log("sift")');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function outDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "sift-pub-out-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "site");
}

function bundleAt(dir: string): { __sift: string; generatedAt: string; redacted: boolean; responses: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(dir, DATA_FILE), "utf8"));
}

describe("sift publish", () => {
  test("refuses rather than shipping a site with no dashboard in it", async (t) => {
    const w = world(t);
    await assert.rejects(
      () =>
        publishSite({
          pipeline: w.pipeline,
          cfg: w.cfg,
          outDir: outDir(t),
          uiRoot: join(tmpdir(), "sift-ui-that-does-not-exist"),
        }),
      (err: Error) => err.message === UI_NOT_BUILT,
    );
  });

  test("the bundle is what the live API answers, not a second derivation of it", async (t) => {
    const w = world(t);
    const out = outDir(t);
    await publishSite({ pipeline: w.pipeline, cfg: w.cfg, outDir: out, uiRoot: fixtureUi(t) });

    const bundle = bundleAt(out);
    assert.equal(bundle.__sift, STATIC_MARKER);

    // Compared against buildFacetReport rather than hand-written numbers, so
    // this fails if the exporter ever starts computing shares of its own.
    const expected = JSON.parse(JSON.stringify(buildFacetReport(w.store, w.cfg, { agentId: AGENT, facet: FACET })));
    assert.deepEqual(bundle.responses[`/api/themes?agent=${AGENT}&facet=${FACET}`], expected);
  });

  test("every theme the issues list links to has a page in the bundle", async (t) => {
    const w = world(t);
    const out = outDir(t);
    await publishSite({ pipeline: w.pipeline, cfg: w.cfg, outDir: out, uiRoot: fixtureUi(t) });

    const bundle = bundleAt(out);
    const report = bundle.responses[`/api/themes?agent=${AGENT}&facet=${FACET}`] as { rows: Array<{ id: string }> };
    assert.ok(report.rows.length > 0, "the fixture produced no themes to link to");
    for (const row of report.rows) {
      // A static host cannot synthesize a missing page; a gap here is a link
      // that dead-ends for a reader and works in dev.
      assert.ok(bundle.responses[`/api/theme/${row.id}`], `${row.id} is listed but its page is missing`);
    }
  });

  test("both window pickers resolve, since a static host cannot route a query string", async (t) => {
    const w = world(t);
    const out = outDir(t);
    await publishSite({ pipeline: w.pipeline, cfg: w.cfg, outDir: out, uiRoot: fixtureUi(t) });

    const bundle = bundleAt(out);
    const scope = `agent=${AGENT}&facet=${FACET}`;
    for (const window of ["v1.2", "v1.3"]) {
      assert.ok(bundle.responses[`/api/themes?${scope}&window=${window}`], `window ${window} is missing`);
    }
    assert.ok(bundle.responses[`/api/delta?${scope}&from=v1.2&to=v1.3`], "the delta pair is missing");
    assert.ok(bundle.responses[`/api/delta?${scope}&from=v1.3&to=v1.2`], "the reversed pair is missing");
  });

  test("assets and a vercel.json land next to the data", async (t) => {
    const w = world(t);
    const out = outDir(t);
    await publishSite({ pipeline: w.pipeline, cfg: w.cfg, outDir: out, uiRoot: fixtureUi(t) });

    assert.ok(existsSync(join(out, "index.html")));
    assert.ok(existsSync(join(out, "assets", "index-abc123.js")));
    // The dashboard is a second page under app/. loadUiAssets also keys every
    // index.html at its directory so `sift serve` can answer /app — writing
    // those aliases out would create a file named `app` beside the directory,
    // and on a case-insensitive filesystem one would silently clobber the other.
    assert.ok(existsSync(join(out, "app", "index.html")), "the dashboard page is missing");
    assert.equal(statSync(join(out, "app")).isDirectory(), true, "app was written as a file, not a directory");
    const vercel = JSON.parse(readFileSync(join(out, "vercel.json"), "utf8"));
    // No SPA rewrite on purpose: the dashboard routes on the hash, so nothing
    // below `/` ever reaches the host. A catch-all would turn every mistyped
    // URL into index.html with a 200 instead of the 404 it is.
    assert.equal(vercel.rewrites, undefined);
    assert.ok(
      vercel.headers.some((h: { source: string }) => h.source === "/assets/(.*)"),
      "hashed assets should be immutable-cached",
    );
  });

  describe("the privacy gate", () => {
    test("leaves no raw identifier anywhere in the published bytes", async (t) => {
      const w = world(t, PII);
      const out = outDir(t);
      const result = await publishSite({ pipeline: w.pipeline, cfg: w.cfg, outDir: out, uiRoot: fixtureUi(t) });

      // The whole file is grepped rather than the fields it is supposed to have:
      // the leak that matters is the one in a field nobody thought to redact.
      const raw = readFileSync(join(out, DATA_FILE), "utf8");
      for (const secret of [
        "jane.doe@acme.co",
        "support@acme.co",
        "4111111111111111",
        "10.4.221.9",
        "550e8400-e29b-41d4-a716-446655440000",
      ]) {
        assert.equal(raw.includes(secret), false, `${secret} was published verbatim`);
      }
      assert.ok(raw.includes("<EMAIL_1>"), "nothing was tokenized, so nothing was actually read");
      assert.ok(result.redacted);
      assert.ok(Object.values(result.replacedByRule).reduce((a, b) => a + b, 0) > 0);
    });

    test("redacts the facet summary too, not just the trace body", async (t) => {
      const w = world(t, PII);
      const out = outDir(t);
      await publishSite({ pipeline: w.pipeline, cfg: w.cfg, outDir: out, uiRoot: fixtureUi(t) });

      // The summary is a separate field on the exemplar and an easy one to miss:
      // it is the line the model wrote, and it quotes the trace.
      const detail = bundleAt(out).responses["/api/theme/SIFT-14"] as {
        exemplars: Array<{ summary: string | null }>;
      };
      for (const ex of detail.exemplars) {
        assert.equal(ex.summary?.includes("jane.doe@acme.co") ?? false, false);
      }
    });

    test("--no-redact publishes verbatim and reports that it did", async (t) => {
      const w = world(t, PII);
      const out = outDir(t);
      const result = await publishSite({
        pipeline: w.pipeline,
        cfg: w.cfg,
        outDir: out,
        uiRoot: fixtureUi(t),
        redact: false,
      });

      assert.equal(result.redacted, false);
      assert.deepEqual(result.replacedByRule, {});
      // The escape hatch has to work, or someone publishing their own traces
      // gets tokens and concludes the ingest dropped the text.
      assert.ok(readFileSync(join(out, DATA_FILE), "utf8").includes("jane.doe@acme.co"));
    });

    test("the stored traces are untouched — the gate protects the reader, not the archive", async (t) => {
      const w = world(t, PII);
      await publishSite({ pipeline: w.pipeline, cfg: w.cfg, outDir: outDir(t), uiRoot: fixtureUi(t) });
      assert.ok(w.store.getTrace("t-1")!.text.includes("jane.doe@acme.co"), "publishing rewrote the local database");
    });
  });
});
