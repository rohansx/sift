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
| P15 | `src/alert/` | `sift check` CI gate and webhook alerting | ✅ |
| P16 | `src/ingest/receiver.ts` | OTLP/HTTP receiver — `sift serve` as a collector target | ✅ |

## Phase notes

**P7 is the differentiator.** Everything before it is table stakes that any
Clio reimplementation has. The registry is what makes a theme an *issue*:
`SIFT-14` means the same thing next week as it does today, which is the
precondition for deltas, alerting, and eval export.

**P16 is JSON-only on purpose.** A protobuf decoder is several hundred lines of
hot-path parsing to maintain forever against a spec that moves, and it would be
the first thing in sift arguing for a runtime dependency. The cost is pushed to
the user as one env var (`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`) and a 415 that
names it, since the SDK default is protobuf and nearly every first run hits that
path. The harder problem was not the encoding: a receiver sees BatchSpanProcessor
flushes, so one trace arrives across several POSTs, which is why spans are staged
and only assembled once the trace has gone quiet.

**Order matters for one reason:** the registry needs a store, vectors, and a
clustering primitive underneath it, and the delta engine needs the registry to
have produced assignments with window tags. Everything else could be built in
any order.

## Measured limits

`npm run bench` ([src/examples/benchmark.ts](../src/examples/benchmark.ts))
times discovery and assignment across dataset sizes, each case in its own
process so peak RSS is attributable.

Getting this measurement right takes one specific care: the corpus has to have
realistic *summary* cardinality, not just a lot of traces. `KeywordSummarizer`
emits a byte-identical line for every instance of a behavior, so the leader
pre-pass inside `discoverClusters` collapses any n to a handful of leaders and
discovery looks linear at every size — a property of the fake, not of the
algorithm. The benchmark instead gives every trace its own vector via
`ConceptEmbedder` at the geometry the offline harness already assumes a real
model has (0.80 cosine between paraphrases of one behavior, 0.45 between
different ones), which is what a real summarizer produces.

Node 26.3.1, linux/x64, 23 GB RAM, 1536 dimensions (the shipped default), 40
planted behaviors. The 20,000 discovery case needs `--timeout 2400`. The 50,000
one was run under `ulimit -v 12g`: the matrix is a *lazy* allocation, so without
a cap the machine swaps for an hour instead of reporting anything, and the cap
turns that into the immediate failure it deserves to be.

| phase | traces | wall | peak RSS | result |
|---|---:|---:|---:|---|
| discover | 500 | 0.48s | 114 MB | 40 themes, 0 noise, exact on 500 |
| discover | 1000 | 1.97s | 143 MB | 40 themes, 0 noise, exact on 1000 |
| discover | 2000 | 15.75s | 227 MB | 40 themes, 0 noise, 1998 leaders |
| discover | 5000 | 98.36s | 461 MB | 40 themes, 0 noise, 4964 leaders |
| discover | 10000 | 270.68s | 950 MB | 40 themes, 0 noise, exact on 10000 |
| discover | 20000 | 894.20s | 3349 MB | 40 themes, 0 noise, exact on 20000 |
| discover | 50000 | — | — | **RangeError: Array buffer allocation failed** |
| assign | 500 | 2.40s | 197 MB | 500 assigned, 0 residual |
| assign | 1000 | 5.01s | 228 MB | 1000 assigned, 0 residual |
| assign | 2000 | 9.51s | 298 MB | 2000 assigned, 0 residual |
| assign | 5000 | 23.18s | 477 MB | 5000 assigned, 0 residual |
| assign | 10000 | 47.04s | 797 MB | 10000 assigned, 0 residual |
| assign | 20000 | 100.45s | 1434 MB | 20000 assigned, 0 residual |
| assign | 50000 | 253.01s | 3290 MB | 50000 assigned, 0 residual |

Clustering quality is constant across the whole range — 40 planted behaviors,
40 themes, zero noise, at every size that finished. Only the cost moves.

