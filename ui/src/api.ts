import { useEffect, useState } from "react";

import type { DeltaReport } from "../../src/delta/index.ts";
import type { FacetReport, ThemeRow } from "../../src/report/model.ts";
import type { Exemplar, ThemeDetail } from "../../src/serve/api.ts";

/**
 * The contract with the server, imported rather than restated.
 *
 * These are the same interfaces `sift report --json` fills in, so the dashboard
 * cannot drift from the CLI by a field: adding one to FacetReport and forgetting
 * it here is a type error, not a blank column somebody notices in a demo.
 */
export type { DeltaReport, Exemplar, FacetReport, ThemeDetail, ThemeRow };

/** /api/meta: what the agent and facet pickers are allowed to ask for. */
export interface Meta {
  agents: string[];
  facets: string[];
  dbPath: string;
}

/**
 * The bearer, when there is one.
 *
 * `sift serve --token` guards /api but not this page — a browser cannot attach
 * an Authorization header to a navigation — so the token arrives as `?token=`,
 * moves into sessionStorage, and is scrubbed from the address bar before it can
 * be pasted into a bug report or land in someone's history. sessionStorage and
 * not localStorage: a shared secret that outlives the tab is a secret nobody
 * remembers leaving behind.
 */
const TOKEN_KEY = "sift.token";

function adoptTokenFromUrl(): void {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (token === null) return;
  sessionStorage.setItem(TOKEN_KEY, token);
  url.searchParams.delete("token");
  window.history.replaceState(null, "", url.toString());
}
adoptTokenFromUrl();

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

/** A 401 the caller can branch on without matching a message. */
export class Unauthorized extends Error {}

/**
 * The published-snapshot bundle, when this page is a static export.
 *
 * `sift publish` writes every response the live API would have given into one
 * file, so a static host — Vercel, S3, a Pages branch — can serve the dashboard
 * with no server and no database behind it. One build covers both cases: the
 * bundle is simply what a live `sift serve` does not have.
 *
 * The marker check is not paranoia. A static host's SPA fallback answers any
 * unknown path with index.html and a 200, so "the fetch succeeded" proves
 * nothing — without it a missing bundle parses as HTML, throws somewhere
 * further in, and reads as a data bug rather than a missing file.
 */
const STATIC_MARKER = "sift-static-export";

interface StaticBundle {
  __sift: string;
  generatedAt: string;
  redacted: boolean;
  responses: Record<string, unknown>;
}

let staticBundle: StaticBundle | null = null;

const staticReady: Promise<void> = fetch("sift-data.json")
  .then((res) => (res.ok ? (res.json() as Promise<unknown>) : null))
  .then((body) => {
    const bundle = body as StaticBundle | null;
    if (bundle && bundle.__sift === STATIC_MARKER) staticBundle = bundle;
  })
  .catch(() => {
    // No bundle means a live server, which is the normal `sift serve` case.
  });

/** Snapshot provenance, or null when this page is talking to a live server. */
export function staticSnapshot(): { generatedAt: string; redacted: boolean } | null {
  return staticBundle === null ? null : { generatedAt: staticBundle.generatedAt, redacted: staticBundle.redacted };
}

async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  await staticReady;
  if (staticBundle !== null) {
    const body = staticBundle.responses[path];
    // Published bundles are enumerated from the API's own answers, so a miss is
    // a stale snapshot rather than a bad request — say which, since "404" from
    // a page that has no server behind it is a confusing thing to read.
    if (body === undefined) {
      throw new Error(`${path} is not in this published snapshot (generated ${staticBundle.generatedAt})`);
    }
    return body as T;
  }

  const token = sessionStorage.getItem(TOKEN_KEY);
  const res = await fetch(path, {
    signal,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new Unauthorized("this sift server was started with --token");
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    // The API's rejections are written to be read by a person — "no window
    // "v9.9" for support-bot/goal; known: v1.2, v1.3" — so they are shown
    // verbatim rather than replaced with a generic failure line.
    const error = (body as { error?: string } | null)?.error;
    throw new Error(error ?? `${path} failed with ${res.status}`);
  }
  return body as T;
}

export interface Query<T> {
  data?: T;
  error?: string;
  unauthorized: boolean;
  loading: boolean;
}

/**
 * One GET, refetched whenever the path changes.
 *
 * The abort on unmount is what stops a fast click through three themes from
 * settling in the wrong order and painting the first one's traces under the
 * third one's heading.
 */
export function useApi<T>(path: string | null): Query<T> {
  const [state, setState] = useState<Query<T>>({ loading: path !== null, unauthorized: false });

  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    setState({ loading: true, unauthorized: false });
    getJson<T>(path, controller.signal).then(
      (data) => setState({ data, loading: false, unauthorized: false }),
      (err: Error) => {
        if (controller.signal.aborted) return;
        setState({ error: err.message, loading: false, unauthorized: err instanceof Unauthorized });
      },
    );
    return () => controller.abort();
  }, [path]);

  return state;
}

/** `?a=1&b=2` with the empty values dropped, so a default never becomes a filter. */
export function qs(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}
