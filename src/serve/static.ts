import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The prebuilt dashboard, read into memory once and served from a Map.
 *
 * The whole point of the Map is that path traversal is not defended against
 * here — it is structurally impossible. A request path is a key or it is not;
 * there is no per-request `join`, `resolve` or `fs` call to get wrong, so
 * `/%2e%2e/%2e%2e/etc/passwd` is a miss like any other typo. That is also fewer
 * lines than the careful version of a filesystem server, which is the usual
 * order of these two properties reversed.
 *
 * The cost is that editing the UI needs a server restart. `npm run ui:dev`
 * proxies /api at the real receiver, so the dev loop never comes through here.
 */

export interface Asset {
  body: Buffer;
  type: string;
  /** sha256 prefix; strong, because the bytes are frozen at boot */
  etag: string;
}

/**
 * Extensions Vite actually emits, and nothing else.
 *
 * An allow-list rather than a lookup with a fallback: a file that lands in
 * dist/ui with an unexpected extension is a build change someone should notice,
 * not something to serve as application/octet-stream and hope.
 */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * Why the trace text in this page needs a policy at all: it is arbitrary
 * end-user chat input. React escapes it, which is the actual defence — this is
 * the layer that holds if someone ever reaches for innerHTML anyway.
 *
 * `style-src 'unsafe-inline'` stays on purpose. Inline styles cannot execute
 * script, and one stray `style={{}}` silently blanking the dashboard is a worse
 * failure than the sliver of risk it removes.
 */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'";

/** What to print when someone runs from a clone and there is nothing to serve. */
export const UI_NOT_BUILT = "the dashboard is not built in this checkout; run `npm run build:ui`, then restart sift serve";

/**
 * Every asset keyed by the pathname that should return it, `/` included.
 *
 * Returns an empty map when there is no build, rather than throwing: a missing
 * dist/ui is the normal state of a fresh clone, and `sift serve` still has an
 * OTLP receiver to run.
 */
export function loadUiAssets(root: string | undefined = defaultUiRoot()): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  if (root === undefined) return assets;
  try {
    walk(root, "", assets);
  } catch {
    // A half-readable directory is not worth a crash on a path that is optional
    // by design; the 404 below says what to do about it.
    return new Map();
  }
  // Any directory holding an index.html answers at the directory itself, so the
  // landing page is `/` and the dashboard is `/app` rather than `/app/index.html`.
  // Generalized rather than special-cased for the two that exist today: a build
  // that adds a third page should not need a change here to be reachable.
  for (const [path, asset] of [...assets]) {
    if (!path.endsWith("/index.html")) continue;
    assets.set(path.slice(0, -"index.html".length), asset); // /app/ and /
    const bare = path.slice(0, -"/index.html".length);
    if (bare !== "") assets.set(bare, asset); // /app
  }
  return assets;
}

function walk(dir: string, prefix: string, into: Map<string, Asset>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(child, `${prefix}/${entry.name}`, into);
      continue;
    }
    const type = TYPES[extname(entry.name).toLowerCase()];
    if (type === undefined) continue;
    const body = readFileSync(child);
    into.set(`${prefix}/${entry.name}`, {
      body,
      type,
      etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`,
    });
  }
}

/**
 * dist/ui, found from wherever this module happens to be.
 *
 * Two candidates because the depth differs between the two ways sift runs: from
 * the published package this file is dist/serve/static.js, and from a clone it
 * is src/serve/static.ts with the build one level up. Whichever has an
 * index.html wins; neither having one means no dashboard.
 */
function defaultUiRoot(): string | undefined {
  for (const candidate of ["../ui/", "../../dist/ui/"]) {
    const dir = fileURLToPath(new URL(candidate, import.meta.url));
    try {
      readFileSync(`${dir}index.html`);
      return dir.replace(/\/$/, "");
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * One asset, with the caching the filename already earns.
 *
 * Vite content-hashes everything under /assets, so those are immutable for a
 * year and the browser never asks again. index.html keeps the same URL across
 * builds, so it revalidates every time and gets a 304 when nothing moved —
 * without that, a `npm i -g` upgrade would serve last version's HTML pointing
 * at asset filenames that no longer exist.
 */
export function serveAsset(req: IncomingMessage, res: ServerResponse, asset: Asset, path: string): void {
  const headers: Record<string, string> = {
    "content-type": asset.type,
    "content-length": String(asset.body.length),
    "x-content-type-options": "nosniff",
    etag: asset.etag,
    "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  };
  if (asset.type.startsWith("text/html")) headers["content-security-policy"] = CSP;

  if (req.headers["if-none-match"] === asset.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  // HEAD gets the headers and no body; writing one would be a protocol error.
  if (req.method === "HEAD") res.end();
  else res.end(asset.body);
}
