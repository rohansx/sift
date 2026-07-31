import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runCheck, renderCheck, DEFAULT_FAIL_ON } from "../src/alert/check.ts";
import { pendingAlerts, markAlerted, WebhookAlerter } from "../src/alert/webhook.ts";
import { Pipeline } from "../src/pipeline.ts";
import { SiftStore } from "../src/store/db.ts";
import { DEFAULT_CONFIG, type SiftConfig } from "../src/config.ts";
import { HashEmbedder } from "../src/embed/index.ts";
import { KeywordSummarizer, StubLabeler } from "../src/testing/fakes.ts";
import type { Theme } from "../src/types.ts";

const AGENT = "support-bot";
const FACET = "behavior";

function fixture(): { store: SiftStore; pipeline: Pipeline } {
  const store = new SiftStore(":memory:");
  const cfg: SiftConfig = {
    ...DEFAULT_CONFIG,
    facets: [{ name: FACET, instruction: "what the agent did" }],
    embeddings: { ...DEFAULT_CONFIG.embeddings, provider: "hash", dimensions: 64 },
  };
  const pipeline = new Pipeline(store, cfg, {
    summarizer: new KeywordSummarizer(),
    embedder: new HashEmbedder(64),
    labeler: new StubLabeler(),
    clock: () => new Date("2026-07-30T00:00:00.000Z"),
  });
  return { store, pipeline };
}

