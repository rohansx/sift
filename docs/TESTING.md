# Testing

```bash
npm test          # full suite
npm run typecheck # tsc --noEmit
npm run check     # both — the gate for every commit
npm run test:watch
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
  - `HashEmbedder` — deterministic bag-of-tokens vectors. Same text always
    yields the same vector, similar text yields nearby vectors. Real enough to
    exercise clustering and assignment end to end.
  - `ModeEmbedder` — places text near one of N planted vectors, for tests that
    need known cluster structure with controllable overlap.
  - `ScriptedSummarizer` / `KeywordSummarizer` — facet summaries without an LLM.
  - `FakeLabeler` — cluster labels from member summaries.
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
```

## What "done" means for a phase

The phase's tests pass, the whole suite still passes, `tsc --noEmit` is clean,
and the tests would fail if the implementation were reverted. A test that
passes against an empty implementation is not a test.
