# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — unreleased

Nothing has been published to npm. `@siftlabs/sift` is a placeholder scope and
the first publish is blocked on decisions that belong to a human — see
[RELEASING.md](RELEASING.md). This entry is what 0.1.0 contains, not an
announcement that it shipped.

### Added

- **Ingestion.** OTLP GenAI JSONL → a normalized `Trace`. `sift serve` is an
  OTLP/HTTP collector target on `POST /v1/traces`: JSON only (a protobuf body
  gets a 415 naming the env var to set, because a decoder is several hundred
  lines of hot-path parsing against a moving spec and would be the first
  argument for a runtime dependency), spans staged in SQLite and assembled 30s
  after a trace goes quiet, loopback bind, optional bearer token.
- **Facet summaries.** One LLM call per trace against any Anthropic or
  OpenAI-compatible endpoint. Facets are per-agent-type config with presets,
  not a fixed schema.
- **Privacy gate.** Pseudonymization in front of the summarizer, on by default:
  emails, phone numbers, Luhn-valid cards, IPs, API keys, UUIDs, URL query
  strings. Tokens are stable within a trace and reset between traces. Stored
  traces are never modified. `sift privacy` previews the substitutions.
- **Embedding.** Hosted embedding endpoints, plus a local `hash` embedder for
  offline runs.
- **Discovery and the registry.** Agglomerative bootstrap clustering, then
  nearest-centroid assignment for everything after it. Themes carry stable
  `SIFT-n` ids and a `new → active → regressed / resolved / muted` lifecycle,
  scoped per agent. Residuals accumulate against a threshold that re-triggers
  discovery.
- **Deltas.** Share diffs across windows and versions, with severity ranking.
- **Reports.** Terminal, markdown and JSON renderers for the issues list and
  the delta.
- **CI gate and alerting.** `sift check --fail-on regression` exits 1;
  a regression means Sentry's regression — a `resolved` theme picking traffic
  back up — so the gate stays quiet until someone has claimed a fix. `sift
  alert --webhook` fires once per theme per window so an hourly cron cannot
  page twenty-four times for one regression.
- **Eval export.** `sift export SIFT-n --format mastra-scorer` turns a theme
  into eval cases seeded from the real traces in it.
- **Storage.** One SQLite file through `node:sqlite`, schema migrations to v3.
- **CLI.** `help`, `demo`, `ingest`, `serve`, `summarize`, `analyze`,
  `bootstrap`, `assign`, `report`, `delta`, `themes`, `show`, `resolve`,
  `mute`, `reopen`, `relabel`, `check`, `alert`, `privacy`, `export`,
  `version`. Every stage is resumable, so an interrupted run
  never pays for the same trace twice.
- **Cost control on the stage that costs money.** `summarize` does 1000 traces
  per pass and prints what is left; `analyze` pages until nothing is pending
  and logs the total before spending anything. Reports and `sift check` carry
  `uncoveredTraces` and refuse to vouch for a build they have only partly seen
  (`--allow-partial` opts out).
- **`npm run bench`.** Wall time and peak RSS for discovery and assignment by
  dataset size. The numbers it produced are in
  [docs/ROADMAP.md](docs/ROADMAP.md#measured-limits).
- Zero runtime dependencies. Node ≥ 22.18 runs the TypeScript sources directly
  via type stripping, so there is no build step for development and no test
  framework to install. The suite runs entirely offline.

### Known limits at 0.1.0

Stated here so a release note cannot be read as a claim the README does not
make. Detail and measurements in the README's *Status* section.

- Discovery is O(n²·d) time and 8n² bytes: budget ~10,000 traces per facet per
  pass, with the wall in the low twenty-thousands where the distance matrix
  stops fitting in a machine. Assignment — the path that runs every day — is
  linear and unbothered to 50,000.
- The offline `fake` summarizer echoes phrasing rather than abstracting it, and
  the local `hash` embedder scores two phrasings of one behavior no closer than
  two unrelated sentences. Together they produce one theme per phrasing under
  paraphrase (21% recall on a planted failure), and no health metric notices.
  Hosted providers are the real default for a reason.
- The end-to-end purity number is measured against a summarizer that emits
  byte-identical lines, so it measures the pipeline rather than the clustering.
  `test/paraphrase.test.ts` exists to say so.
- No UI, no Sankey view, no Mastra-storage or Langfuse-API readers. OTLP
  ingestion is JSON only, and ids arrive as sent — an exporter that base64s
  them instead of hex-encoding gives you ids that will not match your other
  tooling. Redaction covers structured identifiers; names and free-text
  personal detail need NER, not regexes.
