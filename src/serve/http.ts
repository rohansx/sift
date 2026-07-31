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

/** Whether a bind address is reachable only from this machine. */
export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
