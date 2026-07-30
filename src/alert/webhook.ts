import type { SiftStore } from "../store/db.ts";
import type { ThemeState } from "../types.ts";

/**
 * Webhook alerting on the two transitions worth waking someone for: a theme
 * appearing for the first time, and a theme that had been marked resolved
 * picking traffic back up.
 *
 * The important machinery here is deduplication, not delivery. A cron on an
 * hourly schedule would otherwise page twenty-four times for one regression,
 * and an alert that fires repeatedly for an unchanged fact is one people learn
 * to filter into a folder.
 */

export type AlertEvent = "new" | "regressed";

export interface Alert {
  agentId: string;
  facet: string;
  themeId: string;
  event: AlertEvent;
  label: string;
  description: string;
  state: ThemeState;
  /** the window that triggered it */
  window: string;
  count: number;
  share: number;
}

export interface PendingAlertOptions {
  agentId: string;
  facet: string;
  on: readonly AlertEvent[];
}

/**
 * Alerts that have not been delivered yet.
 *
 * Deliberately based on theme state rather than a delta: a first window has
 * nothing to diff against, but a newly discovered theme is still worth saying
 * out loud.
 */
export function pendingAlerts(store: SiftStore, opts: PendingAlertOptions): Alert[] {
  const stats = store.themeCountsByWindow(opts.agentId, opts.facet);
  const latest = stats.windows[stats.windows.length - 1];
  if (!latest) return [];

  const total = stats.totals.get(latest) ?? 0;
  const counts = stats.counts.get(latest) ?? new Map<string, number>();
  const out: Alert[] = [];

  for (const theme of store.themesForFacet(opts.agentId, opts.facet)) {
    const event = eventFor(theme.state, theme.firstWindow, theme.lastSeenWindow, latest);
    if (!event || !opts.on.includes(event)) continue;
    if (alreadyAlerted(store, opts.agentId, theme.id, event, latest)) continue;

    const count = counts.get(theme.id) ?? 0;
    out.push({
      agentId: opts.agentId,
      facet: opts.facet,
      themeId: theme.id,
      event,
      label: theme.label,
      description: theme.description,
      state: theme.state,
      window: latest,
      count,
      share: total === 0 ? 0 : count / total,
    });
  }
  return out;
}

function eventFor(
  state: ThemeState,
  firstWindow: string | undefined,
  lastSeenWindow: string | undefined,
  latest: string,
): AlertEvent | null {
  // "regressed" is checked first: a theme can be both freshly seen and a
  // regression, and the regression is the more urgent thing to say.
  if (state === "regressed" && lastSeenWindow === latest) return "regressed";
  if (state === "new" && firstWindow === latest) return "new";
  return null;
}

function alertKey(agentId: string, themeId: string, event: AlertEvent, window: string): string {
  return `alert:${agentId}:${themeId}:${event}:${window}`;
}

function alreadyAlerted(store: SiftStore, agentId: string, themeId: string, event: AlertEvent, window: string): boolean {
  return store.getMeta(alertKey(agentId, themeId, event, window)) !== undefined;
}

/**
 * Record that these alerts went out. Keyed by window, so the same theme
 * regressing again next release is a fresh alert rather than silence.
 */
export function markAlerted(store: SiftStore, alerts: Alert[], at = new Date()): void {
  store.transaction(() => {
    for (const a of alerts) {
      store.setMeta(alertKey(a.agentId, a.themeId, a.event, a.window), at.toISOString());
    }
  });
}

export interface WebhookOptions {
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeliveryResult {
  delivered: number;
  error?: string;
}

export class WebhookAlerter {
  private url: string;
  private fetchImpl: typeof fetch;
  private headers: Record<string, string>;
  private maxRetries: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(url: string, opts: WebhookOptions = {}) {
    this.url = url;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.headers = opts.headers ?? {};
    this.maxRetries = opts.maxRetries ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Posts one payload containing every alert. Never throws: a notification that
   * could not be delivered must not fail the analysis run that produced it —
   * the findings are already safely in the database either way.
   */
  async send(alerts: Alert[]): Promise<DeliveryResult> {
    if (alerts.length === 0) return { delivered: 0 };

    const body = JSON.stringify({
      source: "sift",
      sentAt: new Date().toISOString(),
      alerts,
    });

    let lastError = "";
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(Math.min(500 * 2 ** (attempt - 1), 4000));
      try {
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...this.headers },
          body,
        });
        if (res.ok) return { delivered: alerts.length };
        lastError = `webhook HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
        if (res.status < 500 && res.status !== 429) break; // a 4xx will stay a 4xx
      } catch (err) {
        lastError = (err as Error).message;
      }
    }
    return { delivered: 0, error: lastError };
  }
}
