import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { startReceiver } from "../ingest/receiver.ts";
import { loadUiAssets, UI_NOT_BUILT } from "../serve/static.ts";
import { createPseudonymizer } from "../pipeline.ts";
import type { Pipeline } from "../pipeline.ts";
import type { SiftConfig } from "../config.ts";
import type { ThemeDetail } from "../serve/api.ts";
import type { FacetReport } from "../report/model.ts";

/**
 * `sift publish` — the dashboard as a directory of files.
 *
 * The write path cannot go serverless: it is a long-lived process holding a
 * SQLite file open. The read side has no such problem, because the dashboard is
 * read-only by design, so publishing is a snapshot rather than a port.
 *
 * The responses are collected by running the real receiver on an ephemeral port
 * and fetching from it, not by re-deriving them here. Any second implementation
 * of "count assignments and divide" is a place the published site and
 * `sift report` can disagree, and the whole point of the export is that it says
 * what the CLI says. Same code path, same bytes.
 *
 * Everything lands in ONE json file rather than a tree mirroring the query
 * strings. A static host has no query strings to route on, so the alternative
 * is inventing a second URL scheme and teaching the UI both. The dashboard's
 * payload is themes, counts and a few exemplars — kilobytes — because the
 * embeddings that dominate sift.db are never sent to a browser.
 *
 * ponytail: one bundle, loaded once, filtered client-side. If a registry ever
 * grows past a few MB the upgrade is per-agent bundles, not a file per query.
 */

/** Marks a bundle as ours, so an SPA-fallback index.html cannot masquerade as data. */
export const STATIC_MARKER = "sift-static-export";

/** Where the UI looks for its data before deciding it is talking to a live server. */
export const DATA_FILE = "sift-data.json";

export interface PublishOptions {
  pipeline: Pipeline;
  cfg: SiftConfig;
  outDir: string;
  /** where the built dashboard lives; defaults to the same dist/ui `sift serve` uses */
  uiRoot?: string;
  /**
   * Run the pseudonymization gate over exemplar trace text.
   *
   * Defaults ON, and the CLI makes turning it off explicit. A published
   * dashboard is the one place trace text leaves the machine, and exemplars are
   * whole end-user conversations — the same argument that puts the gate in
   * front of a hosted model applies harder to a public URL.
   */
  redact?: boolean;
  log?: (message: string) => void;
}

export interface PublishResult {
  outDir: string;
  assets: number;
  endpoints: number;
  themes: number;
  redacted: boolean;
  /** values the gate replaced, by rule; empty when redaction is off */
  replacedByRule: Record<string, number>;
  bytes: number;
}

interface Bundle {
  __sift: string;
  generatedAt: string;
  redacted: boolean;
  /** request path (with query) -> the exact JSON body the live API returned */
  responses: Record<string, unknown>;
}

