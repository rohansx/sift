import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FacetDef } from "./types.ts";

/**
 * Facet presets and configuration.
 *
 * Mastra hardcodes four chat-shaped dimensions. sift makes facets per-agent-type
 * config, because batch pipelines have no sentiment and coding agents need test
 * outcomes (OVERVIEW.md §3.5). A preset is a starting point, not a schema.
 */

export const FACET_PRESETS: Record<string, FacetDef[]> = {
  chat: [
    { name: "goal", instruction: "What is the user trying to achieve or have completed? One sentence, no identifiers." },
    { name: "outcome", instruction: "Did they get it? Answer with one of: completed, partial, blocked, failed, unresolved, unclear, plus a short reason." },
    { name: "behavior", instruction: "Describe the agent's notable behavior: tool use, omissions, retries, failures, recovery. One sentence." },
    { name: "sentiment", instruction: "The user's emotional state or attitude, one short phrase." },
  ],
  pipeline: [
    { name: "input-shape", instruction: "Characterize the input this run received (size, type, notable properties). One sentence, no identifiers." },
    { name: "outcome", instruction: "One of: completed, partial, failed, plus which stage and why if not completed." },
    { name: "failure-stage", instruction: "If anything went wrong, name the stage and the first error line. Otherwise say 'none'." },
    { name: "resource-behavior", instruction: "Notable resource behavior: retries, timeouts, unusually long steps, large outputs. One sentence." },
  ],
  coding: [
    { name: "task", instruction: "What was the agent asked to build or fix? One sentence, no identifiers." },
    { name: "outcome", instruction: "One of: completed, partial, failed, plus whether tests passed." },
    { name: "files-touched", instruction: "Rough shape of the change: how many files, what kind (source/tests/config)." },
    { name: "behavior", instruction: "Notable behavior: retries, wrong-file edits, reverted changes, tool failures, recovery. One sentence." },
  ],
  support: [
    { name: "issue-category", instruction: "What category of issue is this? Short phrase, no identifiers." },
    { name: "outcome", instruction: "One of: resolved, escalated, abandoned, unresolved, plus a short reason." },
    { name: "resolution-path", instruction: "How was it handled: which tools/lookups, how many turns, any handoff. One sentence." },
    { name: "sentiment", instruction: "The user's emotional state or attitude, one short phrase." },
  ],
};

export type LlmProvider = "anthropic" | "openai" | "fake";
export type EmbeddingProvider = "openai" | "hash";

export interface LlmConfig {
  provider: LlmProvider;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  baseUrl: string;
  apiKey?: string;
  model: string;
  dimensions: number;
}

export interface SiftConfig {
  dbPath: string;
  /** facet preset name; ignored when `facets` is set */
  preset: string;
  /** explicit facet definitions, overriding the preset */
  facets?: FacetDef[];
  /** cosine similarity at or above which a summary joins an existing theme */
  assignThreshold: number;
  /** residual share of a window that triggers re-discovery on the residual pile */
  rediscoverResidualShare: number;
  /** minimum members for a discovered cluster to become a theme; below this -> noise */
  minClusterSize: number;
  /** cosine *distance* at which agglomerative discovery stops merging */
  mergeThreshold: number;
  /** |change| beyond this many standard deviations of a theme's history is notable */
  deltaSigma: number;
  /** how many exemplar traces to keep per theme for display and eval export */
  maxExemplars: number;
  /** assignments after which a `new` theme becomes `active` */
  activateAfter: number;
  /** consecutive windows with zero assignments before an active theme auto-resolves; 0 disables */
  autoResolveAfterEmptyWindows: number;
  llm: LlmConfig;
  embeddings: EmbeddingConfig;
}

