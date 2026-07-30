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

# point it at traces
sift ingest --otlp ./traces.jsonl              # OTLP JSON lines
sift ingest --mastra ./mastra.db               # Mastra libsql storage

# bootstrap: summarize → embed → discover themes
sift bootstrap --agent support-bot --preset chat

# steady state: assign new traces to existing themes (cheap, incremental)
sift assign --since 24h

# read the results
sift report --format md > report.md
sift delta --from v1.2 --to v1.3
sift export SIFT-14 --format mastra-scorer
```

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

Early. The pipeline runs end to end; the registry and delta logic are the parts under active work. See [docs/OVERVIEW.md](docs/OVERVIEW.md) for the full design and roadmap.

## Prior art

- [Clio](https://arxiv.org/abs/2412.13678) (Anthropic) — the technique. sift is "Clio over OTel spans" with stable grouping.
- [Mastra Trace Intelligence](https://mastra.ai) — the first productization for agent traces (cloud-only, fixed facets, snapshot clustering). sift exists because the category deserves an open, incremental, eval-connected version.
- [BERTopic](https://github.com/MaartenGr/BERTopic) — the canonical embed → cluster → label pipeline in Python.
- [Sentry](https://sentry.io) — the grouping-with-lifecycle model this steals its soul from.

## License

Apache-2.0
