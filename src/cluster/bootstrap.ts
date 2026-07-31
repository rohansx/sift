import { cosine, mean } from "./vectors.ts";

/**
 * Discovery clustering. Runs only at bootstrap and on the residual pile
 * (OVERVIEW.md §3.1) — the registry's assignment path does the everyday work.
 *
 * Average-linkage agglomerative over cosine distance, cut at a distance
 * threshold, with small groups falling out as noise. Average linkage rather
 * than single linkage because single linkage chains: one intermediate trace
 * fuses two unrelated themes, and a theme that means two things is worse than
 * no theme at all.
 *
 * This is not trying to beat UMAP+HDBSCAN on quality. It does not need to:
 * discovery runs rarely, and a fancier backend can slot in behind this exact
 * signature later.
 */

export interface DiscoveredCluster {
  /** ascending indices into the input array */
  memberIndices: number[];
  centroid: number[];
}

export interface DiscoveryResult {
  clusters: DiscoveredCluster[];
  /** points that never joined a group large enough to be a theme */
  noiseIndices: number[];
}

export interface DiscoveryOptions {
  minClusterSize: number;
  /** cosine *distance* at which merging stops (0 = identical, 2 = opposite) */
  mergeThreshold?: number;
  /**
   * Above this many points, a leader pre-pass collapses near-duplicates before
   * agglomeration. The exact quadratic is fine for a few thousand points and
   * ruinous well before a hundred thousand — measured, 10k costs 271s and 950MB
   * and 50k cannot allocate its 18.6 GiB matrix at all (ROADMAP §Measured
   * limits).
   *
   * Setting this *above* n is currently the faster option on summaries that do
   * not repeat verbatim: see the pre-pass itself for why.
   */
  maxDirect?: number;
  /**
   * Observability hook: how many leaders the pre-pass produced, or `null` when
   * it was skipped or abandoned and the exact path ran on every point. This is
   * the single number that decides whether a discovery pass costs O(n) or
   * O(n²), and without it a slow run is unattributable (src/examples/benchmark.ts).
   */
  onLeaders?: (leaders: number | null) => void;
}

export function discoverClusters(embeddings: number[][], opts: DiscoveryOptions): DiscoveryResult {
  const n = embeddings.length;
  if (n === 0) return { clusters: [], noiseIndices: [] };

  const dims = embeddings[0]!.length;
  for (const e of embeddings) {
    if (e.length !== dims) throw new Error(`vector dimension mismatch: ${dims} vs ${e.length}`);
  }

  const mergeThreshold = opts.mergeThreshold ?? 0.35;
  const maxDirect = opts.maxDirect ?? 1500;

  let groups: number[][];
  if (n <= maxDirect) {
    opts.onLeaders?.(null);
    groups = agglomerate(embeddings, embeddings.map(() => 1), mergeThreshold);
  } else {
    groups = agglomerateViaLeaders(embeddings, mergeThreshold, maxDirect, opts.onLeaders);
  }

  const clusters: DiscoveredCluster[] = [];
  const noiseIndices: number[] = [];
  for (const members of groups) {
    if (members.length >= opts.minClusterSize) {
      const sorted = [...members].sort((a, b) => a - b);
      clusters.push({ memberIndices: sorted, centroid: mean(sorted.map((i) => embeddings[i]!)) });
    } else {
      noiseIndices.push(...members);
    }
  }

  // largest first: the issues list leads with what most traffic is doing
  clusters.sort((a, b) => b.memberIndices.length - a.memberIndices.length || a.memberIndices[0]! - b.memberIndices[0]!);
  noiseIndices.sort((a, b) => a - b);
  return { clusters, noiseIndices };
}

/**
 * Average-linkage agglomeration over `reps`, each carrying a weight (how many
 * original points it stands for). Returns groups of indices into `reps`.
 *
 * Keeps a full distance matrix plus a nearest-neighbour cache, and updates
 * distances with the Lance-Williams recurrence on merge, so the whole run is
 * O(n²)-ish instead of rescanning every pair for every merge — the prototype's
 * rescan-everything loop was O(n³) and unusable past a few hundred points.
 */
