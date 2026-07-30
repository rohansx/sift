import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { discoverClusters } from "../src/cluster/bootstrap.ts";
import { cosine, mean } from "../src/cluster/vectors.ts";
import { gaussian, mulberry32 } from "../src/testing/random.ts";

/** `count` points scattered around basis direction `mode` in `dims` dimensions. */
function blob(mode: number, count: number, dims: number, noise: number, rng: () => number): number[][] {
  return Array.from({ length: count }, () => {
    const v = new Array<number>(dims).fill(0);
    v[mode] = 1;
    for (let i = 0; i < dims; i++) v[i]! += gaussian(rng) * noise;
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  });
}

describe("discoverClusters", () => {
  test("finds the planted modes", () => {
    const rng = mulberry32(42);
    const points = [...blob(0, 20, 6, 0.08, rng), ...blob(1, 20, 6, 0.08, rng), ...blob(2, 20, 6, 0.08, rng)];
    const { clusters, noiseIndices } = discoverClusters(points, { minClusterSize: 5, mergeThreshold: 0.35 });

    assert.equal(clusters.length, 3);
    assert.deepEqual(clusters.map((c) => c.memberIndices.length).sort(), [20, 20, 20]);
    assert.equal(noiseIndices.length, 0);
  });

  test("clusters partition the input: disjoint, and every point accounted for", () => {
    const rng = mulberry32(7);
    const points = [...blob(0, 12, 5, 0.1, rng), ...blob(1, 12, 5, 0.1, rng), ...blob(3, 2, 5, 0.1, rng)];
    const { clusters, noiseIndices } = discoverClusters(points, { minClusterSize: 5, mergeThreshold: 0.35 });

    const seen = new Set<number>();
    for (const c of clusters) {
      for (const i of c.memberIndices) {
        assert.ok(!seen.has(i), `index ${i} appears in two clusters`);
        seen.add(i);
      }
    }
    for (const i of noiseIndices) {
      assert.ok(!seen.has(i), `index ${i} is both clustered and noise`);
      seen.add(i);
    }
    assert.equal(seen.size, points.length);
  });

  test("groups below minClusterSize become noise, not themes", () => {
    // A theme is an accountable object with an ID someone might mute or assign.
    // Three loosely-related traces should not become one.
    const rng = mulberry32(3);
    const points = [...blob(0, 20, 5, 0.08, rng), ...blob(1, 3, 5, 0.08, rng)];
    const { clusters, noiseIndices } = discoverClusters(points, { minClusterSize: 5, mergeThreshold: 0.35 });

    assert.equal(clusters.length, 1);
    assert.deepEqual(noiseIndices.sort((a, b) => a - b), [20, 21, 22]);
  });

  test("a cluster's centroid is the mean of its members", () => {
    const rng = mulberry32(11);
    const points = blob(0, 10, 4, 0.1, rng);
    const { clusters } = discoverClusters(points, { minClusterSize: 5, mergeThreshold: 0.5 });
    const expected = mean(clusters[0]!.memberIndices.map((i) => points[i]!));
    for (let d = 0; d < expected.length; d++) {
      assert.ok(Math.abs(clusters[0]!.centroid[d]! - expected[d]!) < 1e-9);
    }
  });

  test("a tighter merge threshold produces more, finer clusters", () => {
    const rng = mulberry32(5);
    const points = [...blob(0, 15, 8, 0.25, rng), ...blob(1, 15, 8, 0.25, rng)];
    const loose = discoverClusters(points, { minClusterSize: 2, mergeThreshold: 0.9 });
    const tight = discoverClusters(points, { minClusterSize: 2, mergeThreshold: 0.05 });
    assert.ok(tight.clusters.length >= loose.clusters.length, "tighter cut should not merge more");
  });

  test("identical points collapse into one cluster", () => {
    const points = Array.from({ length: 8 }, () => [1, 0, 0]);
    const { clusters } = discoverClusters(points, { minClusterSize: 3, mergeThreshold: 0.35 });
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0]!.memberIndices.length, 8);
  });

  test("results are deterministic and ordered largest-first", () => {
    const rng = mulberry32(21);
    const points = [...blob(0, 8, 5, 0.05, rng), ...blob(1, 20, 5, 0.05, rng)];
    const a = discoverClusters(points, { minClusterSize: 3, mergeThreshold: 0.35 });
    const b = discoverClusters(points, { minClusterSize: 3, mergeThreshold: 0.35 });
    assert.deepEqual(a, b);
    assert.ok(a.clusters[0]!.memberIndices.length >= a.clusters[1]!.memberIndices.length);
    for (const c of a.clusters) {
      assert.deepEqual(c.memberIndices, [...c.memberIndices].sort((x, y) => x - y));
    }
  });

  test("degenerate inputs are handled", () => {
    assert.deepEqual(discoverClusters([], { minClusterSize: 2, mergeThreshold: 0.35 }), { clusters: [], noiseIndices: [] });

    const single = discoverClusters([[1, 0]], { minClusterSize: 2, mergeThreshold: 0.35 });
    assert.deepEqual(single.clusters, []);
    assert.deepEqual(single.noiseIndices, [0]);

    const singleAllowed = discoverClusters([[1, 0]], { minClusterSize: 1, mergeThreshold: 0.35 });
    assert.equal(singleAllowed.clusters.length, 1);
  });

  test("mismatched dimensions are rejected", () => {
    assert.throws(() => discoverClusters([[1, 0], [1]], { minClusterSize: 1, mergeThreshold: 0.35 }), /dimension/i);
  });

  test("average linkage resists chaining across a sparse bridge", () => {
    // Single linkage would join two blobs through one intermediate point.
    // Average linkage should not, which is why themes stay coherent.
    const rng = mulberry32(13);
    const left = blob(0, 15, 4, 0.05, rng);
    const right = blob(1, 15, 4, 0.05, rng);
    const bridge = [[0.7, 0.7, 0, 0].map((x) => x / Math.hypot(0.7, 0.7)) as unknown as number[]].map((v) => v);
    const points = [...left, ...right, ...bridge];
    const { clusters } = discoverClusters(points, { minClusterSize: 5, mergeThreshold: 0.35 });
    assert.equal(clusters.length, 2, "the bridge point should not fuse the two blobs");
  });
});

