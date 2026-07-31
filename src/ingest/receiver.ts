import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync, inflateSync } from "node:zlib";

import { normalizeSpans, type OtlpSpan } from "./otlp.ts";
import type { PendingSpan, SiftStore } from "../store/db.ts";

/**
 * OTLP/HTTP receiver: sift as a collector target rather than a file reader.
 *
 * **JSON encoding only.** A protobuf decoder is several hundred lines of
 * hot-path parsing to maintain forever against a spec that moves, and sift
 * ships zero runtime dependencies, so the cost goes to the user as one env var
 * instead. The SDK default is `http/protobuf`, which means nearly every first
 * run lands on that path — so it is the most carefully written response here:
 * 415 (non-retryable per the OTLP spec, so a conforming exporter drops the
 * batch and logs rather than hot-looping) naming the variable to set.
 *
 * Spans are staged, not assembled: see `pending.ts` for why. Staging in SQLite
 * rather than in memory is what makes the 200 honest — an ack followed by a
 * restart that loses the batch is a lie to the exporter.
 *
 * ponytail: one synchronous SQLite writer, one INSERT per span, and the handler
 * blocks the event loop while writing — roughly 10^4 spans/s, which is a laptop
 * or a single service, not a collector fan-in. Past that, batch the requests
 * themselves into one transaction.
 */

export const DEFAULT_PORT = 4318;
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

const PROTOBUF_HELP =
  "sift receives OTLP/JSON only. Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json " +
  "(this build ships no protobuf decoder because sift has zero runtime dependencies).";

export interface ReceiverOptions {
  store: SiftStore;
  /** default 127.0.0.1: an unauthenticated trace sink on 0.0.0.0 is an exfil surface */
  host?: string;
  /** 0 binds an ephemeral port, which is what tests want */
  port?: number;
  maxBodyBytes?: number;
  /** when set, requests must carry `Authorization: Bearer <token>` */
  token?: string;
  log?: (message: string) => void;
}

export interface Receiver {
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startReceiver(opts: ReceiverOptions): Promise<Receiver> {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const log = opts.log ?? (() => {});

  const server = createServer((req, res) => {
    handle(req, res, opts.store, maxBodyBytes, opts.token).catch((err: Error) => {
      // A bug in sift must never cost the exporter its spans, so this is 503
      // (retryable) rather than 500, and it says so out loud.
      log(`receiver error: ${err.message}`);
      if (!res.headersSent) send(res, 503, { error: `sift receiver failed: ${err.message}` }, { "retry-after": "1" });
    });
  });

  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? DEFAULT_PORT;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  return {
    port: boundPort,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${boundPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Keep-alive sockets would otherwise hold the process open long after
        // close() resolved — a test run that hangs instead of finishing.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: SiftStore,
  maxBodyBytes: number,
  token: string | undefined,
): Promise<void> {
  const path = (req.url ?? "/").split("?")[0];

  // Left unauthenticated on purpose: a liveness probe that needs a secret is a
  // liveness probe nobody wires up.
  if (path === "/healthz") return send(res, 200, { status: "ok", pendingSpans: store.countPendingSpans() });

  if (path === "/v1/metrics" || path === "/v1/logs") {
    return send(res, 404, {
      error: `sift receives traces only; point only the trace exporter at it (OTEL_TRACES_EXPORTER=otlp)`,
    });
  }
  if (path !== "/v1/traces") {
    return send(res, 404, { error: `no such endpoint ${path}; sift accepts OTLP/JSON traces at POST /v1/traces` });
  }
  if (req.method !== "POST") {
    return send(res, 405, { error: `${req.method} not allowed; POST OTLP/JSON to /v1/traces` }, { allow: "POST" });
  }
  if (token !== undefined && !tokenMatches(bearer(req), token)) {
    return send(res, 401, { error: "missing or wrong bearer token" }, { "www-authenticate": "Bearer" });
  }

  const receivedAt = new Date().toISOString();
  const raw = await readCappedBody(req, maxBodyBytes);
  if (raw === null) {
    return send(
      res,
      413,
      { error: `body over the ${maxBodyBytes} byte limit; lower the exporter's batch size or raise --max-body` },
      { connection: "close" },
    );
  }

  const encoding = String(req.headers["content-encoding"] ?? "").trim().toLowerCase();
  let body: Buffer;
  try {
    if (encoding === "" || encoding === "identity") body = raw;
    else if (encoding === "gzip") body = gunzipSync(raw);
    else if (encoding === "deflate") body = inflateSync(raw);
    else return send(res, 415, { error: `unsupported content-encoding "${encoding}"; sift accepts gzip or deflate` });
  } catch (err) {
    return send(res, 400, { error: `could not decompress a ${encoding} body: ${(err as Error).message}` });
  }

  if (/protobuf/i.test(String(req.headers["content-type"] ?? ""))) {
    return send(res, 415, { error: PROTOBUF_HELP });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch (err) {
    // Sniffing after the parse failure, not before: an ExportTraceServiceRequest
    // in protobuf starts with 0x0a (field 1, LEN), but so does a JSON body with
    // a leading newline, and telling that caller to set http/json when they
    // already did would be the worst error in this file.
    if (body[0] === 0x0a) return send(res, 415, { error: PROTOBUF_HELP });
    return send(res, 400, { error: `body is not valid JSON: ${(err as Error).message}` });
  }

  const envelope = parsed as Record<string, unknown> | null;
  const resourceSpans = envelope && (envelope.resourceSpans ?? envelope.resource_spans);
  if (!Array.isArray(resourceSpans)) {
    return send(res, 400, { error: "expected an ExportTraceServiceRequest with a resourceSpans array" });
  }

  const { spans, rejected } = normalizeSpans(parsed);
  if (spans.length > 0) store.stagePendingSpans(spans.map((s) => toPendingSpan(s, receivedAt)));

  // Partial success rather than 400: a 400 makes the exporter drop the whole
  // batch, good spans included, and it has nowhere to put them afterwards.
  if (rejected === 0) return send(res, 200, { partialSuccess: {} });
  return send(res, 200, {
    partialSuccess: {
      // proto3 JSON encodes int64 as a string, and collectors parse it as one.
      rejectedSpans: String(rejected),
      errorMessage: `${rejected} span(s) carried no trace id and were dropped; the rest were accepted`,
    },
  });
}

function toPendingSpan(span: OtlpSpan, receivedAt: string): PendingSpan {
  const serialized = JSON.stringify(span);
  return {
    traceId: span.traceId,
    // The exporter retries whole batches, so the key must be stable per span:
    // its id when it has one, its content when it does not.
    spanKey: span.spanId ?? createHash("sha256").update(serialized).digest("hex").slice(0, 32),
    receivedAt,
    span: serialized,
  };
}

/** Compared through a hash so the check is constant-time and length-agnostic. */
function tokenMatches(offered: string | undefined, expected: string): boolean {
  if (offered === undefined) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(offered), digest(expected));
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * The body, or null once it passes the cap.
 *
 * It stops accumulating at the limit rather than buffering the whole upload and
 * checking afterwards — the cap exists to bound memory, and a check that runs
 * after the allocation does not.
 */
function readCappedBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        chunks.length = 0;
        req.resume(); // drain the rest into nothing so the response can still go out
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers });
  res.end(payload);
}
