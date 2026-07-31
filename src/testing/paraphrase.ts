import type { Embedder, FacetDef, FacetSummary, Summarizer, Trace } from "../types.ts";
import { gaussian, mulberry32, pick } from "./random.ts";

/**
 * Fakes for the one question the rest of the suite cannot ask: does clustering
 * survive lexical variation?
 *
 * `KeywordSummarizer` emits a byte-identical line for every instance of a given
 * failure, so e2e's purity and recall numbers measure the plumbing — ingest,
 * storage, windowing, lifecycle — and say nothing about grouping. Two traces
 * with the same string group at cosine 1.0 under any embedder at all.
 *
 * `ParaphraseSummarizer` breaks that: same behavior, different sentence every
 * time, which is what a real model does.
 *
 * `ConceptEmbedder` is an **oracle**, and that word is load-bearing. It is told
 * the ground-truth concept and places the vector accordingly. It is therefore
 * not evidence that any real embedder is semantic — it cannot be. It exists so
 * the clusterer can be tested at a *stated* geometry, turning the untestable
 * claim "sift groups paraphrases" into a conditional one that is testable
 * offline: given an embedder with this spread, sift recovers one theme per
 * behavior. Whether a real embedder has that spread is an assumption
 * (REAL_EMBEDDING_GEOMETRY below), not something this file proves.
 */

/** The five behaviors `generateDemoTraces` actually plants, one concept each. */
export const PARAPHRASE_CONCEPTS = [
  "retry-loop",
  "tool:fetch_document",
  "tool:lookup_billing",
  "tool:check_policy",
  "tool:create_ticket",
];

/**
 * Phrasings per concept. Deliberately share no distinctive vocabulary across
 * concepts — a bank where every retry line and every lookup line both said
 * "the agent" would let a lexical embedder cheat and prove nothing.
 *
 * `{tool}` and `{n}` are filled from the trace, so variation is continuous
 * rather than a closed set of eight strings.
 */
export const PARAPHRASE_BANKS: Record<string, string[]> = {
  "retry-loop": [
    "hammered {tool} {n} times in a row with no backoff",
    "kept re-issuing an identical {tool} request after every deadline elapsed",
    "stuck cycling {n} {tool} attempts, none of which ever came back",
    "fired {tool} again and again ({n} tries) before abandoning the ask",
    "looped without pause on {tool}; all {n} attempts expired",
    "same {tool} invocation repeated {n} times, each aborted on its time limit",
  ],
  "tool:fetch_document": [
    "pulled a huge {tool} payload and then lost track of the original question",
    "buried its own context under a giant {tool} result and asked for a restatement",
    "retrieved an oversized body through {tool}, then requested the ask again",
    "swamped by what {tool} returned; ended up querying what was wanted",
    "grabbed a long {tool} blob and afterwards could not recall the ask",
    "drowned the window in {tool} output before begging for a repeat",
  ],
  "tool:lookup_billing": [
    "read the account figure off {tool} and quoted it back",
    "answered a charges question straight from {tool} in {n} turns",
    "surfaced the outstanding amount via {tool} and stated when it falls due",
    "resolved a statement query using {tool}, no escalation",
    "reported the sum owed after a single {tool} read",
    "closed out an invoice question with {tool} data alone",
  ],
  "tool:check_policy": [
    "declined the money-back ask after consulting {tool}",
    "quoted the rules from {tool} and refused to act on its own",
    "turned down the reimbursement, citing what {tool} says",
    "deflected to another department once {tool} showed approval was required",
    "used {tool} to establish it lacked authority, then said no",
    "explained via {tool} that someone senior has to sign it off",
  ],
  "tool:create_ticket": [
    "opened a case through {tool} and handed the angry customer to staff",
    "escalated to a person, filing {tool} at high priority",
    "apologised for the wait and raised {tool} for human follow-up",
    "passed the complaint on by creating {tool} for a colleague",
    "routed an irate contact to a teammate after {tool}",
    "logged the grievance with {tool} so a human could take over",
  ],
};

/**
 * The embedding geometry the offline harness assumes a real model has: two
 * paraphrases of one behavior around 0.80 cosine, two different behaviors
 * around 0.45.
 *
 * These are an **estimate** for text-embedding-3-small over one-line behavior
 * summaries, not a measurement. Every offline conclusion drawn at this geometry
 * is conditional on it. Nothing in the offline suite can validate it: that takes
 * a run against a real embedder (see docs/TESTING.md).
 */
export const REAL_EMBEDDING_GEOMETRY = { intraCosine: 0.8, interCosine: 0.45 };

/**
 * Same behavior, different sentence every time.
 *
 * Reads the same trace signals `KeywordSummarizer` does (a repeated tool means
 * a retry loop, otherwise the tool that was used), then picks a phrasing seeded
 * by the trace id — order-independent, so pipeline scheduling cannot change
 * what a trace summarizes to.
 *
 * Gives every facet the same line, so it is only meaningful under a one-facet
 * config; a four-facet preset gets four identical facets, not an error.
 */
export class ParaphraseSummarizer implements Summarizer {
  /** summary line -> concept, filled as it goes. Public so a second instance
   *  with a different seed can record into the same oracle: that is how a test
   *  produces a phrasing discovery never saw while keeping one ground truth. */
  readonly concepts: Map<string, string>;
  private seed: number;