describe("scale", () => {
  test("handles a residual pile far larger than the prototype's O(n^3) loop could", () => {
    // Re-discovery runs on residuals, and a bad week produces thousands of them.
    // If this takes minutes, the incremental story is a lie.
    const rng = mulberry32(1234);
    const points = [
      ...blob(0, 1200, 12, 0.1, rng),
      ...blob(1, 1000, 12, 0.1, rng),
      ...blob(2, 800, 12, 0.1, rng),
    ];
    const started = process.hrtime.bigint();
    const { clusters } = discoverClusters(points, { minClusterSize: 20, mergeThreshold: 0.35 });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(clusters.length, 3);
    assert.ok(elapsedMs < 10_000, `discovery took ${elapsedMs.toFixed(0)}ms for 3000 points`);

    // the pre-pass must not distort the answer: centroids still point at the modes
    const dominant = clusters.map((c) => c.centroid.indexOf(Math.max(...c.centroid))).sort();
    assert.deepEqual(dominant, [0, 1, 2]);
  });

  test("the large-input path agrees with the direct path on the same data", () => {
    const rng = mulberry32(99);
    const points = [...blob(0, 60, 8, 0.08, rng), ...blob(1, 60, 8, 0.08, rng)];
    const direct = discoverClusters(points, { minClusterSize: 10, mergeThreshold: 0.35, maxDirect: 10_000 });
    const viaLeaders = discoverClusters(points, { minClusterSize: 10, mergeThreshold: 0.35, maxDirect: 10 });

    assert.equal(viaLeaders.clusters.length, direct.clusters.length);
    const sizes = (r: typeof direct) => r.clusters.map((c) => c.memberIndices.length).sort((a, b) => a - b);
    assert.deepEqual(sizes(viaLeaders), sizes(direct));
  });

  test("clusters stay coherent: members are nearer their own centroid than any other", () => {
    const rng = mulberry32(77);
    const points = [...blob(0, 30, 6, 0.1, rng), ...blob(1, 30, 6, 0.1, rng), ...blob(2, 30, 6, 0.1, rng)];
    const { clusters } = discoverClusters(points, { minClusterSize: 10, mergeThreshold: 0.35 });

    for (const c of clusters) {
      for (const i of c.memberIndices) {
        const own = cosine(points[i]!, c.centroid);
        for (const other of clusters) {
          if (other === c) continue;
          assert.ok(own > cosine(points[i]!, other.centroid), `point ${i} is closer to another cluster`);
        }
      }
    }
  });
});
