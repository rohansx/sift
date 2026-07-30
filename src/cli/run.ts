import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { ConfigError, loadConfig, type DeepPartial, type SiftConfig } from "../config.ts";
import { createPipeline, type Pipeline } from "../pipeline.ts";
import { renderDeltaMarkdown, renderThemeMarkdown } from "../report/markdown.ts";
import { renderDeltaTerminal, renderIssuesList } from "../report/terminal.ts";
import { EXPORT_FORMATS, renderExport, type ExportFormat } from "../export/evals.ts";
import { generateDemoTraces } from "../examples/generate-demo-traces.ts";
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
  summarize     facet-summarize and embed traces that do not have summaries yet
  bootstrap     discover themes from everything not yet assigned
  assign        assign new traces to existing themes; re-discover on residual pressure
  analyze       ingest + summarize + discover/assign in one pass

VIEWS
  report        the issues list
  delta         what changed between two windows
  themes        list themes, optionally filtered by state
  show          one theme in detail, with exemplar traces

LIFECYCLE
  resolve       mark a theme resolved (it will flag as REGRESSED if traffic returns)
  mute          mark a theme known and accepted; it stops appearing in deltas
  reopen        return a theme to active
  relabel       change a theme's label without changing its identity

OTHER
  export        emit a theme as eval cases and a scorer prompt
  demo          generate synthetic traces with planted failure modes
  help, version

GLOBAL OPTIONS
  --db <path>          sqlite database (default ./sift.db, env SIFT_DB)
  --config <path>      config file (default ./sift.config.json)
  --preset <name>      facet preset: chat | pipeline | coding | support
  --json               machine-readable output where it makes sense
  --no-color           plain output (colour is off by default when piping)

EXAMPLES
  sift demo --out ./demo-traces.jsonl
  sift analyze --otlp ./demo-traces.jsonl
  sift report
  sift delta --from v1.2 --to v1.3 --facet behavior
  sift export SIFT-14 --format mastra-scorer --out scorers/retry.ts

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
  traces: { type: "string" },
  seed: { type: "string" },
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

  if (values.version) {
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
    case "ingest":
      return withPipeline(ctx, cmdIngest);
    case "summarize":
      return withPipeline(ctx, cmdSummarize);
    case "bootstrap":
      return withPipeline(ctx, cmdBootstrap);
    case "assign":
      return withPipeline(ctx, cmdAssign);
    case "analyze":
      return withPipeline(ctx, cmdAnalyze);
    case "report":
      return withPipeline(ctx, cmdReport);
    case "delta":
      return withPipeline(ctx, cmdDelta);
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

async function withPipeline(ctx: Ctx, fn: (p: Pipeline, ctx: Ctx) => Promise<number> | number): Promise<number> {
  const pipeline = createPipeline(ctx.cfg, {
    log: ctx.json ? () => {} : (m) => process.stderr.write(`${m}\n`),
  });
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

async function cmdSummarize(pipeline: Pipeline, ctx: Ctx): Promise<number> {
  const opts: { limit?: number } = {};
  const limit = intOption(ctx, "limit");
  if (limit !== undefined) opts.limit = limit;

  const result = await pipeline.summarize(opts);
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`summarized ${result.traces} traces into ${result.summaries} facet lines, embedded ${result.embedded}\n`);
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
  for (const { facet, created } of results) {
    process.stdout.write(`${facet}: ${created.length} themes discovered\n`);
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
    process.stdout.write(`${r.facet}: ${r.assigned} assigned, ${r.residual} residual\n`);
    for (const t of r.rediscovered) process.stdout.write(`  NEW ${t.id}  ${t.label}  (${t.memberCount})\n`);
    for (const t of [...r.transitions, ...r.autoResolved]) {
      process.stdout.write(`  ${t.themeId}: ${t.from} -> ${t.to}\n`);
    }
  }
  return 0;
}

async function cmdAnalyze(pipeline: Pipeline, ctx: Ctx): Promise<number> {
  const opts: { otlpPath?: string; agentId?: string; limit?: number } = {};
  const path = typeof ctx.values.otlp === "string" ? ctx.values.otlp : ctx.positionals[0];
  if (path) opts.otlpPath = path;
  if (typeof ctx.values.agent === "string") opts.agentId = ctx.values.agent;
  const limit = intOption(ctx, "limit");
  if (limit !== undefined) opts.limit = limit;

  const result = await pipeline.analyze(opts);
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  return cmdReport(pipeline, ctx);
}

function cmdReport(pipeline: Pipeline, ctx: Ctx): number {
  const opts: { facet?: string; window?: string } = {};
  if (typeof ctx.values.facet === "string") opts.facet = ctx.values.facet;
  if (typeof ctx.values.window === "string") opts.window = ctx.values.window;
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
  const agentId = pipeline.store.agentIds()[0];
  for (const report of reports) {
    const listOpts: { agentId?: string; color: boolean } = { color: ctx.color };
    if (agentId) listOpts.agentId = agentId;
    process.stdout.write(renderIssuesList(report, listOpts));
  }
  return 0;
}

function cmdDelta(pipeline: Pipeline, ctx: Ctx): number {
  const facet = typeof ctx.values.facet === "string" ? ctx.values.facet : pipeline.facets[0]!.name;
  let from = typeof ctx.values.from === "string" ? ctx.values.from : undefined;
  let to = typeof ctx.values.to === "string" ? ctx.values.to : undefined;

  if (!from || !to) {
    const pair = pipeline.latestWindowPair(facet);
    if (!pair) {
      process.stderr.write(`facet "${facet}" does not have two windows to compare yet\n`);
      return 2;
    }
    from ??= pair.from;
    to ??= pair.to;
  }

  const report = pipeline.delta(facet, from, to);
  const format = typeof ctx.values.format === "string" ? ctx.values.format : ctx.json ? "json" : "terminal";
  if (format === "json") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (format === "md" || format === "markdown") process.stdout.write(renderDeltaMarkdown(report));
  else process.stdout.write(renderDeltaTerminal(report, { color: ctx.color }));
  return 0;
}

function cmdThemes(pipeline: Pipeline, ctx: Ctx): number {
  const stateFilter = typeof ctx.values.state === "string" ? ctx.values.state : undefined;
  if (stateFilter && !THEME_STATES.includes(stateFilter as ThemeState)) {
    process.stderr.write(`unknown state "${stateFilter}"; expected one of ${THEME_STATES.join(", ")}\n`);
    return 2;
  }

  let themes = pipeline.store.allThemes();
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
  for (const t of themes) {
    process.stdout.write(
      `${t.id.padEnd(idWidth)}  ${t.state.padEnd(stateWidth)}  ${String(t.memberCount).padStart(5)}  ${t.facet}  ${t.label}\n`,
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

  let theme;
  if (command === "resolve") theme = pipeline.registry.resolve(themeId, note);
  else if (command === "mute") theme = pipeline.registry.mute(themeId, note);
  else if (command === "reopen") theme = pipeline.registry.reopen(themeId);
  else {
    const label = typeof ctx.values.label === "string" ? ctx.values.label : ctx.positionals.slice(1).join(" ");
    if (!label) {
      process.stderr.write(`relabel needs a new label: sift relabel ${themeId} --label "..."\n`);
      return 2;
    }
    theme = pipeline.registry.relabel(themeId, label);
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