export const DEFAULT_CONFIG: SiftConfig = {
  dbPath: "./sift.db",
  preset: "chat",
  assignThreshold: 0.72,
  rediscoverResidualShare: 0.08,
  minClusterSize: 5,
  mergeThreshold: 0.35,
  deltaSigma: 2,
  maxExemplars: 5,
  activateAfter: 10,
  autoResolveAfterEmptyWindows: 0,
  llm: {
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-haiku-4-5-20251001",
  },
  embeddings: {
    provider: "openai",
    baseUrl: "https://api.openai.com",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const FACET_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Throws unless the facet list is usable as a set of stable storage keys. */
export function validateFacets(facets: FacetDef[]): FacetDef[] {
  if (!Array.isArray(facets) || facets.length === 0) {
    throw new ConfigError("at least one facet is required");
  }
  const seen = new Set<string>();
  for (const f of facets) {
    if (!f || typeof f.name !== "string" || !FACET_NAME_RE.test(f.name)) {
      throw new ConfigError(
        `invalid facet name ${JSON.stringify(f?.name)}: facet names must be lowercase kebab-case (e.g. "failure-stage")`,
      );
    }
    if (seen.has(f.name)) throw new ConfigError(`duplicate facet ${JSON.stringify(f.name)}`);
    seen.add(f.name);
    if (typeof f.instruction !== "string" || f.instruction.trim().length === 0) {
      throw new ConfigError(`facet ${JSON.stringify(f.name)} has no instruction`);
    }
  }
  return facets;
}

/** The facets this config actually runs with: explicit list, else the named preset. */
export function resolveFacets(cfg: Pick<SiftConfig, "preset" | "facets">): FacetDef[] {
  if (cfg.facets && cfg.facets.length > 0) return validateFacets(cfg.facets);
  const preset = FACET_PRESETS[cfg.preset];
  if (!preset) {
    throw new ConfigError(
      `unknown preset ${JSON.stringify(cfg.preset)}; available: ${Object.keys(FACET_PRESETS).sort().join(", ")}`,
    );
  }
  return preset;
}

export const CONFIG_FILENAME = "sift.config.json";

export interface LoadConfigOptions {
  /** explicit config file; missing file is an error (unlike discovery) */
  configPath?: string;
  /** directory to look for sift.config.json in; defaults to process.cwd() */
  cwd?: string;
  /** defaults to process.env; pass a literal for tests */
  env?: Record<string, string | undefined>;
  /** highest-precedence overrides, e.g. from CLI flags */
  overrides?: DeepPartial<SiftConfig>;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K];
};

/**
 * Precedence, lowest to highest: defaults < config file < environment < overrides.
 * Everything is validated once at the end so a caller sees all problems at once.
 */
export function loadConfig(opts: LoadConfigOptions = {}): SiftConfig {
  const env = opts.env ?? process.env;
  const fileLayer = readConfigFile(opts);
  const envLayer = envConfig(env);

  let cfg = merge(DEFAULT_CONFIG, fileLayer);
  cfg = merge(cfg, envLayer);
  cfg = merge(cfg, opts.overrides ?? {});

  validateConfig(cfg);
  return cfg;
}

function readConfigFile(opts: LoadConfigOptions): DeepPartial<SiftConfig> {
  let path: string | undefined;
  if (opts.configPath) {
    path = resolve(opts.configPath);
    if (!existsSync(path)) throw new ConfigError(`config file not found: ${path}`);
  } else {
    const candidate = join(opts.cwd ?? process.cwd(), CONFIG_FILENAME);
    if (!existsSync(candidate)) return {};
    path = candidate;
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`could not read config file ${path}: ${(err as Error).message}`);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as DeepPartial<SiftConfig>;
  } catch (err) {
    throw new ConfigError(`invalid JSON in config file ${path}: ${(err as Error).message}`);
  }
}

