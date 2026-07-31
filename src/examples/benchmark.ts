import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../config.ts";
import { discoverClusters } from "../cluster/bootstrap.ts";
import { ThemeRegistry } from "../registry/index.ts";
import { StubLabeler } from "../testing/fakes.ts";
import { ConceptEmbedder, REAL_EMBEDDING_GEOMETRY } from "../testing/paraphrase.ts";
import { withTempDir } from "../testing/temp.ts";
import { SiftStore } from "../store/db.ts";
import type { FacetSummary, Theme, Trace } from "../types.ts";

/**
 * Where the two hot paths stop being usable.
 *
 * README used to claim brute-force cosine was "fine into the tens of thousands
 * of traces". Nobody had measured it, and the obvious way to measure it is
 * wrong: run this against `KeywordSummarizer` and every instance of a behavior
 * summarizes to a byte-identical line, so the leader pre-pass in
 * `discoverClusters` collapses n points to a handful of leaders and discovery
 * looks linear at any n. That is a property of the fake, not of the algorithm.
 *
 * So the corpus here is built from `ConceptEmbedder` at the geometry the rest
 * of the offline harness assumes a real model has (paraphrases of one behavior
 * around 0.80 cosine, different behaviors around 0.45). Every summary gets its
 * own vector, which is what a real summarizer produces and what the leader pass
 * cannot collapse.
 *
 * Each case runs in its own process so peak RSS is attributable and an
 * out-of-memory case reports itself instead of taking the whole run down.
 *
 *   node src/examples/benchmark.ts
 *   node src/examples/benchmark.ts --sizes 1000,5000 --dims 256 --phases discover
 */

/** Distinct behaviors planted in the corpus — i.e. the themes discovery should find. */
const BEHAVIOR_COUNT = 40;

const DEFAULT_SIZES = [500, 1000, 2000, 5000, 10000];
const DEFAULT_TIMEOUT_S = 900;

const PHASES = ["discover", "assign"] as const;
type Phase = (typeof PHASES)[number];

interface CaseResult {
  ms: number;
  peakRssMb: number;
  /** what the phase produced, for the "did it still do the job" column */
  detail: string;
}

/* ---------- corpus ---------- */

const BEHAVIORS = Array.from({ length: BEHAVIOR_COUNT }, (_, i) => `behavior-${i}`);

/** Summaries are `<behavior> variant <i>`, so the oracle is a prefix read. */
function conceptOf(summary: string): string {
  return summary.slice(0, summary.indexOf(" "));
}

async function corpus(n: number, dims: number): Promise<{ summaries: string[]; embeddings: number[][] }> {
  const summaries = Array.from({ length: n }, (_, i) => `${BEHAVIORS[i % BEHAVIOR_COUNT]} variant ${i}`);
  const embedder = new ConceptEmbedder({
    dimensions: dims,
    concepts: BEHAVIORS,
    conceptOf,
    ...REAL_EMBEDDING_GEOMETRY,
  });
  return { summaries, embeddings: await embedder.embed(summaries) };
}

/* ---------- the two cases ---------- */

async function runDiscover(n: number, dims: number): Promise<CaseResult> {
  const { embeddings } = await corpus(n, dims);

  let leaders: number | null = null;
  const started = performance.now();
  const result = discoverClusters(embeddings, {
    minClusterSize: DEFAULT_CONFIG.minClusterSize,
    mergeThreshold: DEFAULT_CONFIG.mergeThreshold,
    onLeaders: (count) => {
      leaders = count;
    },
  });
  const ms = performance.now() - started;

  const path = leaders === null ? `exact on ${n}` : `${leaders} leaders`;
  return { ms, peakRssMb: peakRssMb(), detail: `${result.clusters.length} themes, ${result.noiseIndices.length} noise, ${path}` };
}

/**
 * Assignment against a registry that already has one theme per behavior — the
 * steady state, where discovery does not run at all. Setup is excluded; only
 * `assignPending` is timed.
 */
async function runAssign(n: number, dims: number): Promise<CaseResult> {
  const { summaries, embeddings } = await corpus(n, dims);
  const facet = "behavior";
  const agentId = "bench-agent";

  return withTempDir(async (dir) => {
    const store = new SiftStore(join(dir, "bench.db"));
    try {
      const now = new Date().toISOString();
      const traces: Trace[] = summaries.map((_, i) => ({
        id: `t${i}`,
        agentId,
        version: "v1.0",
        startedAt: now,
        text: "",
        meta: {},
      }));
      store.insertTraces(traces);
      store.insertSummaries(
        summaries.map((summary, i): FacetSummary => ({ traceId: `t${i}`, facet, summary, embedding: embeddings[i]! })),
      );

      // One theme per behavior, centroid seeded from one phrasing of it — which
      // is what a registry looks like right after a discovery pass.
      const seeds = await corpus(BEHAVIOR_COUNT, dims);
      for (let i = 0; i < BEHAVIOR_COUNT; i++) {
        const theme: Theme = {
          id: store.nextThemeId(),
          agentId,
          facet,
          label: BEHAVIORS[i]!,
          description: "",
          state: "active",
          centroid: seeds.embeddings[i]!,
          memberCount: 1,
          exemplarTraceIds: [],
          createdAt: now,
          updatedAt: now,
        };
        store.insertTheme(theme);
      }

      const registry = new ThemeRegistry(store, DEFAULT_CONFIG, { labeler: new StubLabeler(), agentId });
      const started = performance.now();
      const result = registry.assignPending(facet);
      const ms = performance.now() - started;
      return { ms, peakRssMb: peakRssMb(), detail: `${result.assigned} assigned, ${result.residual} residual` };
    } finally {
      store.close();
    }
  });
}

