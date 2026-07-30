/**
 * P0 — proves the zero-build TDD harness itself works before anything depends
 * on it: TypeScript executed directly by Node's type stripping, `node:test`,
 * and `node:sqlite` (which every later phase's store tests need).
 *
 * If this file fails, no other failure in the suite means anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Probe {
  name: string;
  value: number;
}

test("node executes TypeScript source directly", () => {
  const p: Probe = { name: "sift", value: 1 };
  const typed = (x: Probe): string => `${x.name}:${x.value}`;
  assert.equal(typed(p), "sift:1");
});

test("node:sqlite is available and usable", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)");
  db.prepare("INSERT INTO t VALUES (?, ?)").run("a", 42);
  const row = db.prepare("SELECT n FROM t WHERE id = ?").get("a") as { n: number };
  assert.equal(row.n, 42);
  db.close();
});

test("package declares the node engine the harness relies on", () => {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    engines: { node: string };
    dependencies: Record<string, string>;
  };
  assert.match(pkg.engines.node, /^>=22/);
  // Local-first means installable anywhere: sift ships with no runtime deps.
  assert.deepEqual(pkg.dependencies, {});
});
