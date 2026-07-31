# Cost

sift makes exactly one model call per trace. That is the whole cost model, and
everything below follows from it.

Run `sift doctor` before a large run: it computes all of this against the traces
actually in your database, and it is the only number here that knows anything
about your corpus.

```bash
sift doctor            # config, auth, dimensions, and what the pending traces will cost
sift doctor --no-probe # the same, with zero network calls
```

> **Status.** The arithmetic below is derived from the code and is exercised by
> `test/doctor.test.ts`. The prices are published list prices as of the date in
> `src/doctor/prices.ts`, transcribed by hand. Nothing in this file has been
> verified against a live billing statement. Treat it as an estimate — the tool
> says the same thing in its own output.

## The token math

Per trace, the summarizer prompt is:

- **fixed overhead**: the instructions and the facet list. Measured, not
  guessed — `buildFacetPrompt` with an empty trace:

  | preset | facets | overhead |
  |---|---|---|
  | `chat` | 4 | 733 chars (~210 tokens) |
  | `pipeline` | 4 | 760 chars |
  | `coding` | 4 | 689 chars |
  | `support` | 4 | 666 chars |

- **the trace itself**: `min(trace chars, 24,000)`. `clipTrace` keeps the head
  and the tail and drops the middle, so a 200KB trace costs the same as a 24KB
  one.

Output is roughly 30 tokens per facet line, so ~120 tokens for a four-facet
preset. **The facet count does not change the number of calls** — four facets
cost one call, not four. It only changes the output length.

The estimator converts characters to tokens at **3.5 chars/token**, deliberately
below the usual 4.0 rule of thumb: trace text is JSON, stack traces and code,
which tokenize worse than prose. The estimate should come in high.

## What that costs

For the `chat` preset (4 facets) on `claude-haiku-4-5` at $1/$5 per 1M tokens,
with `text-embedding-3-small` embeddings at $0.02 per 1M:

| traces | avg chars | input tok | output tok | embed tok | total |
|---|---|---|---|---|---|
| 1,000 | 2,000 | 780,858 | 120,000 | 100,000 | $1.38 |
| 1,000 | 6,000 | 1,923,715 | 120,000 | 100,000 | $2.53 |
| 10,000 | 2,000 | 7,808,572 | 1,200,000 | 1,000,000 | $13.83 |
| 10,000 | 6,000 | 19,237,143 | 1,200,000 | 1,000,000 | $25.26 |
| 100,000 | 2,000 | 78,085,715 | 12,000,000 | 10,000,000 | $138.29 |
| 100,000 | 6,000 | 192,371,429 | 12,000,000 | 10,000,000 | $252.57 |

Published prices change and this table does not. `sift doctor` prints the date
its table was written on, and prints tokens with **no dollar figure at all** for
a model it has no price for — a plausible wrong number is worse than an absent
one. Override it with `--price-in` / `--price-out`.

## Embeddings are not the bill

One short string per facet per trace, ~25 tokens each. At 10,000 traces and four
facets that is a million tokens: **two cents**, against roughly fourteen dollars
of summarization.

Which is worth saying plainly: switching to local embeddings saves you almost
nothing in money. It is a privacy decision, not a cost decision. The
summarizer is where both the money and the exposure are.

## Wall clock is the other budget

Calls are sequential. At ~1s per trace, 10,000 traces is about three hours.

That is deliberate. It is also what keeps sift comfortably under a rate limit
without any concurrency control, and every stage is resumable, so the answer to
"this is taking hours" is to kill it and run it again later — not to wait.

## Spending less

- `--limit N` caps a pass. `sift summarize` already stops after 1,000 traces and
  tells you how many are left; `sift analyze` finishes the corpus unless you cap
  it.
- `--since 7d` scopes to recent traces instead of all history.
- **Every stage is resumable.** A killed run never re-pays: `summarize` only
  touches traces missing a facet, `assign` only touches summaries with no
  assignment.
- A cheaper summarizer model. This is one short structured extraction per trace,
  which is the kind of task a small model does well.
- Local embeddings (`SIFT_EMBED_PROVIDER=hash`) are free, but the hash embedder
  is not semantic — it groups text that shares words, not text that means the
  same thing. See docs/TESTING.md.
- A local summarizer, below, is free entirely.

## The zero-cost path: ollama

The whole hosted path is OpenAI-compatible HTTP, so any local server that speaks
it will do. This is also how you verify sift's hosted path without buying
anything:

```bash
ollama serve
ollama pull qwen3:4b
ollama pull nomic-embed-text

export SIFT_LLM_PROVIDER=openai
export SIFT_LLM_BASE_URL=http://127.0.0.1:11434
export SIFT_LLM_MODEL=qwen3:4b
export SIFT_LLM_API_KEY=ollama
export SIFT_EMBED_PROVIDER=openai
export SIFT_EMBED_BASE_URL=http://127.0.0.1:11434
export SIFT_EMBED_MODEL=nomic-embed-text
export SIFT_EMBED_DIMENSIONS=768

sift doctor
npm test          # test/live.test.ts now runs instead of skipping
```

Three things that will bite you, in the order they bite:

1. **No `/v1` on the base URL.** sift appends `/v1/chat/completions` and
   `/v1/embeddings` itself. `http://127.0.0.1:11434/v1` becomes
   `http://127.0.0.1:11434/v1/v1/chat/completions` and 404s.
2. **The dummy key is not optional.** sift always sends an `Authorization`
   header, and the paid commands now refuse to start without a key rather than
   failing once per trace. Any non-empty string works; ollama ignores it.
3. **768 is not the 1536 default.** `SIFT_EMBED_DIMENSIONS=768` is mandatory for
   `nomic-embed-text`, and getting it wrong used to surface only after a page of
   summaries had already been paid for. `sift doctor` now catches it in one call
   and names the variable.

Alternatives, same shape: `docker run -p 8080:80
ghcr.io/huggingface/text-embeddings-inference` for embeddings only, or
`llama-server --port 8080` (llama.cpp) for the summarizer only — point the
matching `SIFT_*_BASE_URL` at it and leave the other one hosted.

> Every claim in this section is read off sift's code and the published shape of
> those servers' APIs. None of it has been run against a live endpoint by the
> author. `test/live.test.ts` is how you check it in one command, and it is the
> only test in the suite that touches a network.
