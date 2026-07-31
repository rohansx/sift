/**
 * Published list prices, USD per 1,000,000 tokens.
 *
 * Its own file, with a date, because a stale price is a wrong bill. Three rules
 * follow from that and are enforced by the estimator rather than by good
 * intentions: the date is printed with every estimate, `--price-in`/`--price-out`
 * override the table entirely, and a model that matches nothing here produces no
 * dollar figure at all — tokens only. A plausible wrong number is worse than an
 * absent one, because nobody double-checks a number that looks right.
 *
 * Deliberately short. Every entry is a maintenance liability, so this covers the
 * two sift defaults plus the cheap models someone is likely to point it at.
 */

export const PRICES_AS_OF = "2026-07-31";

export const PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-4-5": { in: 3, out: 15 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  // embeddings bill on input only
  "text-embedding-3-small": { in: 0.02, out: 0 },
  "text-embedding-3-large": { in: 0.13, out: 0 },
};

/**
 * Longest matching prefix, so a dated Anthropic id
 * (`claude-haiku-4-5-20251001`) finds its family and a longer, more specific
 * key always beats a shorter one that also matches.
 */
export function priceFor(model: string): { in: number; out: number } | null {
  let best = "";
  for (const key of Object.keys(PRICES)) {
    if (model.startsWith(key) && key.length > best.length) best = key;
  }
  return best ? PRICES[best]! : null;
}