/** ru_maxrss, which is the process's peak resident set — not its current one. */
function peakRssMb(): number {
  return process.resourceUsage().maxRSS / 1024;
}

/* ---------- driver ---------- */

interface Row {
  phase: Phase;
  n: number;
  outcome: CaseResult | { failure: string };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const rows: Row[] = [];
  for (const phase of args.phases) {
    for (const n of args.sizes) {
      process.stderr.write(`  ${phase} n=${n} ...`);
      const outcome = runCaseInChild(phase, n, args.dims, args.timeoutS);
      process.stderr.write(` ${"failure" in outcome ? outcome.failure : `${(outcome.ms / 1000).toFixed(1)}s`}\n`);
      rows.push({ phase, n, outcome });
      // A phase that already blew its budget will only blow it harder next size
      // up, and the wall is the finding — no point spending an hour confirming it.
      if ("failure" in outcome) break;
    }
  }

  console.log(`\nsift scale benchmark — ${args.dims} dimensions, ${BEHAVIOR_COUNT} planted behaviors, `
    + `intra-cosine ${REAL_EMBEDDING_GEOMETRY.intraCosine} / inter-cosine ${REAL_EMBEDDING_GEOMETRY.interCosine}`);
  console.log(`node ${process.version} on ${process.platform}/${process.arch}\n`);
  console.log("| phase | traces | wall | peak RSS | result |");
  console.log("|---|---:|---:|---:|---|");
  for (const { phase, n, outcome } of rows) {
    if ("failure" in outcome) {
      console.log(`| ${phase} | ${n} | — | — | **${outcome.failure}** |`);
    } else {
      console.log(
        `| ${phase} | ${n} | ${(outcome.ms / 1000).toFixed(2)}s | ${outcome.peakRssMb.toFixed(0)} MB | ${outcome.detail} |`,
      );
    }
  }
}

/**
 * Runs one case in a child process. Isolation is not ceremony here: peak RSS is
 * per-process and monotonic, and the largest sizes are expected to die on an
 * allocation — both of which need a process boundary to report honestly.
 */
function runCaseInChild(phase: Phase, n: number, dims: number, timeoutS: number): CaseResult | { failure: string } {
  const child = spawnSync(
    process.execPath,
    [import.meta.filename, "--worker", phase, String(n), String(dims)],
    { encoding: "utf8", timeout: timeoutS * 1000 },
  );
  if (child.signal || child.status !== 0) {
    const reason = child.signal === "SIGTERM"
      ? `did not finish in ${timeoutS}s`
      : firstErrorLine(child.stderr) || `exited ${child.status}`;
    return { failure: reason };
  }
  const line = child.stdout.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) return { failure: "no result emitted" };
  return JSON.parse(line.slice(7)) as CaseResult;
}

function firstErrorLine(stderr: string): string {
  const line = stderr.split("\n").find((l) => /Error|error|Killed|abort/.test(l));
  return line ? line.trim().slice(0, 90) : "";
}

interface Args {
  sizes: number[];
  dims: number;
  phases: Phase[];
  timeoutS: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sizes: DEFAULT_SIZES,
    dims: DEFAULT_CONFIG.embeddings.dimensions,
    phases: [...PHASES],
    timeoutS: DEFAULT_TIMEOUT_S,
  };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case "--sizes":
        args.sizes = required(value, "--sizes").split(",").map((s) => intOrThrow(s, "--sizes"));
        i++;
        break;
      case "--dims":
        args.dims = intOrThrow(required(value, "--dims"), "--dims");
        i++;
        break;
      case "--phases":
        args.phases = required(value, "--phases").split(",").map((p) => {
          if (!(PHASES as readonly string[]).includes(p)) throw new Error(`unknown phase ${JSON.stringify(p)}; use ${PHASES.join(",")}`);
          return p as Phase;
        });
        i++;
        break;
      case "--timeout":
        args.timeoutS = intOrThrow(required(value, "--timeout"), "--timeout");
        i++;
        break;
      default:
        throw new Error(`unknown option ${JSON.stringify(argv[i])}`);
    }
  }
  return args;
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined) throw new Error(`${flag} needs a value`);
  return value;
}

function intOrThrow(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} needs positive integers, got ${JSON.stringify(value)}`);
  return n;
}

/* ---------- entry ---------- */

const [first, phase, n, dims] = process.argv.slice(2);
if (first === "--worker") {
  const run = phase === "assign" ? runAssign : runDiscover;
  const result = await run(Number(n), Number(dims));
  console.log(`RESULT ${JSON.stringify(result)}`);
} else {
  main();
}
