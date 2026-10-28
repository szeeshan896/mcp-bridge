import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY = 64 * 1024;

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** JSON or form-encoded, whichever the client sent; both become a flat string map. */
export function parseFields(body: string, contentType: string | undefined): Record<string, string> {
  if (!body) return {};
  if (contentType?.includes('application/json')) {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v ?? '')]));
  }
  return Object.fromEntries(new URLSearchParams(body));
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  res.end(html);
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location });
  res.end();
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  secure: boolean;
}

export function cookieHeader(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${options.maxAgeSeconds ?? 30 * 24 * 60 * 60}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** The caller's address, honouring the first hop of X-Forwarded-For behind a proxy. */
export function clientAddress(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

/**
 * Cross-site request forgery guard for cookie-authenticated POSTs. Browsers send Origin
 * on every POST, so a present-but-foreign Origin is an attack; an absent one is a script
 * or a test, which cookies alone could not have authenticated anyway.
 */
export function originAllowed(req: IncomingMessage, publicUrl: string | undefined): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!publicUrl) return true;
  try {
    return new URL(origin).origin === new URL(publicUrl).origin;
  } catch {
    return false;
  }
}

/** A small fixed-window limiter, enough to blunt password guessing on a single instance. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.max;
  }
}
