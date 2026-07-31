import type { IncomingMessage, ServerResponse } from "node:http";

import type { Pipeline } from "../pipeline.ts";
import type { Theme, Trace } from "../types.ts";
import { send } from "./http.ts";

/**
 * The dashboard's read side, mounted on the receiver `sift serve` already runs.
 *
 * Every endpoint is a thin JSON wrapper over the same call the CLI makes:
 * `pipeline.report()` for the issues list, `pipeline.delta()` for the diff,
 * `store.getTheme/getTrace/getSummary` for a theme page. Nothing here derives a
 * share, a delta or a sigma of its own — a second implementation of "count
 * assignments and divide" is how `sift report` and the browser end up showing
 * two different numbers for the same window, and neither one is obviously the
 * wrong one when they do.
 *
 * The response bodies are therefore exactly what `--json` already emits, which
 * is also why there is no envelope: the UI can import the FacetReport and
 * DeltaReport types straight from src/ and cannot drift from them.
 *
 * GET only. There is no write path here on purpose — a resolve/mute button
 * would need CSRF thinking, and the CLI already has those commands.
 */

/**
 * How much of an exemplar trace goes over the wire.
 *
 * Trace text is a whole flattened span tree and can be megabytes. The cap is
 * server-side rather than a CSS overflow because the cost is the transfer, and
 * `fullTextLength` is sent alongside so the UI can say what it is not showing
 * instead of silently presenting a fragment as the trace.
 */
export const MAX_TRACE_TEXT = 8000;

/** Never cached: a window's numbers change under you as traces settle. */
const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

const ROUTES = "/api/meta, /api/themes, /api/theme/<id> and /api/delta";

export function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pipeline: Pipeline,
  path: string,
  query: URLSearchParams,
): void {
  if (req.method !== "GET") {
    return send(res, 405, { error: `${req.method} not allowed; the dashboard API is read-only` }, { allow: "GET" });
  }

  if (path === "/api/meta") {
    return send(
      res,
      200,
      { agents: pipeline.agents(), facets: pipeline.facets.map((f) => f.name), dbPath: pipeline.cfg.dbPath },
      NO_STORE,
    );
  }

  // Theme ids are registry-issued (`SIFT-14`), so the segment is used raw: not
  // decoding it means a percent-mangled id simply misses the lookup and 404s,
  // instead of decodeURIComponent throwing on a malformed escape and turning a
  // typo in the address bar into a 503.
  const theme = /^\/api\/theme\/([^/]+)$/.exec(path);
  if (theme) return sendTheme(res, pipeline, theme[1]!);

  if (path === "/api/themes" || path === "/api/delta") {
    const scope = resolveScope(res, pipeline, query);
    if (!scope) return;
    const windows = pipeline.store.windowsForFacet(scope.agentId, scope.facet);
    return path === "/api/themes"
      ? sendThemes(res, pipeline, scope, windows, query.get("window"))
      : sendDelta(res, pipeline, scope, windows, query.get("from"), query.get("to"));
  }

  return send(res, 404, { error: `no such endpoint ${path}; the dashboard API is ${ROUTES}` });
}

function sendThemes(
  res: ServerResponse,
  pipeline: Pipeline,
  scope: Scope,
  windows: string[],
  window: string | null,
): void {
  // A window nobody has traffic in would report zero of everything, which reads
  // as "this release was clean" rather than "you asked for a window that does
  // not exist". Refusing is the only honest answer.
  if (window !== null && !windows.includes(window)) {
    return send(res, 404, { error: `no window ${JSON.stringify(window)} for ${describe(scope)}; ${listing(windows)}` });
  }
  const opts: { agentId: string; facet: string; window?: string } = { ...scope };
  if (window !== null) opts.window = window;
  return send(res, 200, pipeline.report(opts)[0], NO_STORE);
}

