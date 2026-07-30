import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SiftStore } from "../store/db.ts";

/** A temp directory that cleans itself up, sync or async body. */
export function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sift-test-"));
  try {
    const result = fn(dir);
    if (result instanceof Promise) {
      return result.finally(() => rmSync(dir, { recursive: true, force: true })) as T;
    }
    rmSync(dir, { recursive: true, force: true });
    return result;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * A real SQLite store on a real file in a temp dir. Store tests run against
 * the actual database rather than a mock: node:sqlite is fast enough that it
 * costs nothing, and it catches schema bugs a mock never would.
 */
export function withTempStore<T>(fn: (store: SiftStore, dir: string) => T): T {
  return withTempDir((dir) => {
    const store = new SiftStore(join(dir, "sift.db"));
    const done = () => store.close();
    try {
      const result = fn(store, dir);
      if (result instanceof Promise) return result.finally(done) as T;
      done();
      return result;
    } catch (err) {
      done();
      throw err;
    }
  });
}
