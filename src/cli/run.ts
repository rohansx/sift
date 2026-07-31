import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { CONFIG_FILENAME, ConfigError, loadConfig, type DeepPartial, type SiftConfig } from "../config.ts";
import { renderDoctor, runDoctor, type DoctorOptions } from "../doctor/index.ts";
import { createPipeline, createPseudonymizer, Pipeline } from "../pipeline.ts";
import { renderDeltaMarkdown, renderThemeMarkdown } from "../report/markdown.ts";
import { renderDeltaTerminal, renderIssuesList } from "../report/terminal.ts";
import { EXPORT_FORMATS, renderExport, type ExportFormat } from "../export/evals.ts";
import { generateDemoTraces } from "../examples/generate-demo-traces.ts";

import { parseOtlpJsonl } from "../ingest/otlp.ts";
import type { FlushOptions } from "../ingest/pending.ts";
import { startReceiver, DEFAULT_PORT } from "../ingest/receiver.ts";
import { isLoopback } from "../serve/http.ts";
import { UI_NOT_BUILT } from "../serve/static.ts";
import { REDACTION_RULES } from "../privacy/redact.ts";
import { runCheck, renderCheck, DEFAULT_FAIL_ON } from "../alert/check.ts";
import { pendingAlerts, markAlerted, WebhookAlerter, type Alert, type AlertEvent } from "../alert/webhook.ts";
import type { DeltaSeverity } from "../types.ts";
import { THEME_STATES, type ThemeState } from "../types.ts";

/**
 * The CLI. Arguments are parsed with node:util's parseArgs rather than
 * commander, which keeps sift's runtime dependency list empty — "local-first"
 * should mean an install that pulls nothing down.
 */

const VERSION = "0.1.0";

const HELP = `sift — Sentry-grade issue tracking for agent behavior

USAGE
  sift <command> [options]

PIPELINE
  ingest        read OTLP GenAI spans (JSON lines) into the local database
  serve         receive OTLP/JSON spans over HTTP; be a collector target, and
                serve the read-only dashboard at / and its JSON on /api.
                Both are on by default — --no-ui takes them off — and both stay
                off unless the bind is loopback or --token is set, because the
                page shows raw trace text. The dashboard ships prebuilt; from a
                git checkout it needs \`npm run build:ui\` once.
  summarize     facet-summarize and embed traces that do not have summaries yet
  bootstrap     discover themes from everything not yet assigned
  assign        assign new traces to existing themes; re-discover on residual pressure
  analyze       ingest + summarize + discover/assign in one pass

VIEWS
  report        the issues list
  delta         what changed between two windows
  check         exit non-zero when a theme regressed (for CI)
  alert         send new/regressed themes to a webhook, once each
  themes        list themes, optionally filtered by state
  show          one theme in detail, with exemplar traces

LIFECYCLE
  resolve       mark a theme resolved (it will flag as REGRESSED if traffic returns)
  mute          mark a theme known and accepted; it stops appearing in deltas
  reopen        return a theme to active
  relabel       change a theme's label without changing its identity

OTHER
  doctor        check config, keys, endpoints and what a run would cost —
                before spending anything
  export        emit a theme as eval cases and a scorer prompt
  privacy       preview what the pseudonymization gate strips before the LLM
  demo          generate synthetic traces with planted failure modes
  help, version

GLOBAL OPTIONS
  --agent <name>       scope to one agent (otherwise every agent in the database)
  --since <window>     ISO date or a span like 7d, 24h; picks which traces get
                       summarized (summarize, analyze). Views are scoped by
                       window instead — see --window and --from/--to.
  --limit <n>          cap the traces summarized, one model call each.
                       summarize does 1000 per pass and says what it left;
                       analyze summarizes everything pending unless you cap it.
  --allow-partial      let check pass over a corpus that is not fully
                       summarized yet (it fails on one by default)
  --no-probe           doctor: config and cost only, zero network calls
  --price-in <usd>     doctor: USD per 1M input tokens, overriding the table
  --price-out <usd>    doctor: USD per 1M output tokens
  --port <n>           serve: listen port (default 4318, the OTLP/HTTP one)
  --host <addr>        serve: bind address (default 127.0.0.1). Anything else
                       exposes an unauthenticated write endpoint — pair it
                       with --token.
  --token <secret>     serve: require Authorization: Bearer <secret>
                       (env SIFT_RECEIVER_TOKEN)
  --settle <seconds>   serve: quiet period after a trace's last span before it
                       is assembled (default 30)
  --max-body <bytes>   serve: reject bodies over this (default 4194304)
  --no-ui              serve: collector only. The dashboard and /api are on by
                       default; this takes both off, for a receiver that should
                       have no read surface at all.
  --db <path>          sqlite database (default ./sift.db, env SIFT_DB)
  --config <path>      config file (default ./sift.config.json)
  --preset <name>      facet preset: chat | pipeline | coding | support
  --json               machine-readable output where it makes sense
  --no-color           plain output (colour is off by default when piping)

EXAMPLES
  sift serve                             # collector + dashboard on 127.0.0.1:4318
                                         # exporters need OTLP_PROTOCOL=http/json
  sift demo --out ./demo-traces.jsonl
  sift doctor                            # config, auth, dimensions, and the bill
  sift analyze --otlp ./demo-traces.jsonl
  sift report
  sift delta --from v1.2 --to v1.3 --facet behavior
  sift export SIFT-14 --format mastra-scorer --out scorers/retry.ts
  sift check --fail-on regression        # exits 1 if something regressed
  sift alert --webhook $SLACK_URL

Set SIFT_LLM_PROVIDER=fake and SIFT_EMBED_PROVIDER=hash to run the whole
pipeline offline with no API keys.
`;