function sendDelta(
  res: ServerResponse,
  pipeline: Pipeline,
  scope: Scope,
  windows: string[],
  from: string | null,
  to: string | null,
): void {
  const pair = from !== null && to !== null ? { from, to } : pipeline.latestWindowPair(scope.agentId, scope.facet);
  if (!pair) {
    return send(res, 404, {
      error: `${describe(scope)} has ${windows.length} window(s), so there is nothing to diff yet`,
    });
  }
  for (const w of [pair.from, pair.to]) {
    if (!windows.includes(w)) {
      return send(res, 404, { error: `no window ${JSON.stringify(w)} for ${describe(scope)}; ${listing(windows)}` });
    }
  }
  return send(res, 200, pipeline.delta(scope.agentId, scope.facet, pair.from, pair.to), NO_STORE);
}

function sendTheme(res: ServerResponse, pipeline: Pipeline, themeId: string): void {
  const stored = pipeline.store.getTheme(themeId);
  if (!stored) return send(res, 404, { error: `no such theme ${themeId}` });

  // The centroid stays on the server. It is 1,536 floats with an embedding
  // model the size of the default one — several times the capped trace text
  // next to it — and there is nothing a reader can do with a coordinate.
  const { centroid: _centroid, ...theme } = stored;

  // `sift show --json` returns the theme and its exemplar traces; this adds the
  // facet summary per exemplar, which is the line the theme was clustered on
  // and the only part a reader can check the label against.
  const exemplars: Exemplar[] = [];
  for (const id of theme.exemplarTraceIds) {
    const trace = pipeline.store.getTrace(id);
    if (!trace) continue;
    const summary = pipeline.store.getSummary(id, theme.facet);
    const truncated = trace.text.length > MAX_TRACE_TEXT;
    exemplars.push({
      trace: truncated ? { ...trace, text: trace.text.slice(0, MAX_TRACE_TEXT) } : trace,
      fullTextLength: trace.text.length,
      truncated,
      summary: summary ? summary.summary : null,
    });
  }
  const detail: ThemeDetail = { theme, exemplars };
  return send(res, 200, detail, NO_STORE);
}

/** A theme page: everything `sift show` prints, and nothing the browser cannot use. */
export interface ThemeDetail {
  theme: Omit<Theme, "centroid">;
  exemplars: Exemplar[];
}

/** One exemplar trace, its facet line, and how much of its text was withheld. */
export interface Exemplar {
  trace: Trace;
  fullTextLength: number;
  truncated: boolean;
  summary: string | null;
}

interface Scope {
  agentId: string;
  facet: string;
}

/**
 * Which agent and facet the caller means, defaulting the way the CLI does.
 *
 * Sends its own 404 and returns null rather than throwing, so the caller is one
 * `if`. Every rejection lists the valid values: "no agent x" without them just
 * moves the guessing to the next request.
 */
function resolveScope(res: ServerResponse, pipeline: Pipeline, query: URLSearchParams): Scope | null {
  const agents = pipeline.agents();
  const agentId = query.get("agent") ?? agents[0];
  if (agentId === undefined) {
    send(res, 404, { error: `no traces in ${pipeline.cfg.dbPath} yet; run \`sift analyze\` first` });
    return null;
  }
  if (!agents.includes(agentId)) {
    send(res, 404, { error: `no agent ${JSON.stringify(agentId)}; ${listing(agents)}` });
    return null;
  }

  const facets = pipeline.facets.map((f) => f.name);
  const facet = query.get("facet") ?? facets[0]!;
  if (!facets.includes(facet)) {
    send(res, 404, { error: `no facet ${JSON.stringify(facet)}; the configured facets are ${facets.join(", ")}` });
    return null;
  }
  return { agentId, facet };
}

const describe = (scope: Scope) => `${scope.agentId}/${scope.facet}`;

const listing = (values: string[]) => (values.length === 0 ? "this database has none" : `known: ${values.join(", ")}`);