**Discovery is O(n²·d) in time and 8n² bytes in memory**, and the ceiling is
~10,000 traces per facet per pass. Average-linkage agglomeration materializes
one n × n `Float64Array` of pairwise distances: 762 MiB at 10,000 points,
2.98 GiB at 20,000, 18.6 GiB at 50,000. So the curve has two regimes and the
second one is a wall, not a slope — 10,000 is four and a half minutes and fits
in a gigabyte, 20,000 is fifteen minutes and 3.3 GB, and somewhere in the low
twenty-thousands the matrix stops fitting in a machine at all. 50,000 fails on
the allocation rather than on patience — though patience would not save it
either, since the quadratic puts it near 83 minutes given the memory.

**Assignment is O(n·T·d) for n summaries against T themes — linear in n**, and
it is not the problem. 100× the traces (500 → 50,000) costs 105× the time, and
memory grows with the summary pool rather than its square.

Two things the measurement contradicted:

*The leader pre-pass is net-negative on realistic data.* It exists to collapse
near-duplicates before agglomerating, but at 1536 dimensions two summaries of
the same behavior sit ~0.20 cosine apart and the leader radius is half the merge
threshold, 0.175 — so almost nothing collapses. 2,000 points yield 1,998
leaders; 5,000 yield 4,964. It then pays for the leader scan *and* the full
matrix. Forcing `maxDirect` past n to skip it entirely gives byte-identical
results and takes 7.73s instead of 15.44s at n=2,000, and 200.01s instead of
273.37s at n=10,000 (where the pre-pass scans to its 4·`maxDirect` abort and
throws the work away). It is only ever load-bearing when summaries repeat
verbatim — which is what `KeywordSummarizer` does and what a real summarizer
does not.

*Assignment's cost is SQLite, not vector math.* `ThemeRegistry.assign` calls
`store.themesForFacet` once per summary, so every trace re-runs the SQL and
re-`JSON.parse`s every centroid. At 40 themes and 1536 dims that reload is
3.62ms per assignment against 0.14ms for the cosine scan it feeds — 25:1, and
78% of the 4.67ms an end-to-end assignment costs. Hoisting the load out of the
loop is the available speedup here; a faster nearest-neighbour search is not.

Both bind at **bootstrap**, where the residual pile is the entire corpus. Steady
state is unaffected: discovery only ever runs on one window's residuals.

## Cut line

Per OVERVIEW §5, if time runs short: no UI, no Sankey, no Mastra-storage
reader. JSONL OTLP ingestion is enough to demo the whole loop.

## After v0

- OTLP/protobuf, if a decoder can be had without a runtime dependency
- Hoist the centroid load out of the assignment loop — a dozen lines, no
  dependency, and per the measurements above it is 78% of what an assignment
  costs
- Retire or gate the leader pre-pass. On summaries that do not repeat verbatim
  it is a 2× tax at 2k and a 1.4× tax at 10k for byte-identical output. It needs
  a cheaper trigger than "n > maxDirect" — ideally one that samples the actual
  collapse rate before committing to the scan
- A bootstrap path that does not materialize an n × n matrix, if discovery ever
  has to clear ~10k traces per facet. That is an algorithm change, not an index
- Hierarchical themes (needed past ~100 themes)

**Not `sqlite-vec`, not yet.** It was on this list as "once registries outgrow
brute-force cosine", which the measurements above answer the wrong way twice.
The thing that outgrows its budget is discovery, and average-linkage
agglomeration needs the whole distance structure rather than each point's k
nearest neighbours — an ANN index cannot slot in behind it without replacing the
clustering algorithm with a graph-based one. And the path an ANN index *would*
serve, assignment, is linear, comfortable to 50k traces, and spends 25× longer
reloading centroids from SQLite than comparing them: adding an index there
would optimize the 3% while the 78% sits untouched. Both free wins above are
worth more and cost no dependency. Revisit ANN when a single registry carries a
few hundred themes, which changes the T in O(n·T·d) enough to matter.
