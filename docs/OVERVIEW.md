# sift: product overview & build plan

Internal design doc. The README sells it; this explains it.

## 1. The problem, precisely

Teams ship an agent. Traffic arrives. Now they have thousands of traces nobody will ever read.

Observability tools (Langfuse, Phoenix, Braintrust) answer two questions well: "show me this trace" and "score this trace against a rubric I wrote." Neither answers the question that actually matters to whoever owns the product: **what are people using this for, and where does it break in ways I didn't anticipate?**

Evals only cover known failure modes. The expensive failures are unknown unknowns. Today the discovery mechanism for those is an engineer reading traces by hand, which stops working around trace 40.

Anthropic's Clio proved the reading can be automated: LLM-summarize each conversation along fixed facets, embed the summaries, cluster, LLM-label the clusters, show only aggregates. Mastra's Trace Intelligence is Clio applied to agent traces, shipped as a cloud-only feature with four fixed facets and a Sankey UI.

## 2. Why the current shape is beatable

Mastra's version has three structural problems, all named in their own category's literature and none solved:

| Problem | Their version | Consequence |
|---|---|---|
| Theme stability | Full re-cluster per run | Labels rename weekly. Can't track anything across time. |
| Incrementality | Batch HDBSCAN-style pipeline | Cost grows with history; can't run continuously |
| Validation | None | No way to know if a theme is real or a clustering artifact |
| Lock-in | Deployed-Studio only, Mastra traces only | Excludes everyone else's stack |
| Fixed facets | goal/outcome/behavior/sentiment | Chat-shaped. Meaningless for batch pipelines, coding agents |

The reframe that fixes the first three simultaneously: **stop thinking clustering dashboard, start thinking Sentry.**

Sentry's value was never "here are your exceptions." It was stable issue grouping with a lifecycle: an issue has identity that persists across deploys, can be new / regressed / resolved / assigned / muted. Identity is what enables tracking, alerting, and accountability. Nobody has built Sentry-grade grouping for agent behavior.

## 3. Core design decisions

### 3.1 Classification-first

Clustering is only the bootstrap. Steady state:

1. New trace arrives → facet summaries → embeddings
2. For each facet, compare against theme centroids in the registry
3. Similarity ≥ τ_assign → assign to theme (update centroid with running mean)
4. Below threshold → residual pile
5. Residual pile > threshold (e.g. 8% of window) → run discovery **on residuals only**, propose new themes, keep existing ones untouched

Existing theme IDs, labels, and history never churn. New behavior surfaces as *new themes*, not as renames of old ones. Cost per trace at steady state: 1 LLM summary call + 1 embedding + N cosine comparisons.

### 3.2 Theme registry & lifecycle

```
Theme {
  id: "SIFT-14"            // stable, never reused
  facet: "behavior"
  label: "tool-retry loop on search_kb"
  centroid: vector          // running mean of members
  exemplars: traceId[]      // 3-5 nearest-to-centroid, for display + eval export
  state: new | active | regressed | resolved | muted
  stats: per-window counts  // powers deltas
}
```

State transitions:
- `new` → `active` after first review or N traces
- `active` → `resolved` manually (or auto if 0 assignments for K windows)
- `resolved` → `regressed` if assignments resume (this is the alert-worthy one)
- anything → `muted` (known + accepted, e.g. "user says thanks")

### 3.3 Deltas as the primary view

The hero screen is not a Sankey. It's an issues list with sparklines and window-over-window change, exactly like Sentry's issue stream. Sankey/alluvial across facets is a secondary drill-down view (it is genuinely nice for "traces in behavior-theme X mostly end in outcome-theme Y").

Delta computation: theme share per window (day / release tag), flag `|Δ| > k·σ` of that theme's historical variance. "Retry-loops on search went 2% → 11% after v1.3" is a page-worthy alert.

### 3.4 Eval-loop export

`sift export SIFT-14 --format mastra-scorer` emits:
- the theme's exemplar traces as fixture inputs
- a generated scorer prompt describing the failure mode ("does the agent enter a retry loop when the search tool times out?")

This closes discovery → regression test → resolved, and it's the validation story: a theme is *real* when a test derived from it catches a regression, or fixing it moves a metric.

### 3.5 Facet presets

```ts
presets = {
  chat:     ["goal", "outcome", "behavior", "sentiment"],
  pipeline: ["input-shape", "outcome", "failure-stage", "resource-behavior"],
  coding:   ["task", "outcome", "files-touched", "test-outcome", "behavior"],
  support:  ["issue-category", "outcome", "resolution-path", "sentiment"],
}
```

