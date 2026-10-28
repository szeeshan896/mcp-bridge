import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

import type { TokenKind } from './db.js';

// ---- passwords -------------------------------------------------------------

const SCRYPT_N = 16384;
const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, { N: Number(n) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---- tokens ----------------------------------------------------------------

const PREFIX: Record<TokenKind, string> = { agent: 'mba_', client: 'mbc_' };

/** A fresh token and the hash that gets stored. The token itself is never stored. */
export function newToken(kind: TokenKind): { token: string; hash: string } {
  const token = PREFIX[kind] + randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The kind a token claims to be, from its prefix, so the lookup hits the right row. */
export function tokenKind(token: string): TokenKind | null {
  if (token.startsWith(PREFIX.agent)) return 'agent';
  if (token.startsWith(PREFIX.client)) return 'client';
  return null;
}

export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

// ---- sessions --------------------------------------------------------------

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** userId.expiry.signature — nothing stored server-side, nothing readable client-side. */
export function signSession(userId: string, secret: string, now = Date.now(), ttlMs = SESSION_TTL_MS): string {
  const expiry = String(now + ttlMs);
  const body = `${userId}.${expiry}`;
  return `${body}.${sign(body, secret)}`;
}

export function verifySession(cookie: string | undefined, secret: string, now = Date.now()): string | null {
  if (!cookie) return null;
  const parts = cookie.split('.');
  if (parts.length !== 3) return null;
  const [userId, expiry, signature] = parts as [string, string, string];
  const expected = sign(`${userId}.${expiry}`, secret);
  if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    return null;
  }
  if (Number(expiry) < now) return null;
  return userId;
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function newId(): string {
  return randomUUID();
}
