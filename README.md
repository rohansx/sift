# sift

**Sentry-grade issue tracking for agent behavior.** Open source trace intelligence over OpenTelemetry GenAI spans.

Your agent produces thousands of traces. Nobody reads them. Your evals only catch failure modes you already knew about. The expensive failures are the ones you didn't anticipate, and today the only way to find them is an engineer reading traces by hand until they get bored.

sift reads them for you, groups what it finds into **stable, trackable themes**, and tells you what changed since your last deploy.

```
$ sift analyze --since 7d

  THEMES (agent: support-bot, 2,340 traces)

  ▸ SIFT-14  tool-retry loop on search_kb          ↑ 11.2%  (was 2.1%)  REGRESSED after v1.3
  ▸ SIFT-3   user asks for refund, agent deflects    8.4%   (± 0.3%)   active
  ▸ SIFT-21  context lost after long tool output     4.1%   NEW
  ▸ SIFT-7   billing questions resolved first-try   31.0%   (↑ 2.2%)   active
  ...
  ○ residual pile: 118 traces (5.0%) — discovery will re-run at 8%
```

## How it works

The core technique comes from [Anthropic's Clio](https://www.anthropic.com/research/clio): don't cluster raw traces (too long, too noisy to embed). Instead, have an LLM write one-line summaries along a few fixed dimensions, then embed and cluster *those*. One sentence per facet is what makes the vectors comparable.

sift adds the parts that make it a tool instead of a demo:

**1. Classification-first, not clustering-first.**
Clustering only runs at bootstrap and on the residual pile. After discovery, themes live in a persistent registry and every new trace is *assigned* to an existing theme by nearest-centroid. This solves the two problems that kill every clustering dashboard: labels that rename themselves weekly, and re-cluster costs that grow with your history. Assignment is one embedding + one cosine comparison. ~100x cheaper at steady state.

**2. Themes have identity and lifecycle.**
A theme gets a stable ID (`SIFT-14`) and a state machine: `new → active → regressed / resolved / muted`. Like a Sentry issue, not like a chart. That identity is what makes tracking, alerting, and accountability possible.

**3. Deltas, not snapshots.**
The actionable question is never "what are my themes." It's "what changed since Tuesday's deploy." sift diffs theme distributions across time windows and versions, and flags regressions.

**4. Close the loop into evals.**
`sift export SIFT-14 --format mastra-scorer` turns a failure theme into eval cases seeded from the real traces in that cluster. Discovery → known failure → regression test → resolved. That loop is the product; the clusters are just the intake. It also answers "are these themes real": a theme is validated when fixing it moves a metric.

**5. OTel-native, framework-agnostic.**
Consumes [GenAI semantic convention](https://opentelemetry.io/docs/specs/semconv/gen-ai/) spans from anywhere: Mastra storage, Langfuse export, Phoenix, OpenLIT, raw OTLP. Not locked to any framework's cloud.

**6. Configurable facets.**
Chat agents need `goal / outcome / behavior / sentiment`. Batch pipelines have no sentiment. Coding agents need `files-touched / test-outcome`. Facets are per-agent-type config with presets, not a fixed schema.

**7. Local-first.**
Single SQLite file, embeddings can run locally, summaries can point at any OpenAI-compatible endpoint including your own. Traces are the most PII-dense artifact your company produces. They shouldn't need to leave your infra to be understood.

## Quickstart

```bash
npm install -g @siftlabs/sift        # (placeholder scope)

# see it work first — no API key needed
export SIFT_LLM_PROVIDER=fake SIFT_EMBED_PROVIDER=hash
sift demo --out ./traces.jsonl       # synthetic traffic with planted failures
sift analyze --otlp ./traces.jsonl   # ingest → summarize → embed → discover
sift delta --facet behavior          # what changed between the two releases
```

Against your own traces, point the summarizer at a real model:

```bash
export SIFT_LLM_API_KEY=...          # any Anthropic or OpenAI-compatible endpoint
export SIFT_EMBED_API_KEY=...

sift ingest --otlp ./traces.jsonl    # OTLP GenAI spans as JSON lines
sift summarize --preset chat         # 1 LLM call per trace, resumable
sift bootstrap                       # discover themes
sift assign                          # steady state: cheap, incremental

sift report --format md > report.md
sift delta --from v1.2 --to v1.3 --facet behavior
sift export SIFT-14 --format mastra-scorer --out scorers/retry.ts

sift show SIFT-14                    # exemplar traces for one theme
sift resolve SIFT-14 --note "fixed in v1.4"
```

`sift help` lists everything. Every stage is resumable: `summarize` only touches
traces missing a facet, `assign` only touches summaries without an assignment,
so an interrupted run never pays twice.

## Architecture

```
 OTLP / Mastra / Langfuse / Phoenix
            │
            ▼
   ┌─────────────────┐
   │  ingest          │  normalize to a common Trace shape
   └────────┬────────┘
            ▼
   ┌─────────────────┐
   │  facets          │  1 LLM call/trace → one line per facet
   └────────┬────────┘
            ▼
   ┌─────────────────┐
   │  embed           │  facet summaries → vectors
   └────────┬────────┘
            ▼
   ┌───────────────────────────────────────┐
   │  registry                              │
   │   assign → nearest centroid (cheap)    │
   │   residuals → threshold → re-discover  │
   │   themes: stable IDs + lifecycle       │
   └────────┬──────────────────────────────┘
            ▼
   report · delta · alert · eval-export
```

## Status

v0, and honest about it. The whole loop works end to end — ingest, facet
summaries, embeddings, discovery, the theme registry with lifecycle, deltas,
and eval export — behind a CLI, with no runtime dependencies and a test suite
that runs entirely offline.

The end-to-end test is the claim in miniature: it plants a failure mode in
synthetic traffic, hands sift only the spans, and checks that sift isolates it
(>95% purity, >90% recall against ground truth it never sees), ranks it at the
top of the release delta, and reports `resolved → regressed` when the behavior
comes back.

**Not there yet:** no UI, no Sankey view, no Mastra-storage or Langfuse-API
readers (JSONL OTLP only), no OTLP/HTTP receiver, no alerting, and no `--since`
time filtering on the CLI. Discovery is brute-force cosine, which is fine into
the tens of thousands of traces and will want `sqlite-vec` past that.

**A caveat about the offline mode:** `SIFT_LLM_PROVIDER=fake` uses rule-based
summaries, not a model. It is real enough to demo and to test the machinery
against, but it echoes phrasing rather than abstracting it, so the `goal` facet
fragments into one theme per question wording. A real summarizer is what makes
that facet useful.

See [docs/OVERVIEW.md](docs/OVERVIEW.md) for the design, [docs/ROADMAP.md](docs/ROADMAP.md)
for what was built in what order, and [docs/TESTING.md](docs/TESTING.md) for how
to run the suite.

## Development

```bash
npm install
npm run check      # typecheck + full test suite
npm test
npm run build
```

Node ≥ 22.18 runs the TypeScript sources directly via type stripping, so there
is no build step for development and no test framework to install.

## Prior art

- [Clio](https://arxiv.org/abs/2412.13678) (Anthropic) — the technique. sift is "Clio over OTel spans" with stable grouping.
- [Mastra Trace Intelligence](https://mastra.ai) — the first productization for agent traces (cloud-only, fixed facets, snapshot clustering). sift exists because the category deserves an open, incremental, eval-connected version.
- [BERTopic](https://github.com/MaartenGr/BERTopic) — the canonical embed → cluster → label pipeline in Python.
- [Sentry](https://sentry.io) — the grouping-with-lifecycle model this steals its soul from.

## License

Apache-2.0
