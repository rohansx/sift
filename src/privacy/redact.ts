import { createHash } from "node:crypto";

/**
 * The pseudonymization gate (OVERVIEW.md §3.6, §8).
 *
 * Traces are the most PII-dense artifact a company produces, and this whole
 * technique works by feeding them to a language model. Clio's paper spends half
 * its length on privacy machinery for exactly this reason. This is sift's
 * answer: a pass that rewrites identifiers *before* the summarizer sees a
 * trace, so what leaves the building is already de-identified.
 *
 * Two deliberate design choices:
 *
 * 1. **Pseudonyms, not holes.** Replacing every email with `<EMAIL>` destroys
 *    real behavioral signal — "the agent replied to a different address than
 *    the one that wrote in" is a summarizable fact. Stable per-value tokens
 *    keep that readable while carrying no identity.
 *
 * 2. **Scope defaults to per-trace.** Tokens restart at 1 for every trace, so
 *    two traces from the same person are not linkable through the token. Global
 *    scope (salted, stable across traces) exists because some analyses need it,
 *    but linkability is a real cost and should be opted into.
 *
 * What this does *not* do: names, addresses, and free-text personal detail need
 * NER, not regexes. The summarizer prompt also instructs the model to describe
 * roles rather than identities — the gate is the first layer, not the only one.
 */

export interface RedactionRule {
  /** stable identifier used in config and in counts */
  name: string;
  /** token label, e.g. EMAIL -> <EMAIL_3> */
  label: string;
  pattern: RegExp;
  /** optional second check to suppress false positives */
  validate?: (match: string) => boolean;
  /** rewrite the match before tokenizing; used to keep the useful part of a URL */
  transform?: (match: string, token: string) => string;
}

/** Luhn checksum — distinguishes a card number from an order number of the same shape. */
export function luhnValid(digits: string): boolean {
  const clean = digits.replace(/[^0-9]/g, "");
  if (clean.length < 12 || clean.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = clean.length - 1; i >= 0; i--) {
    let d = clean.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Order matters: earlier rules claim text first, so the most specific patterns
 * come first. A URL containing an email must be handled by the URL rule before
 * the bare-email rule can carve it up and leave the local part behind.
 */
export const REDACTION_RULES: RedactionRule[] = [
  {
    name: "url",
    label: "URL",
    // only URLs carrying a query string: that is where tokens and emails hide
    pattern: /\bhttps?:\/\/[^\s<>"']+\?[^\s<>"']*/gi,
    transform: (match, token) => {
      const cut = match.indexOf("?");
      const base = match.slice(0, cut);
      return `${base}?${token}`;
    },
  },
  {
    name: "email",
    label: "EMAIL",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    name: "uuid",
    label: "UUID",
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  },
  {
    name: "token",
    label: "TOKEN",
    // provider-style API keys and long opaque secrets
    pattern: /\b(?:sk|pk|rk|api|key)[-_][A-Za-z0-9_-]{16,}\b/gi,
  },
  {
    name: "secret",
    label: "SECRET",
    pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  },
  {
    name: "card",
    label: "CARD",
    // separators sit *between* digits, never after the last one, or the token
    // swallows the following space and words run together
    pattern: /\b\d(?:[ -]?\d){11,18}\b/g,
    validate: luhnValid,
  },
  {
    name: "ip",
    label: "IP",
    pattern:
      /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b|\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi,
  },
  {
    name: "ssn",
    label: "SSN",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    name: "phone",
    label: "PHONE",
    pattern: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}[\s.-]\d{2,4}[\s.-]?\d{2,4}\b/g,
    // require enough digits to be a phone number rather than a date or a duration
    validate: (m) => {
      const digits = m.replace(/\D/g, "");
      return digits.length >= 9 && digits.length <= 15;
    },
  },
];

export type RedactionMode = "off" | "mask" | "pseudonymize";
export type RedactionScope = "trace" | "global";

export interface PseudonymizerOptions {
  mode?: RedactionMode;
  /** "trace" restarts numbering per redact() call; "global" is salted and stable */
  scope?: RedactionScope;
  /** required for meaningful global-scope tokens */
  salt?: string;
  /** rule names to apply; defaults to all of them */
  rules?: string[];
}

export interface RedactionResult {
  text: string;
  /** rule name -> number of values replaced */
  counts: Record<string, number>;
  total: number;
}

export class Pseudonymizer {
  readonly mode: RedactionMode;
  readonly scope: RedactionScope;
  private rules: RedactionRule[];
  private salt: string;
  /** value -> token, for global scope */
  private globalTokens = new Map<string, string>();

  constructor(opts: PseudonymizerOptions = {}) {
    this.mode = opts.mode ?? "pseudonymize";
    this.scope = opts.scope ?? "trace";
    this.salt = opts.salt ?? "";

    if (opts.rules) {
      const known = new Map(REDACTION_RULES.map((r) => [r.name, r]));
      this.rules = opts.rules.map((name) => {
        const rule = known.get(name);
        // A misspelled rule silently doing nothing would mean believing PII is
        // stripped when it is not — the worst failure this component can have.
        if (!rule) {
          throw new Error(
            `unknown redaction rule ${JSON.stringify(name)}; available: ${[...known.keys()].join(", ")}`,
          );
        }
        return rule;
      });
    } else {
      this.rules = REDACTION_RULES;
    }
  }

  redact(text: string): RedactionResult {
    const counts: Record<string, number> = {};
    if (this.mode === "off" || text.length === 0) return { text, counts, total: 0 };

    // Per-trace numbering lives here so it resets on every call.
    const traceTokens = new Map<string, string>();
    const perLabelCounters = new Map<string, number>();
    let total = 0;

    let working = text;
    for (const rule of this.rules) {
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      working = working.replace(pattern, (match) => {
        if (rule.validate && !rule.validate(match)) return match;
        // Never re-redact something already replaced.
        if (/^<[A-Z_]+(?:_[^>]+)?>$/.test(match)) return match;

        counts[rule.name] = (counts[rule.name] ?? 0) + 1;
        total++;

        const token = this.tokenFor(rule, match, traceTokens, perLabelCounters);
        return rule.transform ? rule.transform(match, token) : token;
      });
    }

    return { text: working, counts, total };
  }

  private tokenFor(
    rule: RedactionRule,
    value: string,
    traceTokens: Map<string, string>,
    perLabelCounters: Map<string, number>,
  ): string {
    if (this.mode === "mask") return `<${rule.label}>`;

    const key = `${rule.name}:${value}`;
    if (this.scope === "global") {
      const existing = this.globalTokens.get(key);
      if (existing) return existing;
      const digest = createHash("sha256").update(`${this.salt}:${key}`).digest("hex").slice(0, 8);
      const token = `<${rule.label}_${digest}>`;
      this.globalTokens.set(key, token);
      return token;
    }

    const existing = traceTokens.get(key);
    if (existing) return existing;
    const next = (perLabelCounters.get(rule.label) ?? 0) + 1;
    perLabelCounters.set(rule.label, next);
    const token = `<${rule.label}_${next}>`;
    traceTokens.set(key, token);
    return token;
  }
}
