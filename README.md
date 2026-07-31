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

**4. It can block a deploy.**
Evals are a build step because they catch failures you already knew about. Discovery catches the ones you didn't — and until it can also fail a build, it stays something someone has to remember to go and look at.

A regression is a theme you had marked `resolved` picking traffic back up —
Sentry's meaning, not "went up". So the gate stays quiet until someone has
actually claimed a fix:

```
$ sift resolve SIFT-20 --note "fixed in v1.3"
$ sift check --fail-on regression

  ✗ sift check failed — 1 finding

    REGRESSED  SIFT-20  retry loop: called search_kb repeatedly after timeouts
      2.0% → 15.0% between v1.2 and v1.3
      sift show SIFT-20

$ echo $?
1
```

Regressions only, by default: gating on anything *new* would turn every release red and teach everyone to ignore the gate. `sift alert --webhook $URL` pushes the same events to Slack or a pager, once per theme per window — an hourly cron must not page twenty-four times for one regression.

**5. Close the loop into evals.**
`sift export SIFT-14 --format mastra-scorer` turns a failure theme into eval cases seeded from the real traces in that cluster. Discovery → known failure → regression test → resolved. That loop is the product; the clusters are just the intake. It also answers "are these themes real": a theme is validated when fixing it moves a metric.

**6. OTel-native, framework-agnostic.**
Consumes [GenAI semantic convention](https://opentelemetry.io/docs/specs/semconv/gen-ai/) spans from anywhere: Mastra storage, Langfuse export, Phoenix, OpenLIT, raw OTLP. Not locked to any framework's cloud.

**7. Configurable facets.**
Chat agents need `goal / outcome / behavior / sentiment`. Batch pipelines have no sentiment. Coding agents need `files-touched / test-outcome`. Facets are per-agent-type config with presets, not a fixed schema.

**8. Local-first, with a privacy gate in front of the model.**
Single SQLite file, embeddings can run locally, summaries can point at any OpenAI-compatible endpoint including your own. Traces are the most PII-dense artifact your company produces. They shouldn't need to leave your infra to be understood.

When summaries *do* go to a hosted model, a pseudonymization pass rewrites identifiers first — emails, phone numbers, Luhn-valid card numbers, IPs, API keys, UUIDs, URL query strings. It's on by default, and you can see exactly what it does before trusting it:

```
$ sift privacy --otlp ./traces.jsonl

  privacy gate: pseudonymize (scope: trace)
  7 values in 1 of 1 traces would be replaced before the LLM sees them

  - input: Hi, I'm jane.doe@acme.co and my card 4111111111111111 was charged twice.
  + input: Hi, I'm <EMAIL_1> and my card <CARD_1> was charged twice.
```

Tokens are stable *within* a trace, so "the agent replied to a different address than the one that wrote in" survives as a summarizable fact, and reset *between* traces, so two traces from the same person aren't linkable. Your stored traces are never modified — the gate protects the third party, not your own archive.

## Quickstart

```bash
npm install -g @siftlabs/sift        # (placeholder scope)

# see it work first — no API key needed
export SIFT_LLM_PROVIDER=fake SIFT_EMBED_PROVIDER=hash
sift demo --out ./traces.jsonl       # synthetic traffic with planted failures
sift analyze --otlp ./traces.jsonl   # ingest → summarize → embed → discover
sift delta --facet behavior          # what changed between the two releases
```

To send traces straight from a running agent instead of exporting a file, sift
is an OTLP/HTTP collector target:

```bash
sift serve                                            # 127.0.0.1:4318, receive-only

export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json          # not optional — see below
```

`serve` only receives: spans are staged in SQLite, assembled into a trace 30s
after that trace's last span (a `BatchSpanProcessor` flushes one conversation
across several POSTs, and half a trace would summarize into the wrong theme),
and left for `sift analyze` on a cron to summarize. Keeping paid model calls out
of the ingest path is what makes both backpressure and the bill predictable.

