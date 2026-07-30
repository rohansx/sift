import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { cosine, dot, mean, nearest, norm, normalize, updateCentroid } from "../src/cluster/vectors.ts";
import { gaussian, mulberry32 } from "../src/testing/random.ts";

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b} (within ${eps})`);

describe("dot / norm", () => {
  test("dot product", () => {
    assert.equal(dot([1, 2, 3], [4, 5, 6]), 32);
  });

  test("norm is euclidean length", () => {
    assert.equal(norm([3, 4]), 5);
    assert.equal(norm([0, 0, 0]), 0);
  });

  test("mismatched dimensions throw instead of silently truncating", () => {
    // Switching embedding models mid-registry is a real failure mode; it must
    // be loud rather than produce quietly meaningless similarities.
    assert.throws(() => dot([1, 2], [1, 2, 3]), /dimension/i);
  });
});

describe("cosine", () => {
  test("identical vectors are 1", () => close(cosine([1, 2, 3], [1, 2, 3]), 1));
  test("orthogonal vectors are 0", () => close(cosine([1, 0], [0, 1]), 0));
  test("opposite vectors are -1", () => close(cosine([1, 2], [-1, -2]), -1));

  test("is scale invariant", () => {
    close(cosine([1, 2, 3], [10, 20, 30]), 1);
    close(cosine([1, 2, 3], [2, 1, 0]), cosine([5, 10, 15], [2, 1, 0]));
  });

  test("a zero vector has no direction, so similarity is 0 rather than NaN", () => {
    assert.equal(cosine([0, 0], [1, 1]), 0);
    assert.equal(cosine([0, 0], [0, 0]), 0);
  });

  test("stays within [-1, 1] under floating point noise", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const a = Array.from({ length: 32 }, () => gaussian(rng));
      const b = Array.from({ length: 32 }, () => gaussian(rng));
      const c = cosine(a, b);
      assert.ok(c >= -1 && c <= 1, `cosine out of range: ${c}`);
    }
    // exact self-similarity must not exceed 1, which naive division can do
    const v = Array.from({ length: 64 }, () => gaussian(rng));
    assert.ok(cosine(v, v) <= 1);
  });

  test("mismatched dimensions throw", () => {
    assert.throws(() => cosine([1, 2], [1, 2, 3]), /dimension/i);
  });
});

describe("normalize", () => {
  test("produces a unit vector in the same direction", () => {
    const u = normalize([3, 4]);
    close(norm(u), 1);
    close(cosine(u, [3, 4]), 1);
  });

  test("a zero vector normalizes to itself, not NaN", () => {
    assert.deepEqual(normalize([0, 0, 0]), [0, 0, 0]);
  });

  test("does not mutate its input", () => {
    const v = [3, 4];
    normalize(v);
    assert.deepEqual(v, [3, 4]);
  });
});

describe("mean", () => {
  test("averages component-wise", () => {
    assert.deepEqual(mean([[0, 0], [2, 4]]), [1, 2]);
  });

  test("rejects an empty set rather than returning a phantom origin", () => {
    assert.throws(() => mean([]), /empty/i);
  });

  test("rejects ragged input", () => {
    assert.throws(() => mean([[1, 2], [1]]), /dimension/i);
  });
});

describe("updateCentroid", () => {
  test("with zero members the new point becomes the centroid", () => {
    assert.deepEqual(updateCentroid([0, 0], 0, [4, 2]), [4, 2]);
  });

  test("running mean matches the batch mean exactly", () => {
    // This is the property the registry depends on: centroids updated one
    // assignment at a time must equal the mean of every member so far, or
    // themes drift and stable identity is a lie.
    const rng = mulberry32(99);
    const dims = 16;
    const points: number[][] = Array.from({ length: 50 }, () =>
      Array.from({ length: dims }, () => gaussian(rng)),
    );

    let centroid = points[0]!.slice();
    let count = 1;
    for (let i = 1; i < points.length; i++) {
      centroid = updateCentroid(centroid, count, points[i]!);
      count++;
      const batch = mean(points.slice(0, i + 1));
      for (let d = 0; d < dims; d++) close(centroid[d]!, batch[d]!, 1e-9);
    }
  });

  test("does not mutate the previous centroid", () => {
    const c = [1, 1];
    const next = updateCentroid(c, 1, [3, 3]);
    assert.deepEqual(c, [1, 1]);
    assert.deepEqual(next, [2, 2]);
  });

  test("rejects a mismatched incoming vector", () => {
    assert.throws(() => updateCentroid([1, 1], 1, [1, 1, 1]), /dimension/i);
  });

  test("rejects a negative member count", () => {
    assert.throws(() => updateCentroid([1, 1], -1, [1, 1]), /memberCount/i);
  });
});

describe("nearest", () => {
  const candidates = [
    { id: "a", vector: [1, 0, 0] },
    { id: "b", vector: [0, 1, 0] },
    { id: "c", vector: [0.9, 0.1, 0] },
  ];

  test("finds the most similar candidate and reports the similarity", () => {
    const hit = nearest([1, 0, 0], candidates, (c) => c.vector);
    assert.equal(hit?.item.id, "a");
    close(hit!.similarity, 1);
  });

  test("ties resolve to the first candidate, so results are stable run to run", () => {
    const hit = nearest([1, 0, 0], [
      { id: "x", vector: [1, 0, 0] },
      { id: "y", vector: [1, 0, 0] },
    ], (c) => c.vector);
    assert.equal(hit?.item.id, "x");
  });

  test("returns null for an empty candidate set", () => {
    assert.equal(nearest([1, 0], [], (c: { vector: number[] }) => c.vector), null);
  });

  test("negative similarity still returns the best match; thresholding is the caller's job", () => {
    const hit = nearest([-1, 0, 0], candidates, (c) => c.vector);
    assert.equal(hit?.item.id, "b");
    close(hit!.similarity, 0);
  });
});