export async function publishSite(opts: PublishOptions): Promise<PublishResult> {
  const log = opts.log ?? (() => {});
  const redact = opts.redact ?? true;

  const assets = loadUiAssets(opts.uiRoot);
  if (assets.size === 0) throw new Error(UI_NOT_BUILT);

  const receiver = await startReceiver({
    store: opts.pipeline.store,
    host: "127.0.0.1",
    port: 0,
    pipeline: opts.pipeline,
  });

  const responses: Record<string, unknown> = {};
  const replacedByRule: Record<string, number> = {};
  let themes = 0;

  try {
    const get = async <T>(path: string): Promise<T> => {
      const res = await fetch(`${receiver.url}${path}`);
      const body = (await res.json()) as T & { error?: string };
      // A 404 here is a bug in the enumeration below, not user error: every path
      // is built from values the API itself just handed back.
      if (!res.ok) throw new Error(`${path} -> ${res.status} ${body.error ?? ""}`.trim());
      responses[path] = body;
      return body;
    };

    const meta = await get<{ agents: string[]; facets: string[] }>("/api/meta");
    const themeIds = new Set<string>();

    for (const agent of meta.agents) {
      for (const facet of meta.facets) {
        const scope = `agent=${encodeURIComponent(agent)}&facet=${encodeURIComponent(facet)}`;

        // The default view first; it also reports which windows exist.
        const report = await get<FacetReport>(`/api/themes?${scope}`);
        for (const row of report.rows) themeIds.add(row.id);

        for (const window of report.windows) {
          const scoped = await get<FacetReport>(`/api/themes?${scope}&window=${encodeURIComponent(window)}`);
          for (const row of scoped.rows) themeIds.add(row.id);
        }

        // Every ordered pair the UI's from/to pickers can produce. Quadratic in
        // windows, which are releases — a project with 40 of them costs 1,600
        // small objects, and the alternative is a picker that 404s.
        if (report.windows.length >= 2) {
          await get(`/api/delta?${scope}`);
          for (const from of report.windows) {
            for (const to of report.windows) {
              if (from === to) continue;
              await get(`/api/delta?${scope}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
            }
          }
        }
      }
    }

    const gate = redact ? createPseudonymizer(opts.cfg) : null;
    for (const id of themeIds) {
      const path = `/api/theme/${encodeURIComponent(id)}`;
      const detail = await get<ThemeDetail>(path);
      themes++;
      if (!gate) continue;

      // One redact() call per exemplar: the method resets its numbering every call,
      // which is what gives tokens that are stable inside a trace and
      // meaningless across two — exactly the guarantee the summarizer path has.
      for (const exemplar of detail.exemplars) {
        const { text, counts } = gate.redact(exemplar.trace.text);
        exemplar.trace = { ...exemplar.trace, text };
        if (exemplar.summary !== null) exemplar.summary = gate.redact(exemplar.summary).text;
        for (const [rule, n] of Object.entries(counts)) {
          replacedByRule[rule] = (replacedByRule[rule] ?? 0) + n;
        }
      }
      responses[path] = detail;
    }
  } finally {
    await receiver.close();
  }

  const bundle: Bundle = {
    __sift: STATIC_MARKER,
    generatedAt: new Date().toISOString(),
    redacted: redact,
    responses,
  };

  rmSync(opts.outDir, { recursive: true, force: true });
  mkdirSync(opts.outDir, { recursive: true });

  for (const [path, asset] of assets) {
    // loadUiAssets keys "/" at index.html too; writing it would make a directory.
    if (path === "/") continue;
    const file = join(opts.outDir, path.replace(/^\//, ""));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, asset.body);
  }

  const json = JSON.stringify(bundle);
  writeFileSync(join(opts.outDir, DATA_FILE), json);
  writeFileSync(join(opts.outDir, "vercel.json"), `${JSON.stringify(VERCEL_CONFIG, null, 2)}\n`);

  log(`${assets.size - 1} assets, ${Object.keys(responses).length} endpoints, ${themes} themes`);

  return {
    outDir: opts.outDir,
    assets: assets.size - 1,
    endpoints: Object.keys(responses).length,
    themes,
    redacted: redact,
    replacedByRule,
    bytes: Buffer.byteLength(json),
  };
}

/**
 * Static hosting config, written next to the assets.
 *
 * `cleanUrls`/`trailingSlash` are left alone: the dashboard is a single page and
 * every route below it is client-side, so the only rewrite that matters is the
 * SPA fallback. The headers mirror what `sift serve` already sends, because a
 * published dashboard is the same trace text on a URL other people can reach.
 */
const VERCEL_CONFIG = {
  $schema: "https://openapi.vercel.sh/vercel.json",
  rewrites: [{ source: "/((?!assets/|sift-data\\.json).*)", destination: "/index.html" }],
  headers: [
    {
      source: "/(.*)",
      headers: [
        { key: "x-content-type-options", value: "nosniff" },
        { key: "referrer-policy", value: "no-referrer" },
        { key: "x-frame-options", value: "DENY" },
      ],
    },
    {
      source: "/assets/(.*)",
      headers: [{ key: "cache-control", value: "public, max-age=31536000, immutable" }],
    },
    {
      // The data is a snapshot, but it is replaced on every publish; caching it
      // for a year would mean a redeploy that visibly changes nothing.
      source: `/${DATA_FILE}`,
      headers: [{ key: "cache-control", value: "public, max-age=0, must-revalidate" }],
    },
  ],
};
