# Build plan

The design lives in [OVERVIEW.md](./OVERVIEW.md). This is the execution order.

Every phase is test-first: the test file lands with (or before) the module, and
`npm run check` (typecheck + full suite) must be green before the phase is
committed. No phase depends on network access or an API key to be verified —
LLM and embedding providers sit behind interfaces with deterministic offline
fakes (see [TESTING.md](./TESTING.md)).

| Phase | Module | Deliverable | Status |
|---|---|---|---|
| P0 | — | Scaffold, TDD harness, docs, CI | ✅ |
| P1 | `src/types.ts`, `src/config.ts` | Domain types, config loading + validation, facet presets | ✅ |
| P2 | `src/cluster/vectors.ts` | Vector math: cosine, running-mean centroid | ✅ |
| P3 | `src/store/db.ts` | SQLite schema, migrations, query layer | ✅ |
| P4 | `src/ingest/` | OTLP GenAI JSONL → normalized `Trace` | ✅ |
| P5 | `src/facets/`, `src/embed/` | Summarizer + Embedder providers, offline fakes | ✅ |
| P6 | `src/cluster/bootstrap.ts` | Agglomerative discovery clustering | ✅ |
| P7 | `src/registry/` | Assignment, residual pile, stable IDs, lifecycle | ✅ |
| P8 | `src/delta/` | Window-over-window share deltas + severity | ✅ |
| P9 | `src/report/` | Issues-list + delta reports (markdown, terminal, JSON) | ✅ |
| P10 | `src/export/` | Theme → eval cases + scorer | ✅ |
| P11 | `src/pipeline.ts`, `src/cli.ts` | Orchestration and CLI | ✅ |
| P12 | `src/examples/` | Demo trace generator + end-to-end proof | ✅ |
| P13 | `src/privacy/` | Pseudonymization gate in front of the summarizer | ✅ |
| P14 | across | Per-agent registry scoping, `--since` time filtering | ✅ |

## Phase notes

**P7 is the differentiator.** Everything before it is table stakes that any
Clio reimplementation has. The registry is what makes a theme an *issue*:
`SIFT-14` means the same thing next week as it does today, which is the
precondition for deltas, alerting, and eval export.

**Order matters for one reason:** the registry needs a store, vectors, and a
clustering primitive underneath it, and the delta engine needs the registry to
have produced assignments with window tags. Everything else could be built in
any order.

## Cut line

Per OVERVIEW §5, if time runs short: no UI, no Sankey, no Mastra-storage
reader. JSONL OTLP ingestion is enough to demo the whole loop.

## After v0

- OTLP/HTTP receiver so sift can be an OTel collector target
- `sqlite-vec` ANN once registries outgrow brute-force cosine
- Hierarchical themes (needed past ~100 themes)
- Webhook alerting on `new` / `regressed`
