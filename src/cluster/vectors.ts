/**
 * Dependency-free vector math.
 *
 * At registry scale — hundreds of themes, thousands of traces per window —
 * brute-force cosine is entirely fine, and it keeps sift installable with no
 * native modules. `sqlite-vec` ANN is the upgrade path if that stops being true.
 *
 * Every function that takes two vectors checks their dimensions. Switching
 * embedding models against an existing registry is a real and quiet failure
 * mode; it should throw rather than produce meaningless similarities.
 */

function assertSameDim(a: number[], b: number[]): void {
  if (a.length !== b.length) {
    throw new Error(`vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
}

export function dot(a: number[], b: number[]): number {
  assertSameDim(a, b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export function norm(a: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s);
}

/** Cosine similarity, clamped to [-1, 1]; a zero vector has no direction, so 0. */
export function cosine(a: number[], b: number[]): number {
  assertSameDim(a, b);
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  const c = dot(a, b) / (na * nb);
  return c > 1 ? 1 : c < -1 ? -1 : c;
}

/** Cosine *distance*: 0 = identical direction, 2 = opposite. */
export function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosine(a, b);
}

/** Unit vector in the same direction; a zero vector is returned unchanged. */
export function normalize(a: number[]): number[] {
  const n = norm(a);
  if (n === 0) return a.slice();
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! / n;
  return out;
}

/** Component-wise mean of a non-empty, non-ragged set of vectors. */
export function mean(vectors: number[][]): number[] {
  if (vectors.length === 0) throw new Error("mean() of an empty vector set");
  const dims = vectors[0]!.length;
  const out = new Array<number>(dims).fill(0);
  for (const v of vectors) {
    assertSameDim(vectors[0]!, v);
    for (let i = 0; i < dims; i++) out[i] += v[i]!;
  }
  for (let i = 0; i < dims; i++) out[i]! /= vectors.length;
  return out;
}

/**
 * Fold one new member into a running-mean centroid.
 *
 * The registry updates centroids one assignment at a time and never re-reads
 * member embeddings, so this must equal the batch mean of all members exactly.
 */
export function updateCentroid(centroid: number[], memberCount: number, next: number[]): number[] {
  if (!Number.isInteger(memberCount) || memberCount < 0) {
    throw new Error(`memberCount must be a non-negative integer, got ${memberCount}`);
  }
  if (memberCount === 0) return next.slice();
  assertSameDim(centroid, next);
  const out = new Array<number>(centroid.length);
  for (let i = 0; i < centroid.length; i++) {
    out[i] = (centroid[i]! * memberCount + next[i]!) / (memberCount + 1);
  }
  return out;
}

export interface NearestHit<T> {
  item: T;
  index: number;
  similarity: number;
}

/**
 * Most cosine-similar candidate, or null if there are none. Ties go to the
 * earlier candidate so repeated runs over the same registry agree.
 * Thresholding is deliberately the caller's job — the registry decides what
 * counts as "close enough", this only ranks.
 */
export function nearest<T>(
  query: number[],
  candidates: readonly T[],
  vectorOf: (item: T) => number[],
): NearestHit<T> | null {
  let best: NearestHit<T> | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i]!;
    const sim = cosine(query, vectorOf(item));
    if (best === null || sim > best.similarity) best = { item, index: i, similarity: sim };
  }
  return best;
}