  constructor(opts: { seed?: number; concepts?: Map<string, string> } = {}) {
    this.seed = opts.seed ?? 7;
    this.concepts = opts.concepts ?? new Map();
  }

  async summarize(trace: Trace, facets: FacetDef[]): Promise<FacetSummary[]> {
    const line = this.line(trace);
    return facets.map((f) => ({ traceId: trace.id, facet: f.name, summary: line }));
  }

  /** Ground truth for a line this summarizer produced. Unknown lines throw. */
  conceptOf(summary: string): string {
    const concept = this.concepts.get(summary);
    if (!concept) throw new Error(`ParaphraseSummarizer never produced ${JSON.stringify(summary)}`);
    return concept;
  }

  private line(trace: Trace): string {
    const tools: string[] = [];
    for (const m of trace.text.matchAll(/^tool: ([^\s]+)/gm)) tools.push(m[1]!);
    if (tools.length === 0) throw new Error(`ParaphraseSummarizer needs a tool call to classify trace ${trace.id}`);

    const repeated = tools.find((t, i) => tools.indexOf(t) !== i);
    const concept = repeated ? "retry-loop" : `tool:${tools[0]}`;
    const bank = PARAPHRASE_BANKS[concept];
    if (!bank) throw new Error(`no phrase bank for concept ${JSON.stringify(concept)}`);

    const rng = mulberry32(this.seed + fnv1a(trace.id));
    const line = pick(rng, bank).replace("{tool}", repeated ?? tools[0]!).replace("{n}", String(tools.length));

    // A string two concepts both emit would silently corrupt every purity
    // number computed from conceptOf, so refuse to be that fixture.
    const existing = this.concepts.get(line);
    if (existing && existing !== concept) {
      throw new Error(`phrase banks collide: ${JSON.stringify(line)} is both ${existing} and ${concept}`);
    }
    this.concepts.set(line, concept);
    return line;
  }
}

export interface ConceptEmbedderOptions {
  dimensions: number;
  /** every concept that may appear; position fixes the direction, not call order */
  concepts: string[];
  /** ground truth for a summary — an oracle, which is the whole point */
  conceptOf: (summary: string) => string;
  /** target mean cosine between two summaries of the same concept */
  intraCosine: number;
  /** target mean cosine between summaries of different concepts */
  interCosine: number;
  seed?: number;
}

/**
 * Places a summary near its concept's direction, at a *stated* geometry.
 *
 * Parameterized by target cosines rather than a raw sigma because sigma's
 * meaning changes with `dimensions`: `ModeEmbedder({dimensions: 512, noise:
 * 0.1})` yields an intra-cosine of 0.16 and clusters nothing, which is a very
 * quiet way for a test to stop testing anything. Here the knob is the number a
 * reader wants to reason about.
 *
 * `interCosine` is deliberately non-zero. Mutually orthogonal concept
 * directions make every threshold pass trivially; real embedding spaces are
 * anisotropic and unrelated text still shares a lot of direction.
 *
 *   v = shared·e₀ + e_concept + N(0, σ²I)
 *   intra = (shared²+1)/(shared²+1+dσ²)   inter = shared²/(shared²+1+dσ²)
 *
 * solved for `shared` and `σ` from the two targets.
 */
export class ConceptEmbedder implements Embedder {
  readonly dimensions: number;
  private concepts: string[];
  private conceptOf: (summary: string) => string;
  private shared: number;
  private sigma: number;
  private seed: number;

  constructor(opts: ConceptEmbedderOptions) {
    const { intraCosine: intra, interCosine: inter } = opts;
    if (!(inter > 0 && inter < intra && intra < 1)) {
      throw new Error(`ConceptEmbedder needs 0 < interCosine < intraCosine < 1, got ${inter} and ${intra}`);
    }
    // one basis direction for the shared component plus one per concept
    if (opts.concepts.length + 1 > opts.dimensions) {
      throw new Error("ConceptEmbedder needs one dimension per concept plus one shared");
    }
    const sharedSq = (inter / intra) / (1 - inter / intra);
    this.shared = Math.sqrt(sharedSq);
    this.sigma = Math.sqrt(((1 + sharedSq) * (1 / intra - 1)) / opts.dimensions);
    this.dimensions = opts.dimensions;
    this.concepts = opts.concepts;
    this.conceptOf = opts.conceptOf;
    this.seed = opts.seed ?? 3;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const concept = this.conceptOf(text);
    const idx = this.concepts.indexOf(concept);
    if (idx === -1) throw new Error(`ConceptEmbedder was not given concept ${JSON.stringify(concept)}`);

    // seeded from the text, so the same summary always embeds identically no
    // matter which batch it arrives in
    const rng = mulberry32(this.seed + fnv1a(text));
    const v = new Array<number>(this.dimensions).fill(0);
    v[0] = this.shared;
    v[idx + 1] = 1;
    for (let i = 0; i < this.dimensions; i++) v[i]! += gaussian(rng) * this.sigma;

    let sum = 0;
    for (const x of v) sum += x * x;
    const inv = 1 / Math.sqrt(sum);
    return v.map((x) => x * inv);
  }
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
