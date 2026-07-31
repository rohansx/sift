import { execFileSync } from "node:child_process";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Builds the deployable demo site, for Vercel or any other static host.
 *
 * A fresh clone has no sift.db — databases are gitignored, and committing one
 * would mean committing trace text. So the site is built from synthetic traffic
 * generated at build time: `sift demo` plants known failure modes, the offline
 * providers cluster them with no API key and no network, and `sift publish`
 * writes the result out. Reproducible from the repo alone, and there is nothing
 * private in it to leak.
 *
 * It runs dist/cli.js rather than src/cli.ts on purpose. The sources rely on
 * Node's type stripping, which needs 22.18+; the compiled output does not, so
 * the build stops depending on which Node a host happens to pin.
 *
 * Publishing YOUR traces is a different command — `sift publish` against your
 * own database — and deliberately not something a CI build can do by accident.
 */

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const OUT = new URL("../site/", import.meta.url).pathname.replace(/\/$/, "");

const work = mkdtempSync(join(tmpdir(), "sift-site-"));
const db = join(work, "sift.db");
const traces = join(work, "demo.jsonl");

const env = {
  ...process.env,
  SIFT_LLM_PROVIDER: "fake",
  SIFT_EMBED_PROVIDER: "hash",
  SIFT_DB: db,
};

const sift = (...args) => execFileSync(process.execPath, [CLI, ...args], { env, stdio: "inherit" });

try {
  sift("demo", "--out", traces, "--traces", "500");
  sift("analyze", "--otlp", traces);
  // Resolve the planted retry loop so the published site shows the state
  // machine doing its job — a lifecycle badge and a REGRESSED delta row are the
  // whole point of the screenshot, and an all-"active" board demonstrates none
  // of it.
  sift("resolve", "SIFT-20", "--note", "fixed in v1.3");
  sift("publish", "--out", OUT);
} finally {
  rmSync(work, { recursive: true, force: true });
}