interface Ctx {
  positionals: string[];
  values: Record<string, unknown>;
  cfg: SiftConfig;
  json: boolean;
  color: boolean;
}

const OPTIONS = {
  db: { type: "string" },
  config: { type: "string" },
  preset: { type: "string" },
  otlp: { type: "string" },
  agent: { type: "string" },
  facet: { type: "string" },
  window: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  format: { type: "string" },
  out: { type: "string" },
  note: { type: "string" },
  state: { type: "string" },
  label: { type: "string" },
  limit: { type: "string" },
  since: { type: "string" },
  "fail-on": { type: "string" },
  "min-share": { type: "string" },
  "allow-partial": { type: "boolean" },
  "no-probe": { type: "boolean" },
  "price-in": { type: "string" },
  "price-out": { type: "string" },
  webhook: { type: "string" },
  on: { type: "string" },
  "dry-run": { type: "boolean" },
  traces: { type: "string" },
  seed: { type: "string" },
  port: { type: "string" },
  host: { type: "string" },
  token: { type: "string" },
  settle: { type: "string" },
  "max-body": { type: "string" },
  "no-ui": { type: "boolean" },
  strict: { type: "boolean" },
  json: { type: "boolean" },
  color: { type: "boolean" },
  "no-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\nRun \`sift help\` for usage.\n`);
    return 2;
  }

  const { values, positionals } = parsed;
  const command = positionals[0];

  if (values.version || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help || command === undefined || command === "help") {
    process.stdout.write(HELP);
    return command === undefined && !values.help ? 1 : 0;
  }

  let cfg: SiftConfig;
  try {
    const overrides: DeepPartial<SiftConfig> = {};
    if (typeof values.db === "string") overrides.dbPath = values.db;
    if (typeof values.preset === "string") overrides.preset = values.preset;
    const loadOpts: Parameters<typeof loadConfig>[0] = { overrides };
    if (typeof values.config === "string") loadOpts.configPath = values.config;
    cfg = loadConfig(loadOpts);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }

  const ctx: Ctx = {
    positionals: positionals.slice(1),
    values: values as Record<string, unknown>,
    cfg,
    json: values.json === true,
    color: values.color === true && values["no-color"] !== true,
  };

  try {
    return await run(command, ctx);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
}

async function run(command: string, ctx: Ctx): Promise<number> {
  switch (command) {
    case "demo":
      return cmdDemo(ctx);
    case "privacy":
      return cmdPrivacy(ctx);
    case "ingest":
      return withPipeline(ctx, cmdIngest);
    case "serve":
      return withPipeline(ctx, cmdServe);
    // The four commands that call a model. requireKey turns a missing key into
    // one sentence at construction instead of a thousand identical 401s, one
    // per trace, each stored as a failure row.
    case "summarize":
      return withPipeline(ctx, cmdSummarize, { requireKey: true });
    case "bootstrap":
      return withPipeline(ctx, cmdBootstrap, { requireKey: true });
    case "assign":
      return withPipeline(ctx, cmdAssign, { requireKey: true });
    case "analyze":
      return withPipeline(ctx, cmdAnalyze, { requireKey: true });
    case "doctor":
      // Deliberately not requireKey: reporting the missing key is its job.
      return withPipeline(ctx, cmdDoctor);
    case "report":
      return withPipeline(ctx, cmdReport);
    case "delta":
      return withPipeline(ctx, cmdDelta);
    case "check":
      return withPipeline(ctx, cmdCheck);
    case "alert":
      return withPipeline(ctx, cmdAlert);
    case "themes":
      return withPipeline(ctx, cmdThemes);
    case "show":
      return withPipeline(ctx, cmdShow);
    case "resolve":
    case "mute":
    case "reopen":
    case "relabel":
      return withPipeline(ctx, (p, c) => cmdLifecycle(command, p, c));
    case "export":
      return withPipeline(ctx, cmdExport);
    default:
      process.stderr.write(`unknown command: ${command}\n\nRun \`sift help\` for usage.\n`);
      return 2;
  }
}

