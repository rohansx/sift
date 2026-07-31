import type { ServerResponse } from "node:http";

/**
 * The two things every part of sift's HTTP surface has to agree on.
 *
 * `send` is shared rather than copied because the receiver's error shape is a
 * contract — an exporter reads `{error}` off a 415 the same way the dashboard
 * reads it off a 404 — and two copies of a four-line function is exactly how
 * one of them quietly grows a different key.
 */
export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

/** Whether an address is reachable only from this machine. The whole /8, because 127.0.0.2 is as local as .1. */
export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Whether the *name the client used* is a loopback name — which is a different
 * question from where the socket is bound, and the only one that catches DNS
 * rebinding.
 *
 * A page on evil.test can re-point that name at 127.0.0.1 and then read this
 * server as its own origin: no preflight, no CORS header needed, and the bind
 * address is still loopback. What the attacker cannot change is the Host header
 * the browser must send to reach the rebound name. Missing Host fails closed —
 * HTTP/1.1 requires one, so its absence is a hand-written request, not a browser.
 */
export function hostHeaderIsLoopback(host: string | undefined): boolean {
  if (host === undefined) return false;
  // `[::1]:4318` -> `::1`, `127.0.0.1:4318` -> `127.0.0.1`; a bare IPv6 without
  // brackets is not legal in a Host header, so splitting on ":" is safe here.
  const hostname = /^\[(.+)\]/.exec(host)?.[1] ?? host.split(":")[0]!;
  return isLoopback(hostname);
}
