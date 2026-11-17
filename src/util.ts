// Small shared HTTP helpers: JSON answers, body reading, request ids.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** One monotonically increasing request counter (the request-id suffix). */
let requestCounter = 0;

/** A non-empty request id for every reply (X-GitHub-Request-Id). */
export function requestId(): string {
  requestCounter += 1;
  return `${Date.now().toString(36)}-${requestCounter.toString(36)}-${randomUUID().slice(0, 8)}`;
}

/** Answer with a JSON body and the headers every reply carries. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const all: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId(),
    ...headers,
  };
  if (status !== 204) all['content-length'] = String(Buffer.byteLength(text));
  try {
    res.writeHead(status, all);
    res.end(text);
  } catch {
    // The peer went away; nothing to write to.
  }
}

/** The JSON error body GitHub uses: {"message": string}. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** The path of a request URL, or '/' when it does not parse (never a throw). */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The query of a request URL, or an empty map when it does not parse. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Read a request body whole, up to `maxBytes` (0 = unlimited within reason). */
export async function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Parse a request body as JSON; `undefined` when there is no body, throws on malformed JSON. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (raw.length === 0) return undefined;
  return JSON.parse(raw.toString('utf8')) as unknown;
}

/** Decode one URL path segment (percent-decoding); the raw segment when it does not decode. */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split a path into its decoded segments, dropping empty ones. */
export function splitPath(path: string): string[] {
  return path.split('/').filter((part) => part !== '').map(decodeSegment);
}

/** The current time as an ISO-8601 string. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** The current Unix time in seconds. */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
