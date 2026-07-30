import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Pseudonymizer, REDACTION_RULES, luhnValid } from "../src/privacy/redact.ts";
import { RedactingSummarizer } from "../src/privacy/gate.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { AnthropicSummarizer } from "../src/facets/summarize.ts";
import type { FacetDef, Trace } from "../src/types.ts";

const FACETS: FacetDef[] = [{ name: "goal", instruction: "what the user wanted" }];

const trace = (text: string): Trace => ({
  id: "t1",
  agentId: "support-bot",
  startedAt: "2026-07-01T00:00:00.000Z",
  text,
  meta: {},
});

describe("what gets caught", () => {
  const gate = new Pseudonymizer();
  const redact = (text: string) => gate.redact(text).text;

  test("email addresses", () => {
    const out = redact("input: contact me at jane.doe+support@example.co.uk please");
    assert.ok(!out.includes("jane.doe"), out);
    assert.ok(!out.includes("example.co.uk"), out);
    assert.match(out, /EMAIL/);
  });

  test("phone numbers in several shapes", () => {
    for (const phone of ["+1 (555) 234-5678", "555-234-5678", "+44 20 7946 0958"]) {
      const out = redact(`call ${phone} tomorrow`);
      assert.match(out, /PHONE/, `missed ${phone}`);
      assert.ok(!out.includes("5678") || !out.includes("0958"), `leaked digits from ${phone}: ${out}`);
    }
  });

  test("credit card numbers, but only real ones", () => {
    // 4111111111111111 is the canonical Luhn-valid test number.
    assert.match(redact("card 4111111111111111 declined"), /CARD/);
    // An order number of the same length must survive: redacting real data is
    // the job, redacting everything numeric makes traces unreadable.
    const orderish = "order 1234567890123456 shipped";
    assert.ok(!redact(orderish).includes("CARD"), redact(orderish));
  });

  test("a token never swallows the whitespace around it", () => {
    // "<CARD_1>was charged" reads as a different sentence than the original.
    assert.equal(
      redact("my card 4111 1111 1111 1111 was charged"),
      "my card <CARD_1> was charged",
    );
    assert.match(redact("write to a@example.com about it"), /<EMAIL_1> about it/);
  });

  test("IP addresses", () => {
    assert.match(redact("from 192.168.14.201"), /IP/);
    assert.match(redact("from 2001:0db8:85a3:0000:0000:8a2e:0370:7334"), /IP/);
  });

  test("api keys and bearer tokens", () => {
    assert.match(redact("Authorization: Bearer sk-ant-api03-AbCdEf1234567890xyzQ"), /TOKEN|SECRET/);
    assert.ok(!redact("key sk-proj-9f8e7d6c5b4a3f2e1d0c9b8a7").includes("9f8e7d6c"));
  });

  test("uuids, which are usually account or session identifiers", () => {
    assert.match(redact("account 3f2504e0-4f89-11d3-9a0c-0305e82c3301"), /UUID/);
  });

  test("query strings, which is where tokens hide", () => {
    const out = redact("fetched https://api.example.com/v1/orders?token=abc123&user=jane");
    assert.ok(!out.includes("abc123"), out);
    assert.ok(!out.includes("jane"), out);
    // the path is kept: which endpoint was called is behavioral, not personal
    assert.match(out, /api\.example\.com|URL/);
  });

  test("leaves ordinary prose completely alone", () => {
    const text = "## chat (120ms)\ninput: where is my refund\ntool: search_kb\nERROR: TimeoutError: timed out";
    assert.equal(redact(text), text);
  });

  test("does not mangle the structure the summarizer reads", () => {
    const text = "## execute_tool (30000ms)\ntool: search_kb args: {\"q\":\"policy\"}\nERROR: TimeoutError";
    const out = redact(text);
    assert.match(out, /^## execute_tool \(30000ms\)$/m);
    assert.match(out, /tool: search_kb/);
    assert.match(out, /TimeoutError/);
  });
});

describe("pseudonyms, not just holes", () => {
  test("the same value gets the same token, so the summary stays coherent", () => {
    // "the user emailed, then the agent replied to the same address" is a
    // behavior worth summarizing; blanket masking destroys it.
    const gate = new Pseudonymizer();
    const out = gate.redact("from a@example.com to b@example.com and back to a@example.com").text;
    const tokens = [...out.matchAll(/<EMAIL_[^>]+>/g)].map((m) => m[0]);
    assert.equal(tokens.length, 3);
    assert.equal(tokens[0], tokens[2]);
    assert.notEqual(tokens[0], tokens[1]);
  });

  test("trace scope resets between traces, so nothing links two users", () => {
    const gate = new Pseudonymizer({ scope: "trace" });
    const a = gate.redact("x@example.com");
    const b = gate.redact("completely-different@example.com");
    assert.equal(a.text, b.text, "per-trace numbering must not carry identity across traces");
  });

  test("global scope keeps a value stable across traces when that is asked for", () => {
    const gate = new Pseudonymizer({ scope: "global", salt: "s3cret" });
    const first = gate.redact("x@example.com").text;
    const second = gate.redact("mentioned again: x@example.com").text;
    assert.match(second, new RegExp(first.match(/<EMAIL_[^>]+>/)![0]));
  });

  test("global tokens depend on the salt, so they are not a rainbow table", () => {
    const a = new Pseudonymizer({ scope: "global", salt: "one" }).redact("x@example.com").text;
    const b = new Pseudonymizer({ scope: "global", salt: "two" }).redact("x@example.com").text;
    assert.notEqual(a, b);
  });

  test("mask mode drops the identity entirely", () => {
    const gate = new Pseudonymizer({ mode: "mask" });
    const out = gate.redact("a@example.com and b@example.com").text;
    assert.equal(out, "<EMAIL> and <EMAIL>");
  });

  test("off mode is a true passthrough", () => {
    const text = "a@example.com";
    assert.equal(new Pseudonymizer({ mode: "off" }).redact(text).text, text);
  });

  test("reports what it found, so the gate can be audited", () => {
    const result = new Pseudonymizer().redact("a@example.com called 555-234-5678 twice from 10.0.0.1");
    assert.equal(result.counts.email, 1);
    assert.equal(result.counts.phone, 1);
    assert.equal(result.counts.ip, 1);
    assert.equal(result.total, 3);
  });
});

describe("rule selection", () => {
  test("rules can be narrowed to a chosen set", () => {
    const gate = new Pseudonymizer({ rules: ["email"] });
    const out = gate.redact("a@example.com from 10.0.0.1").text;
    assert.ok(!out.includes("a@example.com"));
    assert.ok(out.includes("10.0.0.1"), "an unselected rule must not fire");
  });

  test("an unknown rule name is rejected rather than silently ignored", () => {
    // Silently dropping a misspelled rule would mean believing PII is being
    // stripped when it is not — the worst possible failure for this component.
    assert.throws(() => new Pseudonymizer({ rules: ["emails"] }), /emails/);
  });

  test("every shipped rule has a name and a label", () => {
    for (const rule of REDACTION_RULES) {
      assert.match(rule.name, /^[a-z][a-z0-9-]*$/);
      assert.match(rule.label, /^[A-Z_]+$/);
    }
  });

  test("rule names are unique", () => {
    const names = REDACTION_RULES.map((r) => r.name);
    assert.equal(new Set(names).size, names.length);
  });
});

describe("luhnValid", () => {
  test("accepts real card numbers and rejects lookalikes", () => {
    assert.equal(luhnValid("4111111111111111"), true);
    assert.equal(luhnValid("5500005555555559"), true);
    assert.equal(luhnValid("1234567890123456"), false);
    assert.equal(luhnValid("0000000000000000"), true); // degenerate but valid
  });
});

describe("robustness", () => {
  const gate = new Pseudonymizer();

  test("empty and huge inputs are fine", () => {
    assert.equal(gate.redact("").text, "");
    const big = `${"filler ".repeat(50_000)}a@example.com`;
    assert.ok(!gate.redact(big).text.includes("a@example.com"));
  });

  test("overlapping candidates do not corrupt each other", () => {
    // An email inside a URL query string: whichever rule wins, no fragment of
    // the address may survive.
    const out = gate.redact("https://x.com/a?email=jane@example.com&t=1").text;
    assert.ok(!out.includes("jane@example.com"), out);
    assert.ok(!out.includes("jane"), out);
  });

  test("a redacted string is stable under a second pass", () => {
    const once = gate.redact("mail a@example.com").text;
    assert.equal(gate.redact(once).text, once, "tokens must not themselves look like PII");
  });
});

describe("the gate in front of the summarizer", () => {
  function capturingFetch() {
    const bodies: string[] = [];
    const impl = (async (_url: string | URL, init: RequestInit = {}) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ content: [{ type: "text", text: '{"goal":"wants a refund"}' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { impl, bodies };
  }

  test("no raw identifier ever reaches the model", async () => {
    const { impl, bodies } = capturingFetch();
    const inner = new AnthropicSummarizer(DEFAULT_CONFIG.llm, { fetchImpl: impl });
    const guarded = new RedactingSummarizer(inner, new Pseudonymizer());

    await guarded.summarize(
      trace("input: I am jane.doe@example.com, card 4111111111111111, phone 555-234-5678"),
      FACETS,
    );

    const sent = bodies[0]!;
    for (const secret of ["jane.doe@example.com", "4111111111111111", "555-234-5678"]) {
      assert.ok(!sent.includes(secret), `"${secret}" reached the model`);
    }
    assert.match(sent, /EMAIL/);
  });

  test("the summaries still come back attached to the right trace", async () => {
    const { impl } = capturingFetch();
    const guarded = new RedactingSummarizer(
      new AnthropicSummarizer(DEFAULT_CONFIG.llm, { fetchImpl: impl }),
      new Pseudonymizer(),
    );
    const out = await guarded.summarize(trace("input: hello from a@example.com"), FACETS);
    assert.equal(out[0]!.traceId, "t1");
    assert.equal(out[0]!.summary, "wants a refund");
  });

  test("the stored trace is untouched — redaction guards the LLM, not the archive", async () => {
    // Drill-down and eval export need the real trace. The gate exists so the
    // third party never sees it, not to destroy local evidence.
    const { impl } = capturingFetch();
    const original = trace("input: hello from a@example.com");
    const guarded = new RedactingSummarizer(
      new AnthropicSummarizer(DEFAULT_CONFIG.llm, { fetchImpl: impl }),
      new Pseudonymizer(),
    );
    await guarded.summarize(original, FACETS);
    assert.match(original.text, /a@example\.com/);
  });

  test("each trace is redacted independently under trace scope", async () => {
    const { impl, bodies } = capturingFetch();
    const guarded = new RedactingSummarizer(
      new AnthropicSummarizer(DEFAULT_CONFIG.llm, { fetchImpl: impl }),
      new Pseudonymizer({ scope: "trace" }),
    );
    await guarded.summarize(trace("a@example.com"), FACETS);
    await guarded.summarize({ ...trace("zzz@elsewhere.org"), id: "t2" }, FACETS);

    const tokenOf = (body: string) => body.match(/EMAIL_[^>\\"]+/)![0];
    assert.equal(tokenOf(bodies[0]!), tokenOf(bodies[1]!), "two different users must not be distinguishable");
  });

  test("counts redactions so a run can report what it stripped", async () => {
    const { impl } = capturingFetch();
    const guarded = new RedactingSummarizer(
      new AnthropicSummarizer(DEFAULT_CONFIG.llm, { fetchImpl: impl }),
      new Pseudonymizer(),
    );
    await guarded.summarize(trace("a@example.com and b@example.com"), FACETS);
    assert.equal(guarded.stats.total, 2);
    assert.equal(guarded.stats.byRule.email, 2);
    assert.equal(guarded.stats.tracesProcessed, 1);
  });
});