function addTheme(store: SiftStore, id: string, over: Partial<Theme> = {}): Theme {
  const theme: Theme = {
    id,
    agentId: AGENT,
    facet: FACET,
    label: `label ${id}`,
    description: `description ${id}`,
    state: "active",
    centroid: [1, 0],
    memberCount: 10,
    exemplarTraceIds: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
  store.insertTheme(theme);
  return theme;
}

function addWindow(store: SiftStore, window: string, rows: Array<[string | null, number]>): void {
  let n = 0;
  for (const [themeId, count] of rows) {
    for (let i = 0; i < count; i++) {
      const traceId = `${window}-${themeId ?? "res"}-${n++}`;
      store.insertTrace({ id: traceId, agentId: AGENT, version: window, startedAt: "2026-07-01T00:00:00.000Z", text: "", meta: {} });
      store.insertAssignment({ traceId, agentId: AGENT, facet: FACET, themeId, similarity: 0.9, window });
    }
  }
}

describe("runCheck", () => {
  test("passes when nothing moved", () => {
    const { store, pipeline } = fixture();
    addTheme(store, "SIFT-1");
    addWindow(store, "v1", [["SIFT-1", 10]]);
    addWindow(store, "v2", [["SIFT-1", 10]]);

    const result = runCheck(pipeline, { failOn: DEFAULT_FAIL_ON });
    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
  });

  test("fails when a resolved theme picks traffic back up", () => {
    const { store, pipeline } = fixture();
    addTheme(store, "SIFT-1", { state: "regressed" });
    addWindow(store, "v1", [[null, 10]]);
    addWindow(store, "v2", [["SIFT-1", 5], [null, 5]]);

    const result = runCheck(pipeline, { failOn: DEFAULT_FAIL_ON });
    assert.equal(result.ok, false);
    assert.equal(result.failures[0]!.themeId, "SIFT-1");
    assert.equal(result.failures[0]!.severity, "regression");
  });

  test("a brand new theme only fails the build when asked", () => {
    // Discovering something new is normal and constant. Regressions are the
    // default gate; "fail on anything new" is a choice a team opts into.
    const { store, pipeline } = fixture();
    addTheme(store, "SIFT-1");
    addTheme(store, "SIFT-2", { state: "new" });
    addWindow(store, "v1", [["SIFT-1", 10]]);
    addWindow(store, "v2", [["SIFT-1", 6], ["SIFT-2", 4]]);

    assert.equal(runCheck(pipeline, { failOn: ["regression"] }).ok, true);
    const strict = runCheck(pipeline, { failOn: ["regression", "new"] });
    assert.equal(strict.ok, false);
    assert.equal(strict.failures[0]!.themeId, "SIFT-2");
  });

  test("a theme too small to matter can be ignored", () => {
    const { store, pipeline } = fixture();
    addTheme(store, "SIFT-1", { state: "regressed" });
    addWindow(store, "v1", [[null, 1000]]);
    addWindow(store, "v2", [["SIFT-1", 30], [null, 970]]);

    // 3% of traffic: a real regression by the delta engine's reckoning...
    assert.equal(runCheck(pipeline, { failOn: DEFAULT_FAIL_ON }).ok, false);
    // ...but a team can decide 3% is below the line worth blocking a deploy for
    const filtered = runCheck(pipeline, { failOn: DEFAULT_FAIL_ON, minShare: 0.05 });
    assert.equal(filtered.ok, true);
    assert.match(filtered.notes.join(" "), /below the 5\.0% floor/);
  });

  test("checks every configured facet by default", () => {
    const { store, pipeline } = fixture();
    addTheme(store, "SIFT-1", { state: "regressed" });
    addWindow(store, "v1", [[null, 10]]);
    addWindow(store, "v2", [["SIFT-1", 5], [null, 5]]);

    const all = runCheck(pipeline, { failOn: DEFAULT_FAIL_ON });
    assert.deepEqual(all.reports.map((r) => r.facet), [FACET]);

    // a facet with no data produces no report and no failure, just a note
    const missing = runCheck(pipeline, { failOn: DEFAULT_FAIL_ON, facet: "nope" });
    assert.deepEqual(missing.reports, []);
    assert.equal(missing.ok, true);
    assert.match(missing.notes.join(" "), /not enough windows/);
  });

  test("passes when there is nothing to compare, rather than failing the build", () => {
    // A first-ever run has one window. Failing there would break every pipeline
    // the day it was added, for no finding.
    const { store, pipeline } = fixture();
    addTheme(store, "SIFT-1");
    addWindow(store, "v1", [["SIFT-1", 10]]);

    const result = runCheck(pipeline, { failOn: DEFAULT_FAIL_ON });
    assert.equal(result.ok, true);
    assert.match(result.notes.join(" "), /not enough windows|nothing to compare/i);
  });

  test("compares explicitly named windows rather than the latest pair", () => {
    const { store, pipeline } = fixture();
    addTheme(store, "SIFT-1", { state: "regressed" });
    addWindow(store, "v1", [[null, 10]]);
    addWindow(store, "v2", [["SIFT-1", 5], [null, 5]]);
    addWindow(store, "v3", [["SIFT-1", 5], [null, 5]]);

    const named = runCheck(pipeline, { failOn: DEFAULT_FAIL_ON, from: "v1", to: "v2" });
    assert.equal(named.reports[0]!.fromWindow, "v1");
    assert.equal(named.reports[0]!.toWindow, "v2");

    const latest = runCheck(pipeline, { failOn: DEFAULT_FAIL_ON });
    assert.equal(latest.reports[0]!.fromWindow, "v2");
    assert.equal(latest.reports[0]!.toWindow, "v3");
  });

  test("a jump that matches the theme's own history is not a gate failure", () => {
    // v2 and v3 both sit at 50%, so v1 -> v2 is within variance. Blocking a
    // deploy for a move the theme makes routinely is how a gate gets ignored.
    const { store, pipeline } = fixture();
    addTheme(store, "SIFT-1", { state: "regressed" });
    addWindow(store, "v1", [[null, 10]]);
    addWindow(store, "v2", [["SIFT-1", 5], [null, 5]]);
    addWindow(store, "v3", [["SIFT-1", 5], [null, 5]]);

    assert.equal(runCheck(pipeline, { failOn: DEFAULT_FAIL_ON, from: "v1", to: "v2" }).ok, true);
  });

  test("refuses to vouch for a build whose traces are not all analyzed", () => {
    // Passing here is the dangerous outcome: "no themes regressed" over a
    // twentieth of the traffic reads exactly like a healthy build.
    const { store, pipeline } = fixture();
    addTheme(store, "SIFT-1");
    addWindow(store, "v1", [["SIFT-1", 10]]);
    addWindow(store, "v2", [["SIFT-1", 10]]);
    for (let i = 0; i < 39; i++) {
      store.insertTrace({ id: `pending-${i}`, agentId: AGENT, version: "v2", startedAt: "2026-07-01T00:00:00.000Z", text: "", meta: {} });
    }

    const result = runCheck(pipeline, { failOn: DEFAULT_FAIL_ON });
    assert.equal(result.ok, false);
    assert.equal(result.uncoveredTraces, 39);
    assert.deepEqual(result.failures, [], "a partial corpus is not a regression and must not be reported as one");
    assert.match(renderCheck(result), /cannot vouch/);

    // someone sampling on purpose still needs a way through
    const allowed = runCheck(pipeline, { failOn: DEFAULT_FAIL_ON, allowPartial: true });
    assert.equal(allowed.ok, true);
    assert.match(allowed.notes.join(" "), /39 traces are not summarized/);
  });

  test("a facet nobody has analyzed is a note, not a partial corpus", () => {
    // Otherwise `--facet typo` fails the build with a coverage complaint
    // instead of saying there is nothing there.
    const { store, pipeline } = fixture();
    addTheme(store, "SIFT-1");
    addWindow(store, "v1", [["SIFT-1", 10]]);

    const result = runCheck(pipeline, { failOn: DEFAULT_FAIL_ON, facet: "nope" });
    assert.equal(result.ok, true);
    assert.equal(result.uncoveredTraces, 0);
  });

  test("muted themes never fail a build", () => {
    const { store, pipeline } = fixture();
    addTheme(store, "SIFT-1", { state: "muted" });
    addWindow(store, "v1", [[null, 10]]);
    addWindow(store, "v2", [["SIFT-1", 8], [null, 2]]);
    assert.equal(runCheck(pipeline, { failOn: ["regression", "new", "notable"] }).ok, true);
  });
});

describe("pendingAlerts", () => {
  test("reports newly discovered and regressed themes for the latest window", () => {
    const { store } = fixture();
    addTheme(store, "SIFT-1", { state: "new", firstWindow: "v2", lastSeenWindow: "v2" });
    addTheme(store, "SIFT-2", { state: "regressed", firstWindow: "v1", lastSeenWindow: "v2" });
    addTheme(store, "SIFT-3", { state: "active", firstWindow: "v1", lastSeenWindow: "v2" });
    addWindow(store, "v1", [["SIFT-2", 5], ["SIFT-3", 5]]);
    addWindow(store, "v2", [["SIFT-1", 3], ["SIFT-2", 3], ["SIFT-3", 4]]);

    const alerts = pendingAlerts(store, { agentId: AGENT, facet: FACET, on: ["new", "regressed"] });
    assert.deepEqual(alerts.map((a) => [a.themeId, a.event]).sort(), [["SIFT-1", "new"], ["SIFT-2", "regressed"]]);
    assert.equal(alerts[0]!.window, "v2");
    assert.equal(alerts[0]!.agentId, AGENT);
  });

  test("carries enough context for the alert to be actionable on its own", () => {
    const { store } = fixture();
    addTheme(store, "SIFT-1", { state: "regressed", label: "tool-retry loop on search_kb", firstWindow: "v1", lastSeenWindow: "v2" });
    addWindow(store, "v1", [[null, 10]]);
    addWindow(store, "v2", [["SIFT-1", 4], [null, 6]]);

    const [alert] = pendingAlerts(store, { agentId: AGENT, facet: FACET, on: ["regressed"] });
    assert.equal(alert!.label, "tool-retry loop on search_kb");
    assert.equal(alert!.count, 4);
    assert.ok(Math.abs(alert!.share - 0.4) < 1e-9);
    assert.match(alert!.description, /description SIFT-1/);
  });

  test("only the events asked for are raised", () => {
    const { store } = fixture();
    addTheme(store, "SIFT-1", { state: "new", firstWindow: "v1", lastSeenWindow: "v1" });
    addTheme(store, "SIFT-2", { state: "regressed", firstWindow: "v1", lastSeenWindow: "v1" });
    addWindow(store, "v1", [["SIFT-1", 5], ["SIFT-2", 5]]);

    const alerts = pendingAlerts(store, { agentId: AGENT, facet: FACET, on: ["regressed"] });
    assert.deepEqual(alerts.map((a) => a.themeId), ["SIFT-2"]);
  });

  test("a theme that first appeared in an older window is not still 'new'", () => {
    const { store } = fixture();
    addTheme(store, "SIFT-1", { state: "new", firstWindow: "v1", lastSeenWindow: "v2" });
    addWindow(store, "v1", [["SIFT-1", 5]]);
    addWindow(store, "v2", [["SIFT-1", 5]]);
    assert.deepEqual(pendingAlerts(store, { agentId: AGENT, facet: FACET, on: ["new"] }), []);
  });
});

describe("alert deduplication", () => {
  test("marking an alert stops it from firing again", () => {
    // A cron on an hourly schedule must not page twenty-four times for one
    // regression. This is the difference between alerting and spamming.
    const { store } = fixture();
    addTheme(store, "SIFT-1", { state: "regressed", firstWindow: "v1", lastSeenWindow: "v2" });
    addWindow(store, "v1", [[null, 10]]);
    addWindow(store, "v2", [["SIFT-1", 5], [null, 5]]);

    const opts = { agentId: AGENT, facet: FACET, on: ["regressed"] as const };
    const first = pendingAlerts(store, opts);
    assert.equal(first.length, 1);

    markAlerted(store, first);
    assert.deepEqual(pendingAlerts(store, opts), []);
  });

  test("the same theme regressing in a later window alerts again", () => {
    const { store } = fixture();
    const theme = addTheme(store, "SIFT-1", { state: "regressed", firstWindow: "v1", lastSeenWindow: "v2" });
    addWindow(store, "v1", [[null, 10]]);
    addWindow(store, "v2", [["SIFT-1", 5], [null, 5]]);

    const opts = { agentId: AGENT, facet: FACET, on: ["regressed"] as const };
    markAlerted(store, pendingAlerts(store, opts));

    addWindow(store, "v3", [["SIFT-1", 6], [null, 4]]);
    store.updateTheme({ ...theme, lastSeenWindow: "v3" });
    const again = pendingAlerts(store, opts);
    assert.equal(again.length, 1);
    assert.equal(again[0]!.window, "v3");
  });

  test("dedupe is per event, so a theme can go new then regressed", () => {
    const { store } = fixture();
    const theme = addTheme(store, "SIFT-1", { state: "new", firstWindow: "v1", lastSeenWindow: "v1" });
    addWindow(store, "v1", [["SIFT-1", 5]]);
    markAlerted(store, pendingAlerts(store, { agentId: AGENT, facet: FACET, on: ["new", "regressed"] }));

    store.updateTheme({ ...theme, state: "regressed" });
    const alerts = pendingAlerts(store, { agentId: AGENT, facet: FACET, on: ["new", "regressed"] });
    assert.deepEqual(alerts.map((a) => a.event), ["regressed"]);
  });
});

describe("WebhookAlerter", () => {
  function stub(responses: Array<{ status?: number; body?: string } | Error>) {
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    let i = 0;
    const impl = (async (url: string | URL, init: RequestInit = {}) => {
      const next = responses[Math.min(i, responses.length - 1)]!;
      i++;
      calls.push({
        url: String(url),
        body: JSON.parse(String(init.body)) as unknown,
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      if (next instanceof Error) throw next;
      return new Response(next.body ?? "ok", { status: next.status ?? 200 });
    }) as unknown as typeof fetch;
    return { impl, calls, get count() { return i; } };
  }

  const alert = {
    agentId: AGENT,
    facet: FACET,
    themeId: "SIFT-1",
    event: "regressed" as const,
    label: "tool-retry loop on search_kb",
    description: "the agent retries after a timeout",
    window: "v2",
    count: 4,
    share: 0.4,
    state: "regressed" as const,
  };

  test("posts one JSON payload carrying every alert", async () => {
    const s = stub([{}]);
    const alerter = new WebhookAlerter("https://hooks.example.com/x", { fetchImpl: s.impl });
    const result = await alerter.send([alert]);

    assert.equal(result.delivered, 1);
    assert.equal(s.count, 1);
    assert.equal(s.calls[0]!.url, "https://hooks.example.com/x");
    assert.equal(s.calls[0]!.headers["content-type"], "application/json");
    const body = s.calls[0]!.body as { alerts: Array<{ themeId: string }>; source: string };
    assert.equal(body.source, "sift");
    assert.equal(body.alerts[0]!.themeId, "SIFT-1");
  });

  test("sends nothing when there is nothing to say", async () => {
    const s = stub([{}]);
    const result = await new WebhookAlerter("https://x", { fetchImpl: s.impl }).send([]);
    assert.equal(s.count, 0);
    assert.equal(result.delivered, 0);
  });

  test("custom headers ride along, for signed or authenticated hooks", async () => {
    const s = stub([{}]);
    const alerter = new WebhookAlerter("https://x", { fetchImpl: s.impl, headers: { authorization: "Bearer t" } });
    await alerter.send([alert]);
    assert.equal(s.calls[0]!.headers["authorization"], "Bearer t");
  });

  test("retries a 5xx", async () => {
    const s = stub([{ status: 503 }, {}]);
    const alerter = new WebhookAlerter("https://x", { fetchImpl: s.impl, sleep: async () => {} });
    assert.equal((await alerter.send([alert])).delivered, 1);
    assert.equal(s.count, 2);
  });

  test("a webhook that stays down reports the failure instead of throwing", async () => {
    // A failed notification must not fail the analysis run that produced it.
    const s = stub([{ status: 500, body: "nope" }]);
    const alerter = new WebhookAlerter("https://x", { fetchImpl: s.impl, maxRetries: 1, sleep: async () => {} });
    const result = await alerter.send([alert]);
    assert.equal(result.delivered, 0);
    assert.match(result.error!, /500/);
  });
});
