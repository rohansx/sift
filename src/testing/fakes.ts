import type { Embedder, FacetDef, FacetSummary, Labeler, Summarizer, Trace } from "../types.ts";
import { gaussian, mulberry32 } from "./random.ts";

/**
 * Offline providers.
 *
 * These exist so the entire pipeline — summarize, embed, cluster, assign,
 * lifecycle, delta, export — can be exercised with no API key and no network,
 * both in the test suite and in `sift demo`. A tool whose core logic can only
 * be verified by spending money on a hosted model is a tool whose core logic
 * does not get verified.
 */

/* ---------- summarizers ---------- */

interface TraceSignals {
  tools: string[];
  repeatedTools: string[];
  errors: string[];
  hasTimeout: boolean;
  slowestMs: number;
  firstInput: string;
  lastOutput: string;
  stepCount: number;
}

function readSignals(text: string): TraceSignals {
  const lines = text.split("\n");
  const toolCounts = new Map<string, number>();
  const errors: string[] = [];
  const inputs: string[] = [];
  const outputs: string[] = [];
  let slowestMs = 0;
  let stepCount = 0;

  for (const line of lines) {
    const step = /^## (.+?)(?: \((\d+)ms\))?$/.exec(line);
    if (step) {
      stepCount++;
      if (step[2]) slowestMs = Math.max(slowestMs, Number(step[2]));
      continue;
    }
    const tool = /^tool: ([^\s]+)/.exec(line);
    if (tool) toolCounts.set(tool[1]!, (toolCounts.get(tool[1]!) ?? 0) + 1);
    const err = /^ERROR: (.+)$/.exec(line);
    if (err) errors.push(err[1]!);
    if (line.startsWith("input: ")) inputs.push(line.slice(7));
    if (line.startsWith("user: ")) inputs.push(line.slice(6));
    if (line.startsWith("output: ")) outputs.push(line.slice(8));
    if (line.startsWith("assistant: ")) outputs.push(line.slice(11));
    if (/timeout|timed out/i.test(line)) errors.push("timeout");
  }

  return {
    tools: [...toolCounts.keys()],
    repeatedTools: [...toolCounts.entries()].filter(([, n]) => n > 1).map(([t]) => t),
    errors: [...new Set(errors)],
    hasTimeout: /timeout|timed out/i.test(text),
    slowestMs,
    firstInput: inputs[0] ?? "",
    lastOutput: outputs[outputs.length - 1] ?? "",
    stepCount,
  };
}

function keyPhrase(text: string, fallback: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return fallback;
  return cleaned.length > 90 ? `${cleaned.slice(0, 87)}...` : cleaned;
}

/**
 * Derives facet lines from the rendered trace with rules instead of a model.
 * Deterministic by construction: the same trace always yields the same lines,
 * so tests never drift run to run.
 */
export class KeywordSummarizer implements Summarizer {
  async summarize(trace: Trace, facets: FacetDef[]): Promise<FacetSummary[]> {
    const s = readSignals(trace.text);
    return facets.map((f) => ({
      traceId: trace.id,
      facet: f.name,
      summary: this.line(f.name, s),
    }));
  }

  private line(facet: string, s: TraceSignals): string {
    switch (facet) {
      case "goal":
      case "task":
      case "issue-category":
      case "input-shape":
        return keyPhrase(s.firstInput, "unclear request");

      case "outcome":
        if (s.hasTimeout) return "failed: a tool timed out before the request completed";
        if (s.errors.length > 0) return `failed: ${keyPhrase(s.errors[0]!, "error")}`;
        if (s.lastOutput) return `completed: ${keyPhrase(s.lastOutput, "responded")}`;
        return "unresolved: no final response";

      case "behavior":
      case "resource-behavior":
        if (s.repeatedTools.length > 0) {
          return `retry loop: called ${s.repeatedTools.join(", ")} repeatedly${s.hasTimeout ? " after timeouts" : ""}`;
        }
        if (s.hasTimeout) return `tool timeout: ${s.tools.join(", ") || "a tool"} exceeded its deadline`;
        if (s.errors.length > 0) return `error path: ${keyPhrase(s.errors[0]!, "failed step")}`;
        if (s.tools.length > 0) return `straightforward tool use: ${s.tools.join(", ")} over ${s.stepCount} steps`;
        return `no tool use, ${s.stepCount} steps`;

      case "failure-stage":
        if (s.errors.length === 0) return "none";
        return `failed during ${s.tools[0] ?? "an unnamed stage"}: ${keyPhrase(s.errors[0]!, "error")}`;

      case "sentiment":
        if (s.hasTimeout || s.errors.length > 0) return "frustrated";
        return "neutral";

      case "resolution-path":
        return s.tools.length > 0 ? `handled via ${s.tools.join(", ")} in ${s.stepCount} steps` : `answered directly in ${s.stepCount} steps`;

      case "files-touched":
        return `${s.tools.length} tool targets over ${s.stepCount} steps`;

      default:
        return keyPhrase(s.firstInput || s.lastOutput, `${s.stepCount} steps, ${s.tools.length} tools`);
    }
  }
}