function envConfig(env: Record<string, string | undefined>): DeepPartial<SiftConfig> {
  const out: Record<string, unknown> = {};
  const llm: Record<string, unknown> = {};
  const embeddings: Record<string, unknown> = {};

  const str = (key: string): string | undefined => {
    const v = env[key];
    return v === undefined || v === "" ? undefined : v;
  };
  const num = (key: string): number | undefined => {
    const v = str(key);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new ConfigError(`${key} must be a number, got ${JSON.stringify(v)}`);
    return n;
  };

  assign(out, "dbPath", str("SIFT_DB"));
  assign(out, "preset", str("SIFT_PRESET"));
  assign(out, "assignThreshold", num("SIFT_ASSIGN_THRESHOLD"));
  assign(out, "rediscoverResidualShare", num("SIFT_RESIDUAL_SHARE"));
  assign(out, "minClusterSize", num("SIFT_MIN_CLUSTER_SIZE"));
  assign(out, "mergeThreshold", num("SIFT_MERGE_THRESHOLD"));
  assign(out, "deltaSigma", num("SIFT_DELTA_SIGMA"));
  assign(out, "maxExemplars", num("SIFT_MAX_EXEMPLARS"));

  assign(llm, "provider", str("SIFT_LLM_PROVIDER"));
  assign(llm, "baseUrl", str("SIFT_LLM_BASE_URL"));
  assign(llm, "apiKey", str("SIFT_LLM_API_KEY"));
  assign(llm, "model", str("SIFT_LLM_MODEL"));

  assign(embeddings, "provider", str("SIFT_EMBED_PROVIDER"));
  assign(embeddings, "baseUrl", str("SIFT_EMBED_BASE_URL"));
  assign(embeddings, "apiKey", str("SIFT_EMBED_API_KEY"));
  assign(embeddings, "model", str("SIFT_EMBED_MODEL"));
  assign(embeddings, "dimensions", num("SIFT_EMBED_DIMENSIONS"));

  if (Object.keys(llm).length) out.llm = llm;
  if (Object.keys(embeddings).length) out.embeddings = embeddings;
  return out as DeepPartial<SiftConfig>;
}

function assign(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

/** Shallow-merge, one level deep into the two nested provider blocks. */
function merge(base: SiftConfig, layer: DeepPartial<SiftConfig>): SiftConfig {
  return {
    ...base,
    ...stripUndefined(layer as Record<string, unknown>),
    llm: { ...base.llm, ...stripUndefined((layer.llm ?? {}) as Record<string, unknown>) },
    embeddings: { ...base.embeddings, ...stripUndefined((layer.embeddings ?? {}) as Record<string, unknown>) },
  } as SiftConfig;
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

/** Collects every problem before throwing, so one run surfaces all of them. */
export function validateConfig(cfg: SiftConfig): void {
  const problems: string[] = [];

  const inRange = (key: string, v: unknown, lo: number, hi: number) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) {
      problems.push(`${key} must be a number in [${lo}, ${hi}], got ${JSON.stringify(v)}`);
    }
  };
  const intAtLeast = (key: string, v: unknown, min: number) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
      problems.push(`${key} must be an integer >= ${min}, got ${JSON.stringify(v)}`);
    }
  };

  if (typeof cfg.dbPath !== "string" || cfg.dbPath.length === 0) problems.push("dbPath must be a non-empty string");
  // cosine similarity lives in [-1, 1]; anything outside is a typo, not a policy
  inRange("assignThreshold", cfg.assignThreshold, -1, 1);
  inRange("rediscoverResidualShare", cfg.rediscoverResidualShare, 0, 1);
  inRange("mergeThreshold", cfg.mergeThreshold, 0, 2);
  intAtLeast("minClusterSize", cfg.minClusterSize, 2);
  intAtLeast("maxExemplars", cfg.maxExemplars, 1);
  intAtLeast("activateAfter", cfg.activateAfter, 1);
  intAtLeast("autoResolveAfterEmptyWindows", cfg.autoResolveAfterEmptyWindows, 0);
  if (typeof cfg.deltaSigma !== "number" || !Number.isFinite(cfg.deltaSigma) || cfg.deltaSigma < 0) {
    problems.push(`deltaSigma must be a non-negative number, got ${JSON.stringify(cfg.deltaSigma)}`);
  }
  intAtLeast("embeddings.dimensions", cfg.embeddings.dimensions, 1);

  const providers: Array<[string, string, readonly string[]]> = [
    ["llm.provider", cfg.llm.provider, ["anthropic", "openai", "fake"]],
    ["embeddings.provider", cfg.embeddings.provider, ["openai", "hash"]],
  ];
  for (const [key, value, allowed] of providers) {
    if (!allowed.includes(value)) {
      problems.push(`${key} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
    }
  }

  try {
    resolveFacets(cfg);
  } catch (err) {
    problems.push((err as Error).message);
  }

  if (problems.length > 0) {
    throw new ConfigError(`invalid configuration:\n  - ${problems.join("\n  - ")}`);
  }
}
