import { mulberry32 } from "../testing/random.ts";

/**
 * Synthetic support-bot traffic with realistic failure modes planted in it.
 *
 * The demo that sells sift is not a dashboard tour (OVERVIEW.md §6): it is
 * pointing the tool at traces it has been told nothing about and watching it
 * surface a failure mode on its own. That only means something if the failure
 * is planted honestly — buried at a low rate, in the same shape real telemetry
 * has, and never named anywhere the pipeline can see it.
 *
 * Two failures are injected, both borrowed from things that actually happen:
 *   - `search_kb` times out on long queries and the agent retries in a loop
 *     without backing off. Rare in v1.2, common in v1.3 — the regression.
 *   - a long tool output pushes the original request out of context and the
 *     agent asks the user to repeat themselves. Steady across both releases.
 *
 * Everything is seeded, so the demo tells the same story every time.
 */

export interface DemoOptions {
  /** traces per release (two releases are generated) */
  tracesPerVersion?: number;
  seed?: number;
}

export interface DemoScenario {
  name: string;
  /** share of traffic in each release */
  weights: Record<string, number>;
}

const RELEASES = [
  { tag: "v1.2", date: "2026-07-01" },
  { tag: "v1.3", date: "2026-07-15" },
];

/** The planted mix. Only the retry loop changes between releases. */
export const DEMO_SCENARIOS: DemoScenario[] = [
  { name: "billing-resolved", weights: { "v1.2": 0.45, "v1.3": 0.4 } },
  { name: "refund-deflected", weights: { "v1.2": 0.25, "v1.3": 0.22 } },
  { name: "escalated-to-human", weights: { "v1.2": 0.16, "v1.3": 0.13 } },
  { name: "context-lost-after-long-output", weights: { "v1.2": 0.12, "v1.3": 0.1 } },
  { name: "search-retry-loop", weights: { "v1.2": 0.02, "v1.3": 0.15 } },
];

interface SpanInput {
  op: string;
  durationMs: number;
  prompt?: string;
  completion?: string;
  tool?: string;
  toolArgs?: string;
  toolOutput?: string;
  error?: { type: string; message: string };
}

const BILLING_QUESTIONS = [
  "how much is my current bill",
  "why did my bill go up this month",
  "when is my next payment due",
  "can you explain the charges on my invoice",
];
const REFUND_REQUESTS = [
  "i want a refund for my order",
  "please refund the charge from last week",
  "i was charged twice and want my money back",
];
const POLICY_QUESTIONS = [
  "where can i find the return policy document",
  "what is the policy for late deliveries",
  "i need the full terms for cancellations",
];
const ANGRY_OPENERS = [
  "this is unacceptable, i have been waiting for days",
  "i have asked three times already and nobody helped",
  "your service has been terrible this week",
];

function pickFrom(rng: () => number, items: string[]): string {
  return items[Math.floor(rng() * items.length)]!;
}

function scenarioSpans(scenario: string, rng: () => number): SpanInput[] {
  switch (scenario) {
    case "billing-resolved":
      return [
        { op: "chat", durationMs: 400 + Math.floor(rng() * 300), prompt: pickFrom(rng, BILLING_QUESTIONS), completion: "let me pull up your account" },
        { op: "execute_tool", durationMs: 120 + Math.floor(rng() * 100), tool: "lookup_billing", toolArgs: '{"period":"current"}', toolOutput: "balance 42.10, due in 9 days" },
        { op: "chat", durationMs: 500, completion: "your balance is 42.10 and it is due in nine days" },
      ];

    case "refund-deflected":
      return [
        { op: "chat", durationMs: 380, prompt: pickFrom(rng, REFUND_REQUESTS), completion: "let me check what the policy allows" },
        { op: "execute_tool", durationMs: 150, tool: "check_policy", toolArgs: '{"topic":"refund"}', toolOutput: "refunds require supervisor approval" },
        { op: "chat", durationMs: 450, completion: "i am not able to process refunds directly, you will need to contact the billing department" },
      ];

    case "escalated-to-human":
      return [
        { op: "chat", durationMs: 300, prompt: pickFrom(rng, ANGRY_OPENERS), completion: "i am sorry about the delay" },
        { op: "execute_tool", durationMs: 200, tool: "create_ticket", toolArgs: '{"priority":"high"}', toolOutput: "ticket created, assigned to a human agent" },
        { op: "chat", durationMs: 350, completion: "i have escalated this to a human agent who will follow up" },
      ];

    case "context-lost-after-long-output": {
      // A long tool result pushes the original ask out of the window, and the
      // agent ends up asking the user to repeat themselves.
      const longOutput = `document text ${"section ".repeat(200)}end of document`;
      return [
        { op: "chat", durationMs: 350, prompt: pickFrom(rng, POLICY_QUESTIONS), completion: "let me fetch that document" },
        { op: "execute_tool", durationMs: 900 + Math.floor(rng() * 400), tool: "fetch_document", toolArgs: '{"id":"policy"}', toolOutput: longOutput },
        { op: "chat", durationMs: 700, completion: "sorry, could you remind me what you were asking about" },
      ];
    }

    case "search-retry-loop": {
      // The planted regression: search_kb times out on long queries and the
      // agent retries it without backing off.
      const query = pickFrom(rng, POLICY_QUESTIONS);
      const attempts = 3 + Math.floor(rng() * 2);
      const spans: SpanInput[] = [
        { op: "chat", durationMs: 420, prompt: query, completion: "let me search the knowledge base" },
      ];
      for (let i = 0; i < attempts; i++) {
        spans.push({
          op: "execute_tool",
          durationMs: 30000,
          tool: "search_kb",
          toolArgs: JSON.stringify({ q: query, attempt: i + 1 }),
          error: { type: "TimeoutError", message: "search_kb timed out after 30000ms" },
        });
      }
      spans.push({ op: "chat", durationMs: 600, completion: "i am having trouble looking that up right now" });
      return spans;
    }

    default:
      throw new Error(`unknown demo scenario: ${scenario}`);
  }
}