/** Replays exactly what a test dictates; refuses to invent anything. */
export class ScriptedSummarizer implements Summarizer {
  private script: Record<string, Record<string, string>>;

  constructor(script: Record<string, Record<string, string>>) {
    this.script = script;
  }

  async summarize(trace: Trace, facets: FacetDef[]): Promise<FacetSummary[]> {
    const entry = this.script[trace.id];
    if (!entry) throw new Error(`ScriptedSummarizer has no script for trace ${trace.id}`);
    return facets.map((f) => ({
      traceId: trace.id,
      facet: f.name,
      summary: entry[f.name] ?? "unclear",
    }));
  }
}

/* ---------- embedders ---------- */

export interface ModeEmbedderOptions {
  dimensions: number;
  /** substrings that identify each planted mode */
  modes: string[];
  seed?: number;
  /** gaussian noise added around the planted direction */
  noise?: number;
}

/**
 * Places text near one of N mutually orthogonal planted directions, chosen by
 * which mode name the text contains. Gives tests known cluster structure with
 * a controllable amount of overlap.
 */
export class ModeEmbedder implements Embedder {
  readonly dimensions: number;
  private modes: string[];
  private noise: number;
  private seed: number;

  constructor(opts: ModeEmbedderOptions) {
    if (opts.modes.length > opts.dimensions) {
      throw new Error("ModeEmbedder needs at least one dimension per mode");
    }
    this.dimensions = opts.dimensions;
    this.modes = opts.modes;
    this.noise = opts.noise ?? 0.1;
    this.seed = opts.seed ?? 1;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t, i) => this.embedOne(t, i));
  }

  modeOf(text: string): number {
    const lower = text.toLowerCase();
    const idx = this.modes.findIndex((m) => lower.includes(m.toLowerCase()));
    return idx === -1 ? this.modes.length % this.dimensions : idx;
  }

  private embedOne(text: string, callIndex: number): number[] {
    const mode = this.modeOf(text);
    // seed from the text so the same string always embeds identically
    const rng = mulberry32(this.seed + hashString(text) + callIndex * 0);
    const v = new Array<number>(this.dimensions).fill(0);
    v[mode % this.dimensions] = 1;
    for (let i = 0; i < this.dimensions; i++) v[i]! += gaussian(rng) * this.noise;
    let sum = 0;
    for (const x of v) sum += x * x;
    const inv = 1 / Math.sqrt(sum);
    return v.map((x) => x * inv);
  }
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 100000;
}

/** Wraps an embedder and records what it was asked to embed. */
export class RecordingEmbedder implements Embedder {
  readonly dimensions: number;
  readonly seen: string[] = [];
  calls = 0;
  private inner: Embedder;

  constructor(inner: Embedder) {
    this.inner = inner;
    this.dimensions = inner.dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    this.seen.push(...texts);
    return this.inner.embed(texts);
  }
}

/* ---------- labelers ---------- */

/** Names a cluster by its most common member summary. No model, no network. */
export class StubLabeler implements Labeler {
  async label(facet: string, memberSummaries: string[]): Promise<{ label: string; description: string }> {
    const counts = new Map<string, number>();
    for (const s of memberSummaries) counts.set(s, (counts.get(s) ?? 0) + 1);
    let best = memberSummaries[0] ?? "unlabeled theme";
    let bestCount = -1;
    for (const [s, n] of counts) {
      if (n > bestCount) {
        best = s;
        bestCount = n;
      }
    }
    const label = best.length > 60 ? `${best.slice(0, 57)}...` : best;
    return { label, description: `traces whose ${facet} resembles: ${label}` };
  }
}
