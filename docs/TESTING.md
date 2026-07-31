# Testing

```bash
npm test          # full suite
npm run typecheck # tsc --noEmit
npm run check     # both — the gate for every commit
npm run test:watch
npm run bench     # scale measurement, not a gate: ~8 min, prints a table
```

## The setup

Tests are TypeScript run directly by Node ≥ 22.18's built-in type stripping and
`node:test`. There is no build step and no test framework:

```
node --test --test-reporter=spec test/
```

Two consequences worth knowing:

1. **Only erasable TypeScript.** No `enum`, no `namespace`, no constructor
   parameter properties (`constructor(private x: T)`). `tsconfig` enforces this
   with `erasableSyntaxOnly`, so `npm run typecheck` catches violations.
2. **Imports carry `.ts` extensions.** Node resolves the real file;
   `rewriteRelativeImportExtensions` turns them into `.js` at build time.

## Rules

**Every test runs offline and deterministically.** No test may touch the
network, and none may depend on wall-clock time or `Math.random` for its
assertions. The suite is the thing that has to stay trustworthy when the LLM in
the loop is not.

- **LLM and embeddings are interfaces.** `Summarizer` and `Embedder` have
  offline implementations in `src/testing/fakes.ts`:
  - `HashEmbedder` — deterministic bag-of-tokens vectors. Text sharing
    vocabulary yields nearby vectors; **paraphrases do not** (measured mean
    cosine 0.111 within a behavior against 0.099 between behaviors, where the
    clusterer needs 0.65 to merge). It exercises the plumbing, not semantic
    grouping.
  - `ModeEmbedder` — places text near one of N planted vectors, for tests that
    need known cluster structure with controllable overlap. Its `noise` is a raw
    per-dimension sigma, so its meaning changes with `dimensions`: at 512 dims
    the default 0.1 gives an intra-cosine of 0.16 and clusters nothing. Existing
    tests use it at 8 dims, where it is fine.
  - `ScriptedSummarizer` / `KeywordSummarizer` — facet summaries without an LLM.
  - `FakeLabeler` — cluster labels from member summaries.
  - `ParaphraseSummarizer` / `ConceptEmbedder` (`src/testing/paraphrase.ts`) —
    the only fixture that asks whether clustering survives lexical variation.
    The summarizer says the same thing a different way every time; the embedder
    is an **oracle** that places a summary near its ground-truth concept at a
    stated geometry (`intraCosine` / `interCosine`). The oracle is not evidence
    that a real embedder is semantic — it cannot be. It makes the claim
    conditional and testable: *given* an embedder with this spread, sift
    recovers one theme per behavior.
- **Randomness is seeded.** `mulberry32` in `src/testing/random.ts`. A failing
  test reproduces exactly.
- **Clocks are injected.** Anything that stamps a timestamp takes a `now()` in
  its options, defaulting to `Date.now`. Lifecycle tests advance time by hand.
- **The store is real.** SQLite tests run against a real database in a temp
  directory (`withTempStore`), not a mock. `node:sqlite` is fast enough that
  this costs nothing and catches schema bugs a mock never would.

## Layout

```
test/
  vectors.test.ts        unit, pure functions
  store.test.ts          real SQLite, temp dir
  ingest-otlp.test.ts    fixture-driven
  providers.test.ts      stubbed fetch, no network
  cluster.test.ts        synthetic vector modes
  registry.test.ts       assignment + lifecycle (the important one)
  delta.test.ts          fixed windows
  report.test.ts         rendering
  export.test.ts         generated eval artifacts
  cli.test.ts            child_process, real DB, offline providers
  e2e.test.ts            the demo: does sift find a planted failure mode?
  paraphrase.test.ts     does it still find it when every trace is worded differently?
```

## What the suite does not prove

`REAL_EMBEDDING_GEOMETRY` in `src/testing/paraphrase.ts` (0.80 intra / 0.45
inter) is an **estimate** for a hosted model over one-line behavior summaries,
not a measurement. Every number `paraphrase.test.ts` reports at that geometry is
conditional on it, and nothing offline can check it — that takes a run against a
real embedder and a real summarizer. Two assumptions are outstanding:

1. that a real summarizer produces one recoverable concept per behavior rather
   than one string per behavior (which would make the whole harness aimed at a
   problem that does not exist), and
2. that real embeddings actually hit that spread.

Until someone measures both and updates the constant, the honest reading is:
sift's clustering is verified *given* an embedder of stated quality, and the
offline `hash` embedder is demonstrably not one.

## What "done" means for a phase

The phase's tests pass, the whole suite still passes, `tsc --noEmit` is clean,
and the tests would fail if the implementation were reverted. A test that
passes against an empty implementation is not a test.