async function withPipeline(
  ctx: Ctx,
  fn: (p: Pipeline, ctx: Ctx) => Promise<number> | number,
  opts: { requireKey?: boolean } = {},
): Promise<number> {
  const create: Parameters<typeof createPipeline>[1] = {
    log: ctx.json ? () => {} : (m) => process.stderr.write(`${m}\n`),
  };
  if (opts.requireKey) create.requireKey = true;
  const pipeline = createPipeline(ctx.cfg, create);
  try {
    return await fn(pipeline, ctx);
  } finally {
    pipeline.store.close();
  }
}

/* ---------- commands ---------- */

function cmdDemo(ctx: Ctx): number {
  const opts: Parameters<typeof generateDemoTraces>[0] = {};
  const traces = intOption(ctx, "traces");
  const seed = intOption(ctx, "seed");
  if (traces !== undefined) opts.tracesPerVersion = traces;
  if (seed !== undefined) opts.seed = seed;

  const { jsonl, records } = generateDemoTraces(opts);
  const out = typeof ctx.values.out === "string" ? ctx.values.out : "./demo-traces.jsonl";
  writeFile(out, jsonl);

  if (ctx.json) {
    process.stdout.write(`${JSON.stringify({ path: out, traces: records.length }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `wrote ${records.length} synthetic traces to ${out}\n` +
      `two releases (v1.2, v1.3) with failure modes planted at different rates.\n\n` +
      `next:\n  sift analyze --otlp ${out}\n  sift report\n  sift delta --from v1.2 --to v1.3 --facet behavior\n`,
  );
  return 0;
}

/**
 * Shows exactly what leaves the machine. Nobody should have to take a privacy
 * claim on faith when the tool can just show them the redacted text.
 */
function cmdPrivacy(ctx: Ctx): number {
  const path = typeof ctx.values.otlp === "string" ? ctx.values.otlp : ctx.positionals[0];
  const gate = createPseudonymizer(ctx.cfg);

  if (!path) {
    if (ctx.json) {
      process.stdout.write(`${JSON.stringify({ ...ctx.cfg.privacy, rules: REDACTION_RULES.map((r) => r.name) }, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(`\n  privacy gate: ${ctx.cfg.privacy.mode} (scope: ${ctx.cfg.privacy.scope})\n\n`);
    for (const rule of REDACTION_RULES) {
      const active = !ctx.cfg.privacy.rules || ctx.cfg.privacy.rules.includes(rule.name);
      process.stdout.write(`    ${active ? "on " : "off"}  ${rule.name.padEnd(8)} <${rule.label}>\n`);
    }
    process.stdout.write(`\n  point it at traces to preview: sift privacy --otlp ./traces.jsonl\n\n`);
    return 0;
  }

  const { traces } = parseOtlpJsonl(readFileSync(path, "utf8"));
  const totals: Record<string, number> = {};
  let redactedTraces = 0;
  const samples: Array<{ id: string; before: string; after: string }> = [];

  for (const trace of traces) {
    const result = gate.redact(trace.text);
    if (result.total === 0) continue;
    redactedTraces++;
    for (const [rule, n] of Object.entries(result.counts)) totals[rule] = (totals[rule] ?? 0) + n;
    if (samples.length < 3) samples.push({ id: trace.id, before: trace.text, after: result.text });
  }

  const total = Object.values(totals).reduce((a, b) => a + b, 0);
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify({ traces: traces.length, redactedTraces, total, byRule: totals }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`\n  privacy gate: ${ctx.cfg.privacy.mode} (scope: ${ctx.cfg.privacy.scope})\n`);
  process.stdout.write(`  ${total} values in ${redactedTraces} of ${traces.length} traces would be replaced before the LLM sees them\n\n`);
  for (const [rule, n] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`    ${String(n).padStart(6)}  ${rule}\n`);
  }
  if (total === 0) process.stdout.write(`    nothing matched — these traces carry no identifiers the gate recognises\n`);

  for (const sample of samples) {
    process.stdout.write(`\n  ${sample.id}\n`);
    for (const line of diffLines(sample.before, sample.after)) process.stdout.write(`    ${line}\n`);
  }
  process.stdout.write("\n");
  return 0;
}

/** Only the lines the gate actually changed; a full trace dump would bury them. */
function diffLines(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: string[] = [];
  for (let i = 0; i < b.length && out.length < 8; i++) {
    if (a[i] !== b[i]) out.push(`- ${a[i]}`, `+ ${b[i]}`);
  }
  return out;
}

function cmdIngest(pipeline: Pipeline, ctx: Ctx): number {
  const path = typeof ctx.values.otlp === "string" ? ctx.values.otlp : ctx.positionals[0];
  if (!path) {
    process.stderr.write("ingest needs a path: sift ingest --otlp ./traces.jsonl\n");
    return 2;
  }
  const opts: { agentId?: string; strict?: boolean } = {};
  if (typeof ctx.values.agent === "string") opts.agentId = ctx.values.agent;
  if (ctx.values.strict === true) opts.strict = true;

  const result = pipeline.ingestFile(path, opts);
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`ingested ${result.ingested} traces from ${result.spans} spans`);
  process.stdout.write(result.duplicates ? ` (${result.duplicates} already known)\n` : "\n");
  if (result.skippedLines > 0) {
    process.stdout.write(`skipped ${result.skippedLines} malformed lines:\n`);
    for (const e of result.errors.slice(0, 5)) process.stdout.write(`  ${e}\n`);
  }
  return 0;
}

/**
 * Receive only. The paid work stays in `sift analyze` on a cron: an LLM call in
 * the ingest path makes both backpressure and the bill unpredictable, and an
 * exporter cannot wait on a summarizer.
 */
async function cmdServe(pipeline: Pipeline, ctx: Ctx): Promise<number> {
  const settleMs = (intOption(ctx, "settle") ?? 30) * 1000;
  // On by default: a dashboard behind a flag is a dashboard nobody finds, and
  // the assets are already in the tarball whether or not they get served.
  // --no-ui withholds the pipeline entirely, which is what makes the receiver
  // byte-identical to the collector it was before there was a read side.
  const ui = ctx.values["no-ui"] !== true;
  const opts: Parameters<typeof startReceiver>[0] = {
    store: pipeline.store,
    port: intOption(ctx, "port") ?? DEFAULT_PORT,
    log: (m) => process.stderr.write(`${m}\n`),
  };
  // The same pipeline the flush timer below uses, so /api reads the database
  // this process is writing rather than opening a second handle to it.
  if (ui) opts.pipeline = pipeline;
  if (typeof ctx.values.host === "string") opts.host = ctx.values.host;
  const maxBody = intOption(ctx, "max-body");
  if (maxBody !== undefined) opts.maxBodyBytes = maxBody;
  const token = typeof ctx.values.token === "string" ? ctx.values.token : process.env.SIFT_RECEIVER_TOKEN;
  if (token) opts.token = token;

  // The receiver applies this same rule; it is repeated here only so the banner
  // never advertises a URL that answers 404, which is worse than saying nothing.
  const readable = ui && (opts.host === undefined || isLoopback(opts.host) || Boolean(token));

  const receiver = await startReceiver(opts);
  process.stdout.write(
    `sift is receiving OTLP/JSON traces on ${receiver.url}/v1/traces -> ${ctx.cfg.dbPath}\n\n` +
      `  export OTEL_EXPORTER_OTLP_ENDPOINT=${receiver.url}\n` +
      `  export OTEL_EXPORTER_OTLP_PROTOCOL=http/json\n\n` +
      `the protocol line is not optional: the SDK default is protobuf and sift ships no decoder for it.\n` +
      `spans are staged and assembled ${settleMs / 1000}s after a trace's last span.\n` +
      `this command only receives — run \`sift analyze\` to summarize and cluster.\n` +
      (readable && receiver.uiBuilt
        ? `\nread-only dashboard: ${receiver.url}  (JSON at ${receiver.url}/api/themes)\n` +
          (token ? `open it as ${receiver.url}/?token=<the token> — the page cannot send a bearer on a navigation.\n` : "")
        : ""),
  );
  // Said here, at startup, rather than left to the 404 the page would give.
  // Nobody installing from npm can reach this — the tarball carries dist/ui —
  // so the reader is in a checkout and the fix is one command. The receiver
  // keeps running either way: refusing spans because a browser page is unbuilt
  // would be a worse failure than the one being reported.
  if (readable && !receiver.uiBuilt) {
    process.stderr.write(
      `\n${UI_NOT_BUILT}\n` +
        `/api is up at ${receiver.url}/api/themes regardless; pass --no-ui to stop asking for the page.\n`,
    );
  }
  if (opts.host !== undefined && !isLoopback(opts.host) && !token) {
    process.stderr.write(
      `warning: bound to ${opts.host} with no --token; anyone who can reach it can write traces.\n` +
        (ui
          ? `the dashboard and /api stay off in this configuration — they serve raw trace text, and "anyone can write\n` +
            `traces" is not the same sentence as "anyone can read every conversation". Pass --token to enable them.\n`
          : ""),
    );
  }

  // --agent names the agent for spans that carry no agent attribute, exactly as
  // it does for `sift ingest`. Without it here, the same spans landed under
  // "myapp" from a file and under "default" over HTTP.
  const flushOpts: FlushOptions = { settleMs };
  if (typeof ctx.values.agent === "string") flushOpts.agentId = ctx.values.agent;

  const timer = setInterval(() => {
    try {
      pipeline.flushPending(flushOpts);
    } catch (err) {
      // Losing one flush is recoverable — the spans stay staged. Dying is not.
      process.stderr.write(`flush failed, will retry: ${(err as Error).message}\n`);
    }
  }, 5000);

  await new Promise<void>((resolve) => {
    // No final flush: staged spans are durable, and flushing on the way out
    // would truncate whatever trace was still in flight.
    const stop = () => {
      clearInterval(timer);
      receiver.close().then(resolve, resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  process.stdout.write(`\nstopped. ${pipeline.store.countPendingSpans()} spans still staged.\n`);
  return 0;
}

/**
 * The preflight. Everything downstream is per-trace and paid, so the cheapest
 * possible thing sift can do is tell you what is wrong, and what it will cost,
 * before it starts. Exits 1 on a failed check so a provisioning script can gate
 * on it; a warning is not a failure.
 */
async function cmdDoctor(pipeline: Pipeline, ctx: Ctx): Promise<number> {
  const opts: DoctorOptions = { store: pipeline.store, keySources: keySources(ctx.cfg) };
  if (ctx.values["no-probe"] === true) opts.probe = false;
  if (typeof ctx.values.agent === "string") opts.agentId = ctx.values.agent;
  if (typeof ctx.values.since === "string") opts.since = Pipeline.resolveSince(ctx.values.since);
  const priceIn = floatOption(ctx, "price-in");
  const priceOut = floatOption(ctx, "price-out");
  if (priceIn !== undefined) opts.priceIn = priceIn;
  if (priceOut !== undefined) opts.priceOut = priceOut;

  const result = await runDoctor(ctx.cfg, opts);
  if (ctx.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(renderDoctor(result));
  return result.ok ? 0 : 1;
}

/**
 * Where each key came from, so doctor can say "from SIFT_LLM_API_KEY" without
 * ever being handed the value's origin to guess at — and warn about a key that
 * lives in a file. Doctor itself reads no environment; this is the only place
 * that does.
 */
function keySources(cfg: SiftConfig): { llm?: string; embeddings?: string } {
  const out: { llm?: string; embeddings?: string } = {};
  if (cfg.llm.apiKey) {
    out.llm = process.env.SIFT_LLM_API_KEY === cfg.llm.apiKey ? "SIFT_LLM_API_KEY" : CONFIG_FILENAME;
  }
  if (cfg.embeddings.apiKey) {
    out.embeddings = process.env.SIFT_EMBED_API_KEY === cfg.embeddings.apiKey ? "SIFT_EMBED_API_KEY" : CONFIG_FILENAME;
  }
  return out;
}

async function cmdSummarize(pipeline: Pipeline, ctx: Ctx): Promise<number> {
  const opts: { limit?: number; since?: string; agentId?: string } = {};
  const limit = intOption(ctx, "limit");
  if (limit !== undefined) opts.limit = limit;
  if (typeof ctx.values.since === "string") opts.since = Pipeline.resolveSince(ctx.values.since);
  if (typeof ctx.values.agent === "string") opts.agentId = ctx.values.agent;

  const result = await pipeline.summarize(opts);
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`summarized ${result.traces} traces into ${result.summaries} facet lines, embedded ${result.embedded}\n`);
  if (result.remaining > 0) {
    process.stdout.write(
      `${result.remaining} traces still need summarizing — run it again, or sift analyze to finish the corpus\n`,
    );
  }
  if (result.failures.length > 0) {
    process.stdout.write(`${result.failures.length} traces failed and will be retried on the next run\n`);
    return 1;
  }
  return 0;
}

async function cmdBootstrap(pipeline: Pipeline, ctx: Ctx): Promise<number> {
  const results = await pipeline.bootstrap();
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return 0;
  }
  for (const { agentId, facet, created } of results) {
    process.stdout.write(`${agentId}/${facet}: ${created.length} themes discovered\n`);
    for (const t of created) process.stdout.write(`  ${t.id}  ${t.label}  (${t.memberCount})\n`);
  }
  return 0;
}

async function cmdAssign(pipeline: Pipeline, ctx: Ctx): Promise<number> {
  const results = await pipeline.assign();
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return 0;
  }
  for (const r of results) {
    process.stdout.write(`${r.agentId}/${r.facet}: ${r.assigned} assigned, ${r.residual} residual\n`);
    for (const t of r.rediscovered) process.stdout.write(`  NEW ${t.id}  ${t.label}  (${t.memberCount})\n`);
    for (const t of [...r.transitions, ...r.autoResolved]) {
      process.stdout.write(`  ${t.themeId}: ${t.from} -> ${t.to}\n`);
    }
  }
  return 0;
}

async function cmdAnalyze(pipeline: Pipeline, ctx: Ctx): Promise<number> {
  const opts: { otlpPath?: string; agentId?: string; limit?: number; since?: string } = {};
  const path = typeof ctx.values.otlp === "string" ? ctx.values.otlp : ctx.positionals[0];
  if (path) opts.otlpPath = path;
  if (typeof ctx.values.agent === "string") opts.agentId = ctx.values.agent;
  const limit = intOption(ctx, "limit");
  if (limit !== undefined) opts.limit = limit;
  if (typeof ctx.values.since === "string") opts.since = Pipeline.resolveSince(ctx.values.since);

  const result = await pipeline.analyze(opts);
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  return cmdReport(pipeline, ctx);
}

function cmdReport(pipeline: Pipeline, ctx: Ctx): number {
  const opts: { facet?: string; window?: string; agentId?: string } = {};
  if (typeof ctx.values.facet === "string") opts.facet = ctx.values.facet;
  if (typeof ctx.values.window === "string") opts.window = ctx.values.window;
  if (typeof ctx.values.agent === "string") opts.agentId = ctx.values.agent;
  const reports = pipeline.report(opts);

  const format = typeof ctx.values.format === "string" ? ctx.values.format : ctx.json ? "json" : "terminal";
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
    return 0;
  }
  if (format === "md" || format === "markdown") {
    process.stdout.write(renderThemeMarkdown(reports));
    return 0;
  }
  for (const report of reports) {
    process.stdout.write(renderIssuesList(report, { agentId: report.agentId, color: ctx.color }));
  }
  return 0;
}

function cmdDelta(pipeline: Pipeline, ctx: Ctx): number {
  const facet = typeof ctx.values.facet === "string" ? ctx.values.facet : pipeline.facets[0]!.name;
  const agentId = resolveAgent(pipeline, ctx);
  if (agentId === null) return 2;

  let from = typeof ctx.values.from === "string" ? ctx.values.from : undefined;
  let to = typeof ctx.values.to === "string" ? ctx.values.to : undefined;

  if (!from || !to) {
    const pair = pipeline.latestWindowPair(agentId, facet);
    if (!pair) {
      process.stderr.write(`${agentId}/${facet} does not have two windows to compare yet\n`);
      return 2;
    }
    from ??= pair.from;
    to ??= pair.to;
  }

  const report = pipeline.delta(agentId, facet, from, to);
  const format = typeof ctx.values.format === "string" ? ctx.values.format : ctx.json ? "json" : "terminal";
  if (format === "json") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (format === "md" || format === "markdown") process.stdout.write(renderDeltaMarkdown(report));
  else process.stdout.write(renderDeltaTerminal(report, { color: ctx.color }));
  return 0;
}

/**
 * The CI gate. Exit 1 on findings so a deploy pipeline can block on behavior
 * nobody wrote an eval for yet.
 */
function cmdCheck(pipeline: Pipeline, ctx: Ctx): number {
  const failOn = parseSeverities(typeof ctx.values["fail-on"] === "string" ? ctx.values["fail-on"] : undefined);
  if (failOn === null) return 2;

  const opts: Parameters<typeof runCheck>[1] = { failOn };
  if (typeof ctx.values.facet === "string") opts.facet = ctx.values.facet;
  if (typeof ctx.values.agent === "string") opts.agentId = ctx.values.agent;
  if (typeof ctx.values.from === "string") opts.from = ctx.values.from;
  if (typeof ctx.values.to === "string") opts.to = ctx.values.to;
  const minShare = floatOption(ctx, "min-share");
  if (minShare !== undefined) opts.minShare = minShare;
  if (ctx.values["allow-partial"] === true) opts.allowPartial = true;

  const result = runCheck(pipeline, opts);
  if (ctx.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(renderCheck(result));
  return result.ok ? 0 : 1;
}

function parseSeverities(raw: string | undefined): DeltaSeverity[] | null {
  if (!raw) return DEFAULT_FAIL_ON;
  const allowed: DeltaSeverity[] = ["regression", "new", "notable", "info"];
  const parsed = raw.split(",").map((s) => s.trim()).filter(Boolean) as DeltaSeverity[];
  for (const s of parsed) {
    if (!allowed.includes(s)) {
      process.stderr.write(`unknown severity ${JSON.stringify(s)}; expected one of ${allowed.join(", ")}\n`);
      return null;
    }
  }
  return parsed;
}

/**
 * Sends new and regressed themes to a webhook, at most once each per window.
 * Deduplication is the point: an hourly cron must not page repeatedly for one
 * unchanged fact.
 */
async function cmdAlert(pipeline: Pipeline, ctx: Ctx): Promise<number> {
  const url = typeof ctx.values.webhook === "string" ? ctx.values.webhook : process.env.SIFT_ALERT_WEBHOOK;
  const events = parseEvents(typeof ctx.values.on === "string" ? ctx.values.on : undefined);
  if (events === null) return 2;

  const agents = typeof ctx.values.agent === "string" ? [ctx.values.agent] : pipeline.agents();
  const facets = typeof ctx.values.facet === "string" ? [ctx.values.facet] : pipeline.facets.map((f) => f.name);

  const alerts: Alert[] = [];
  for (const agentId of agents) {
    for (const facet of facets) alerts.push(...pendingAlerts(pipeline.store, { agentId, facet, on: events }));
  }

  // --dry-run shows what would go out without marking anything as sent
  const dryRun = ctx.values["dry-run"] === true;
  if (!url) {
    if (!dryRun) {
      process.stderr.write("alert needs a webhook: --webhook <url> or SIFT_ALERT_WEBHOOK\n");
      return 2;
    }
  }

  if (ctx.json) process.stdout.write(`${JSON.stringify({ alerts, dryRun }, null, 2)}\n`);
  else if (alerts.length === 0) process.stdout.write("nothing new to alert on\n");
  else {
    for (const a of alerts) {
      process.stdout.write(`${a.event.toUpperCase()}  ${a.themeId}  ${a.label}  (${a.agentId}/${a.facet}, ${a.window})\n`);
    }
  }

  if (dryRun || alerts.length === 0) return 0;

  const alerter = new WebhookAlerter(url!);
  const result = await alerter.send(alerts);
  if (result.error) {
    // Delivery failed, so nothing is marked sent and the next run retries.
    process.stderr.write(`alert delivery failed: ${result.error}\n`);
    return 1;
  }
  markAlerted(pipeline.store, alerts);
  if (!ctx.json) process.stdout.write(`delivered ${result.delivered} alerts\n`);
  return 0;
}

function parseEvents(raw: string | undefined): AlertEvent[] | null {
  if (!raw) return ["new", "regressed"];
  const allowed: AlertEvent[] = ["new", "regressed"];
  const parsed = raw.split(",").map((s) => s.trim()).filter(Boolean) as AlertEvent[];
  for (const e of parsed) {
    if (!allowed.includes(e)) {
      process.stderr.write(`unknown event ${JSON.stringify(e)}; expected one of ${allowed.join(", ")}\n`);
      return null;
    }
  }
  return parsed;
}

function cmdThemes(pipeline: Pipeline, ctx: Ctx): number {
  const stateFilter = typeof ctx.values.state === "string" ? ctx.values.state : undefined;
  if (stateFilter && !THEME_STATES.includes(stateFilter as ThemeState)) {
    process.stderr.write(`unknown state "${stateFilter}"; expected one of ${THEME_STATES.join(", ")}\n`);
    return 2;
  }

  let themes = pipeline.store.allThemes();
  if (typeof ctx.values.agent === "string") themes = themes.filter((t) => t.agentId === ctx.values.agent);
  if (typeof ctx.values.facet === "string") themes = themes.filter((t) => t.facet === ctx.values.facet);
  if (stateFilter) themes = themes.filter((t) => t.state === stateFilter);

  if (ctx.json) {
    process.stdout.write(`${JSON.stringify(themes, null, 2)}\n`);
    return 0;
  }
  if (themes.length === 0) {
    process.stdout.write("no themes match.\n");
    return 0;
  }
  const idWidth = Math.max(...themes.map((t) => t.id.length));
  const stateWidth = Math.max(...themes.map((t) => t.state.length));
  // The agent column only earns its space when there is more than one.
  const agents = new Set(themes.map((t) => t.agentId));
  const agentWidth = agents.size > 1 ? Math.max(...themes.map((t) => t.agentId.length)) : 0;
  const facetWidth = Math.max(...themes.map((t) => t.facet.length));

  for (const t of themes) {
    const agent = agentWidth > 0 ? `${t.agentId.padEnd(agentWidth)}  ` : "";
    process.stdout.write(
      `${t.id.padEnd(idWidth)}  ${t.state.padEnd(stateWidth)}  ${String(t.memberCount).padStart(5)}  ${agent}${t.facet.padEnd(facetWidth)}  ${t.label}\n`,
    );
  }
  return 0;
}

function cmdShow(pipeline: Pipeline, ctx: Ctx): number {
  const themeId = ctx.positionals[0];
  if (!themeId) {
    process.stderr.write("show needs a theme id: sift show SIFT-14\n");
    return 2;
  }
  const theme = pipeline.store.getTheme(themeId);
  if (!theme) {
    process.stderr.write(`no such theme: ${themeId}\n`);
    return 1;
  }
  if (ctx.json) {
    const exemplars = theme.exemplarTraceIds.map((id) => pipeline.store.getTrace(id)).filter(Boolean);
    process.stdout.write(`${JSON.stringify({ theme, exemplars }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`\n${theme.id}  ${theme.label}\n`);
  process.stdout.write(`  facet:   ${theme.facet}\n`);
  process.stdout.write(`  state:   ${theme.state}${theme.note ? ` (${theme.note})` : ""}\n`);
  process.stdout.write(`  traces:  ${theme.memberCount}\n`);
  process.stdout.write(`  created: ${theme.createdAt}\n`);
  if (theme.lastSeenWindow) process.stdout.write(`  last seen in window: ${theme.lastSeenWindow}\n`);
  if (theme.description) process.stdout.write(`\n  ${theme.description}\n`);

  process.stdout.write(`\n  exemplar traces:\n`);
  for (const id of theme.exemplarTraceIds) {
    const trace = pipeline.store.getTrace(id);
    if (!trace) continue;
    const summary = pipeline.store.getSummary(id, theme.facet);
    process.stdout.write(`    ${id}${trace.version ? ` [${trace.version}]` : ""}\n`);
    if (summary) process.stdout.write(`      ${summary.summary}\n`);
  }
  process.stdout.write(`\n  export it:  sift export ${theme.id} --format mastra-scorer\n\n`);
  return 0;
}

function cmdLifecycle(command: string, pipeline: Pipeline, ctx: Ctx): number {
  const themeId = ctx.positionals[0];
  if (!themeId) {
    process.stderr.write(`${command} needs a theme id: sift ${command} SIFT-14\n`);
    return 2;
  }
  const note = typeof ctx.values.note === "string" ? ctx.values.note : undefined;

  // The theme knows which agent it belongs to, so the caller never has to say.
  const existing = pipeline.store.getTheme(themeId);
  if (!existing) {
    process.stderr.write(`no such theme: ${themeId}\n`);
    return 1;
  }
  const registry = pipeline.registryFor(existing.agentId);

  let theme;
  if (command === "resolve") theme = registry.resolve(themeId, note);
  else if (command === "mute") theme = registry.mute(themeId, note);
  else if (command === "reopen") theme = registry.reopen(themeId);
  else {
    const label = typeof ctx.values.label === "string" ? ctx.values.label : ctx.positionals.slice(1).join(" ");
    if (!label) {
      process.stderr.write(`relabel needs a new label: sift relabel ${themeId} --label "..."\n`);
      return 2;
    }
    theme = registry.relabel(themeId, label);
  }

  if (ctx.json) process.stdout.write(`${JSON.stringify(theme, null, 2)}\n`);
  else process.stdout.write(`${theme.id} is now ${theme.state}: ${theme.label}\n`);
  return 0;
}

function cmdExport(pipeline: Pipeline, ctx: Ctx): number {
  const themeId = ctx.positionals[0];
  if (!themeId) {
    process.stderr.write("export needs a theme id: sift export SIFT-14\n");
    return 2;
  }
  const format = (typeof ctx.values.format === "string" ? ctx.values.format : "mastra-scorer") as ExportFormat;
  if (!EXPORT_FORMATS.includes(format)) {
    process.stderr.write(`unknown format "${format}"; expected one of ${EXPORT_FORMATS.join(", ")}\n`);
    return 2;
  }

  const exported = pipeline.exportTheme(themeId);
  for (const w of exported.warnings) process.stderr.write(`warning: ${w}\n`);

  const content = renderExport(exported, format);
  if (typeof ctx.values.out === "string") {
    writeFile(ctx.values.out, content);
    process.stdout.write(`wrote ${ctx.values.out}\n`);
  } else {
    process.stdout.write(content);
  }
  return 0;
}

/* ---------- helpers ---------- */

/**
 * Which agent a single-agent command should act on. With one agent in the
 * database the answer is obvious; with several, guessing would silently report
 * on the wrong product, so it asks.
 */
function resolveAgent(pipeline: Pipeline, ctx: Ctx): string | null {
  if (typeof ctx.values.agent === "string") return ctx.values.agent;
  const agents = pipeline.agents();
  if (agents.length === 1) return agents[0]!;
  if (agents.length === 0) {
    process.stderr.write("no traces ingested yet\n");
    return null;
  }
  process.stderr.write(
    `this database holds several agents (${agents.join(", ")}); pick one with --agent <name>\n`,
  );
  return null;
}

function floatOption(ctx: Ctx, name: string): number | undefined {
  const raw = ctx.values[name];
  if (typeof raw !== "string") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got ${JSON.stringify(raw)}`);
  return n;
}

function intOption(ctx: Ctx, name: string): number | undefined {
  const raw = ctx.values[name];
  if (typeof raw !== "string") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got ${JSON.stringify(raw)}`);
  return Math.floor(n);
}

function writeFile(path: string, content: string): void {
  const dir = dirname(path);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
  writeFileSync(path, content);
}