The protocol line is the one thing you have to change: sift speaks OTLP/**JSON**
only, and the SDK default is protobuf. A protobuf body gets a 415 that says so
rather than a silent drop, because a decoder is several hundred lines of
hot-path parsing against a moving spec and sift ships no runtime dependencies.
`--token` (or `SIFT_RECEIVER_TOKEN`) adds a bearer check; the bind is loopback
by default because an unauthenticated trace sink on `0.0.0.0` is an exfil
surface.

Against your own traces, point the summarizer at a real model:

```bash
export SIFT_LLM_API_KEY=...          # any Anthropic or OpenAI-compatible endpoint
export SIFT_EMBED_API_KEY=...

sift ingest --otlp ./traces.jsonl    # OTLP GenAI spans as JSON lines
sift summarize --preset chat         # 1 LLM call per trace, 1000 per pass
sift bootstrap                       # discover themes
sift assign                          # steady state: cheap, incremental

sift report --format md > report.md
sift delta --from v1.2 --to v1.3 --facet behavior
sift export SIFT-14 --format mastra-scorer --out scorers/retry.ts

sift show SIFT-14                    # exemplar traces for one theme
sift resolve SIFT-14 --note "fixed in v1.4"

sift check --fail-on regression      # exits 1 in CI if something regressed
sift alert --webhook $SLACK_URL      # notify once per theme per window
sift privacy --otlp ./traces.jsonl   # preview what the gate strips
```

`sift help` lists everything. Every stage is resumable: `summarize` only touches
traces missing a facet, `assign` only touches summaries without an assignment,
so an interrupted run never pays twice.

Summarizing is the stage that costs money — one model call per trace — so the
two commands that do it are explicit about how much they will spend:

- `sift summarize` does 1000 traces per pass and prints how many are left, so a
  cron keeps a predictable bill.
- `sift analyze` summarizes everything pending, because "ingest → issues list"
  is a claim about the whole file. Cap it with `--limit <n>` (or narrow it with
  `--since 7d`) when you only want a taste of a large history.
- `sift report` warns when traces are in no window yet, and `sift check` exits
  non-zero rather than green-lighting a build it has only partly seen. Pass
  `--allow-partial` if you sample deliberately.

## Architecture

```
 OTLP / Mastra / Langfuse / Phoenix
   JSONL file, or POST /v1/traces
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
comes back. That purity number comes with a caveat, and `test/paraphrase.test.ts`
exists to state it: the offline rule-based summarizer emits a byte-identical
line for every instance of the planted failure, so identical strings are being
grouped, and the number measures the pipeline rather than the clustering. Rerun
with a summarizer that paraphrases and the result depends entirely on the
embedder — one theme per behavior at 100% recall given embeddings of the quality
a hosted model is assumed to have, and one theme per *phrasing* at 21% recall
with the local hash embedder.

**Not there yet:** no UI, no Sankey view, and no Mastra-storage or Langfuse-API
readers. The OTLP/HTTP receiver speaks JSON only — an exporter left on the
default `http/protobuf` gets a 415 telling it to switch, not a decoder. Ids
arrive as sent, so an exporter that base64s them instead of hex-encoding them
(the spec says hex for JSON) gives you trace ids that will not match your other
tooling. Discovery clustering is the scale ceiling, and it is now measured
rather than guessed (`npm run bench`, numbers and method in
[docs/ROADMAP.md](docs/ROADMAP.md#measured-limits)): one bootstrap pass over
1536-dim vectors takes 2.0s at 1,000 traces, 98s at 5,000, 271s at 10,000 and
894s at 20,000, and at 50,000 does not start — average linkage needs every
pairwise distance, and that matrix is 18.6 GiB. Budget ~10,000 traces per facet
per discovery pass, with the wall in the low twenty-thousands. This README used
to say brute-force cosine was "fine into the tens of thousands", which had the
magnitude roughly right and the verb wrong: tens of thousands is where it stops,
not where it is still comfortable. `sqlite-vec` is not the fix — an ANN index
answers "nearest k", and agglomeration needs the whole distance structure.
Assignment, the path that actually runs every day, is linear and unbothered:
50,000 traces against 40 themes in 253s, of which 78% is re-reading centroids
out of SQLite rather than comparing them. Redaction covers structured
identifiers; names and free-text personal detail need NER, not regexes.

**A caveat about the offline mode:** `SIFT_LLM_PROVIDER=fake` uses rule-based
summaries, not a model. It is real enough to demo and to test the machinery
against, but it echoes phrasing rather than abstracting it, so the `goal` facet
fragments into one theme per question wording. A real summarizer is what makes
that facet useful. The local `hash` embedder has the matching limitation, and it
is measured: it groups by shared vocabulary, and two ways of saying the same
thing score no closer than two unrelated sentences (0.111 against 0.099, where
merging needs 0.65). So under real paraphrased summaries it produces one theme
per phrasing — 30 themes for five behaviors, 21% recall on the planted failure.
It fragments rather than mixing, which is the right direction to fail in, and
none of sift's health metrics notice. Hosted embeddings are the real default for
a reason.

See [docs/OVERVIEW.md](docs/OVERVIEW.md) for the design, [docs/ROADMAP.md](docs/ROADMAP.md)
for what was built in what order, and [docs/TESTING.md](docs/TESTING.md) for how
to run the suite.

## Development

```bash
npm install
npm run check      # typecheck + full test suite
npm test
npm run build
npm run bench      # wall time + peak RSS for discovery and assignment, by size
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