export interface DemoTraceRecord {
  traceId: string;
  scenario: string;
  version: string;
}

export interface DemoData {
  /** OTLP GenAI spans, one JSON object per line */
  jsonl: string;
  /** ground truth, for asserting in tests — never fed to the pipeline */
  records: DemoTraceRecord[];
}

export function generateDemoTraces(opts: DemoOptions = {}): DemoData {
  const perVersion = opts.tracesPerVersion ?? 500;
  const rng = mulberry32(opts.seed ?? 20260730);

  const lines: string[] = [];
  const records: DemoTraceRecord[] = [];
  let traceCounter = 0;

  for (const release of RELEASES) {
    const plan = expandWeights(release.tag, perVersion);
    for (const scenario of plan) {
      const traceId = `demo-${release.tag}-${String(traceCounter++).padStart(5, "0")}`;
      records.push({ traceId, scenario, version: release.tag });

      // spread traces across the release's day so date-windowing works too
      let cursor = Date.parse(`${release.date}T09:00:00.000Z`) + Math.floor(rng() * 8 * 3600 * 1000);
      let spanCounter = 0;

      for (const span of scenarioSpans(scenario, rng)) {
        const start = cursor;
        const end = start + span.durationMs;
        cursor = end + 20;
        lines.push(
          JSON.stringify({
            trace_id: traceId,
            span_id: `${traceId}-s${spanCounter++}`,
            name: span.op,
            start_time: new Date(start).toISOString(),
            end_time: new Date(end).toISOString(),
            attributes: {
              "gen_ai.operation.name": span.op,
              "gen_ai.agent.name": "support-bot",
              "service.version": release.tag,
              ...(span.prompt ? { "gen_ai.prompt": span.prompt } : {}),
              ...(span.completion ? { "gen_ai.completion": span.completion } : {}),
              ...(span.tool ? { "gen_ai.tool.name": span.tool } : {}),
              ...(span.toolArgs ? { "gen_ai.tool.input": span.toolArgs } : {}),
              ...(span.toolOutput ? { "gen_ai.tool.output": span.toolOutput } : {}),
            },
            ...(span.error
              ? {
                  status: { code: "STATUS_CODE_ERROR", message: span.error.message },
                  events: [
                    {
                      name: "exception",
                      attributes: { "exception.type": span.error.type, "exception.message": span.error.message },
                    },
                  ],
                }
              : {}),
          }),
        );
      }
    }
  }

  return { jsonl: `${lines.join("\n")}\n`, records };
}

/**
 * Turns share weights into an exact, deterministic list of scenarios.
 *
 * Deliberately not sampled: a demo whose planted regression is 11% one run and
 * 6% the next cannot be used to demonstrate regression detection.
 */
function expandWeights(version: string, total: number): string[] {
  const out: string[] = [];
  const counts = DEMO_SCENARIOS.map((s) => ({ name: s.name, n: Math.floor((s.weights[version] ?? 0) * total) }));
  const assigned = counts.reduce((a, c) => a + c.n, 0);
  // any rounding remainder goes to the largest bucket, keeping totals exact
  if (assigned < total && counts.length > 0) {
    counts.sort((a, b) => b.n - a.n);
    counts[0]!.n += total - assigned;
  }
  for (const c of counts) for (let i = 0; i < c.n; i++) out.push(c.name);

  // interleave so no window is a solid block of one scenario
  out.sort((a, b) => a.localeCompare(b));
  const interleaved: string[] = [];
  const groups = new Map<string, string[]>();
  for (const name of out) {
    const g = groups.get(name) ?? [];
    g.push(name);
    groups.set(name, g);
  }
  let remaining = out.length;
  while (remaining > 0) {
    for (const g of groups.values()) {
      const next = g.pop();
      if (next) {
        interleaved.push(next);
        remaining--;
      }
    }
  }
  return interleaved;
}