function agglomerate(reps: number[][], weights: number[], mergeThreshold: number): number[][] {
  const m = reps.length;
  if (m <= 1) return reps.map((_, i) => [i]);

  const sizes = [...weights];
  const groups: Array<number[] | null> = reps.map((_, i) => [i]);

  const d = new Float64Array(m * m);
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      const dist = 1 - cosine(reps[i]!, reps[j]!);
      d[i * m + j] = dist;
      d[j * m + i] = dist;
    }
  }

  const alive = new Uint8Array(m).fill(1);
  const nn = new Int32Array(m).fill(-1);
  const nnDist = new Float64Array(m).fill(Infinity);
  const refreshNn = (i: number) => {
    let best = -1;
    let bestDist = Infinity;
    for (let j = 0; j < m; j++) {
      if (j === i || !alive[j]) continue;
      const dist = d[i * m + j]!;
      if (dist < bestDist) {
        bestDist = dist;
        best = j;
      }
    }
    nn[i] = best;
    nnDist[i] = bestDist;
  };
  for (let i = 0; i < m; i++) refreshNn(i);

  let remaining = m;
  while (remaining > 1) {
    let a = -1;
    let bestDist = Infinity;
    for (let i = 0; i < m; i++) {
      if (alive[i] && nnDist[i]! < bestDist) {
        bestDist = nnDist[i]!;
        a = i;
      }
    }
    if (a === -1 || bestDist > mergeThreshold) break;
    const b = nn[a]!;
    // merge the higher index into the lower one so results stay order-stable
    const [keep, drop] = a < b ? [a, b] : [b, a];

    groups[keep] = groups[keep]!.concat(groups[drop]!);
    const nKeep = sizes[keep]!;
    const nDrop = sizes[drop]!;

    for (let k = 0; k < m; k++) {
      if (k === keep || k === drop || !alive[k]) continue;
      // Lance-Williams for average linkage (UPGMA)
      const merged = (nKeep * d[keep * m + k]! + nDrop * d[drop * m + k]!) / (nKeep + nDrop);
      d[keep * m + k] = merged;
      d[k * m + keep] = merged;
    }

    sizes[keep] = nKeep + nDrop;
    alive[drop] = 0;
    groups[drop] = null;
    remaining--;

    refreshNn(keep);
    for (let i = 0; i < m; i++) {
      if (alive[i] && (nn[i] === drop || nn[i] === keep)) refreshNn(i);
    }
  }

  return groups.filter((g): g is number[] => g !== null);
}

/**
 * Leader pre-pass for large inputs: one scan assigns each point to the first
 * leader within half the merge radius, then the leaders — far fewer objects —
 * are agglomerated properly and their members flattened back out.
 *
 * "far fewer objects" is the assumption, and benchmarking says it is usually
 * false. Real summaries do not repeat, and at 1536 dims two phrasings of one
 * behavior sit ~0.20 apart while the radius is 0.175 — so 2,000 points yield
 * 1,998 leaders and the scan buys nothing it did not already pay for. Measured
 * cost of keeping it: 2× at n=2,000, 1.4× at n=10,000, for identical output
 * (ROADMAP §Measured limits). It only earns its keep when summaries collide
 * verbatim, which is what the offline fakes do and what a real model does not.
 * Left in place because deleting it is a clustering behavior change that wants
 * its own commit; the trigger is what needs rethinking, not the technique.
 */
function agglomerateViaLeaders(
  points: number[][],
  mergeThreshold: number,
  maxDirect: number,
  onLeaders?: (leaders: number | null) => void,
): number[][] {
  const radius = mergeThreshold / 2;
  const leaderVectors: number[][] = [];
  const leaderMembers: number[][] = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    let best = -1;
    let bestDist = Infinity;
    for (let l = 0; l < leaderVectors.length; l++) {
      const dist = 1 - cosine(p, leaderVectors[l]!);
      if (dist < bestDist) {
        bestDist = dist;
        best = l;
      }
    }
    if (best !== -1 && bestDist <= radius) {
      leaderMembers[best]!.push(i);
    } else {
      leaderVectors.push(p);
      leaderMembers.push([i]);
      // Data where nothing lands inside the radius would otherwise make every
      // point its own leader and buy nothing; fall back to the exact path.
      // Measured, this is the common case, not the pathological one: 1536-dim
      // summaries of the same behavior sit ~0.20 apart and the radius is 0.175,
      // so 5,000 points yield 4,964 leaders (ROADMAP §Measured limits).
      if (leaderVectors.length > maxDirect * 4) {
        onLeaders?.(null);
        return agglomerate(points, points.map(() => 1), mergeThreshold);
      }
    }
  }
  onLeaders?.(leaderVectors.length);

  // leaders are weighted by how many points they absorbed, so average linkage
  // between them means the same thing it would have on the raw points
  const merged = agglomerate(
    leaderMembers.map((members) => mean(members.map((i) => points[i]!))),
    leaderMembers.map((members) => members.length),
    mergeThreshold,
  );

  return merged.map((leaderGroup) => leaderGroup.flatMap((l) => leaderMembers[l]!));
}
