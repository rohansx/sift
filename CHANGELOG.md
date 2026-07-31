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
- **CLI.** `help`, `demo`, `doctor`, `ingest`, `serve`, `summarize`, `analyze`,
  `bootstrap`, `assign`, `report`, `delta`, `themes`, `show`, `resolve`,
  `mute`, `reopen`, `relabel`, `check`, `alert`, `privacy`, `export`,
  `version`. Every stage is resumable, so an interrupted run
  never pays for the same trace twice.
- **Cost control on the stage that costs money.** `summarize` does 1000 traces
  per pass and prints what is left; `analyze` pages until nothing is pending
  and logs the total before spending anything. Reports and `sift check` carry
  `uncoveredTraces` and refuse to vouch for a build they have only partly seen
  (`--allow-partial` opts out).
- **`sift doctor`.** A preflight for the hosted path: it restates the effective
  config, catches a provider/base-URL/model combination that cannot work (
  `SIFT_LLM_PROVIDER=openai` alone leaves the Anthropic base URL in place and
  POSTs an OpenAI body at it), reports each key by source and length and never
  by value, warns when the privacy gate is off against a hosted model, then
  spends exactly one summarizer call and one embedding call on synthetic text to
  prove auth, the model id, JSON parsing and the embedding width. `--no-probe`
  makes it zero calls. It ends with a cost estimate for the traces actually
  pending in the database, sharing its predicate with the count `sift summarize`
  prints, listing every assumption behind the number, and printing tokens with
  no dollar figure at all for a model it has no price on file for.
- **Hosted-path hardening**, each one a failure that only shows up on trace 900:
  `Retry-After` is honoured (seconds or HTTP-date, clamped to 120s) instead of
  3.5s of backoff against a provider asking for 60; every request carries a
  deadline, so a black-hole connection can no longer hang a run forever;
  `parseFacetJson` survives a reasoning model's scratchpad by stripping
  `<think>` blocks and scanning balanced-brace candidates rather than slicing
  from the first `{` to the last `}`; `max_tokens` scales with facet count and a
  truncated reply is reported as truncation rather than as a confusing parse
  error on every trace forever; the one non-permanent OpenAI 400 — the
  `max_completion_tokens` rename — is retried once with the renamed field; and
  error bodies are truncated to 400 chars before they become a megabyte of proxy
  HTML stored once per failed trace.
- **[docs/COST.md](docs/COST.md).** The token math read off the code, a worked
  table from 1k to 100k traces, why local embeddings save privacy rather than
  money, and the ollama/llama.cpp/TEI recipe that runs the entire hosted path
  locally for nothing.
- **Key-gated live tests.** `test/live.test.ts` is the only file in the suite
  that touches a network and is skipped, visibly and with its reason, unless
  `SIFT_LLM_API_KEY` or `SIFT_LLM_BASE_URL` is set. It costs under a cent to run
  and prints the measured intra/inter embedding cosines that
  `REAL_EMBEDDING_GEOMETRY` currently guesses at.
- **`npm run bench`.** Wall time and peak RSS for discovery and assignment by
  dataset size. The numbers it produced are in
  [docs/ROADMAP.md](docs/ROADMAP.md#measured-limits).
- Zero runtime dependencies. Node ≥ 22.18 runs the TypeScript sources directly
  via type stripping, so there is no build step for development and no test
  framework to install. The suite runs entirely offline.

### Changed

- **A missing API key now fails at startup on the four commands that call a
  model** (`summarize`, `analyze`, `bootstrap`, `assign`) instead of once per
  trace. Previously sift sent an empty key, took a non-retryable 401 on every
  trace in the pass, and reported "1000 traces failed" where one sentence would
  have done. `report`, `themes`, `show`, `delta`, `check`, `export` and `doctor`
  are unaffected — they never call a model. This is a behaviour change for
  anyone running the paid commands with a hosted provider and no key: it used to
  produce a thousand failures, and now it produces an error.

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
- **The hosted path has never been run against a live API.** It is implemented,
  and it is unit-tested against stubbed responses carrying real API error
  envelopes — but every claim about Anthropic's and OpenAI's behaviour here
  (error shapes, `Retry-After`, the `max_completion_tokens` rename) is reasoning
  from published API shapes, not from a run. `sift doctor` and
  `test/live.test.ts` are how a reader verifies it themselves in one command;
  ollama makes that free ([docs/COST.md](docs/COST.md)). The price table is
  transcribed by hand and stamped with a date for the same reason.
- No UI, no Sankey view, no Mastra-storage or Langfuse-API readers. OTLP
  ingestion is JSON only, and ids arrive as sent — an exporter that base64s
  them instead of hex-encoding gives you ids that will not match your other
  tooling. Redaction covers structured identifiers; names and free-text
  personal detail need NER, not regexes.