Each facet = a name + an extraction instruction. Users define their own per agent.

### 3.6 Privacy posture

Traces are the most PII-dense artifact a company produces, and this technique feeds them wholesale to an LLM. Clio's paper spends half its length on privacy machinery for this reason. sift's answers:

- local-first by default: SQLite, local embeddings, any OpenAI-compatible endpoint (incl. self-hosted)
- summaries are instructed to strip identifiers; only aggregates ever surface in the UI
- future: pluggable pre-summarization pseudonymization gate (a proxy that rewrites PII before the LLM sees it slots directly in front of the facet step)

## 4. Technical stack (TypeScript, deliberately)

The category's obvious implementation is Python (BERTopic, UMAP, HDBSCAN). sift is TypeScript because (a) the agent frameworks that emit these traces are TS, (b) classification-first makes the heavy Python clustering stack optional:

| Layer | Choice | Note |
|---|---|---|
| Ingestion | OTLP GenAI spans (JSONL/HTTP), Mastra storage reader | opentelemetry-js for proto if needed; JSONL needs nothing |
| Summarization | any OpenAI-compatible or Anthropic endpoint via fetch | zero SDK deps |
| Embeddings | provider interface: OpenAI / Voyage / fastembed local | |
| Clustering | pure-TS average-linkage agglomerative over cosine | ~50k was the guess; measured ceiling is ~10k per facet per pass (ROADMAP §Measured limits). UMAP+HDBSCAN can be added later behind the same interface |
| Assignment | nearest centroid, cosine, running-mean updates | the workhorse |
| Storage | SQLite (node:sqlite, Node ≥22) | single file; sqlite-vec was pencilled in for ANN, and measurement says not yet — assignment is linear and spends its time reloading centroids, not searching them |
| CLI | node:util `parseArgs` | commander was the plan; it would have made the dependency list non-empty for argv splitting |
| UI | Vite + React + shadcn/ui, compiled to static assets, served by `sift serve` from `node:http` | planned as a Next.js app and cut for that reason — a second process and a runtime dependency tree. Build-time only: devDependencies, prebuilt into `dist/ui`, on by default and `--no-ui` to disable. Read-only; every mutation is still a CLI command |

## 5. Build plan (7 days)

| Day | Deliverable |
|---|---|
| 1-2 | Pipeline: ingest → summarize → embed → bootstrap cluster → label → markdown report. CLI, no UI. Demoable at this point. |
| 3-4 | Registry: stable IDs, lifecycle, assignment path, residual pile + re-discovery trigger. The differentiator. |
| 5-6 | Deltas across windows/versions + `export --format mastra-scorer`. The money features. |
| 7 | Demo: 2-3 Mastra example agents, ~2k generated traces with injected-but-realistic failure modes (tool that times out on long inputs; prompt that drops instructions past a context length). Loom of sift finding them unprompted. |

Cut line if behind: UI never; Sankey never (v0); Mastra-storage reader can slip (JSONL OTLP is enough for the demo).

*What actually happened:* the plan above held through day 7 and the UI landed after it, once it was clear the read-only screens could be static assets rather than a server — see the UI row in §4. Sankey and the Mastra-storage reader are still cut.

## 6. The demo that sells it

Not a dashboard tour. The story is: *pointed sift at N traces, it surfaced a failure mode nobody told it about, here's the issue link.* One "it found a real bug" beats any diagram. If it can be run against a public trace dataset or a popular OSS agent's example suite, better still.

## 7. Positioning & honest risks

- **This open-sources someone's paid feature.** Mitigation is emphasis: lead with what theirs doesn't have (registry, deltas, eval export, OTel-agnostic ingestion) and frame as "where the category should go," not "your cloud product for free."
- **Langfuse will build a v1 within a year.** They have judge infra and already store the traces. The defensible part is grouping quality over time, which is a grind (Sentry spent years on fingerprinting). As OSS this is a credibility artifact more than a business.
- **The buyer exists above a volume threshold.** Under ~1k traces/day, read them by hand; that's the honest advice and the tool should say so.

## 8. Later / back pocket

- Pseudonymization gate integration (pre-LLM PII rewrite) as the differentiated privacy story
- Sankey drill-down view across facets
- Alerting (webhook on regressed/new themes)
- sqlite-vec ANN when registries get large — measured as not the bottleneck yet, see ROADMAP §Measured limits
- Hierarchical themes (Clio does this; useful past ~100 themes)
