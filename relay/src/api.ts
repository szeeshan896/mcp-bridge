import type { IncomingMessage, ServerResponse } from 'node:http';

import { bearerFrom, hashPassword, newId, newToken, signSession, verifyPassword, verifySession } from './auth.js';
import type { Db, TokenKind, User } from './db.js';
import type { DeviceHub } from './hub.js';
import { clientAddress, cookieHeader, originAllowed, parseCookies, parseFields, readBody, sendJson, type RateLimiter } from './http.js';
import { normalizeUsername } from './identity.js';
import { sendToAgent } from './agentSocket.js';

export const SESSION_COOKIE = 'mcpbridge_session';
/** after a correct password, before a correct 2FA code */
export const PENDING_COOKIE = 'mcpbridge_2fa';
export const PENDING_TTL_MS = 10 * 60 * 1000;

export interface ApiContext {
  db: Db;
  hub: DeviceHub;
  sessionSecret: string;
  publicUrl: string | undefined;
  secureCookies: boolean;
  loginLimiter: RateLimiter;
  log: (line: string) => void;
}

export function currentUser(req: IncomingMessage, ctx: ApiContext): User | null {
  const userId = verifySession(parseCookies(req)[SESSION_COOKIE], ctx.sessionSecret);
  return userId ? ctx.db.findUserById(userId) : null;
}

export function setSessionCookie(res: ServerResponse, userId: string, ctx: ApiContext): void {
  res.setHeader('Set-Cookie', [
    cookieHeader(SESSION_COOKIE, signSession(userId, ctx.sessionSecret), { secure: ctx.secureCookies }),
    cookieHeader(PENDING_COOKIE, '', { secure: ctx.secureCookies, maxAgeSeconds: 0 }),
  ]);
}

export function clearSessionCookie(res: ServerResponse, ctx: ApiContext): void {
  res.setHeader('Set-Cookie', cookieHeader(SESSION_COOKIE, '', { secure: ctx.secureCookies, maxAgeSeconds: 0 }));
}

export function setPendingCookie(res: ServerResponse, userId: string, ctx: ApiContext): void {
  res.setHeader(
    'Set-Cookie',
    cookieHeader(PENDING_COOKIE, signSession(userId, ctx.sessionSecret, Date.now(), PENDING_TTL_MS), {
      secure: ctx.secureCookies,
      maxAgeSeconds: PENDING_TTL_MS / 1000,
    }),
  );
}

export function pendingUser(req: IncomingMessage, ctx: ApiContext): User | null {
  const userId = verifySession(parseCookies(req)[PENDING_COOKIE], ctx.sessionSecret);
  return userId ? ctx.db.findUserById(userId) : null;
}

/** What the dashboard shows: who you are, whether your machine is here, which tokens exist. */
export function accountSummary(user: User, ctx: ApiContext) {
  const device = ctx.hub.get(user.id);
  return {
    username: user.username,
    usernameType: user.usernameType,
    hasPassword: user.passwordHash !== null,
    googleLinked: user.googleSub !== null,
    twoFactorEnabled: user.totpEnabledAt !== null,
    recoveryCodesLeft: user.totpEnabledAt !== null ? ctx.db.unusedRecoveryCodeCount(user.id) : 0,
    device: device
      ? { online: true, name: device.name, agentVersion: device.agentVersion, connectedAt: device.connectedAt, agents: device.agents }
      : { online: false },
    tokens: {
      agent: ctx.db.tokenInfo(user.id, 'agent'),
      client: ctx.db.tokenInfo(user.id, 'client'),
    },
  };
}

/** Issues a fresh token of one kind, revoking the previous one — and disconnecting a device still on it. */
export function rotateToken(user: User, kind: TokenKind, ctx: ApiContext): string {
  const { token, hash } = newToken(kind);
  ctx.db.setToken(user.id, kind, hash);
  if (kind === 'agent') {
    const device = ctx.hub.get(user.id);
    if (device) {
      sendToAgent(device.socket, { type: 'goodbye', reason: 'the agent token was regenerated', retry: false });
      device.socket.close(1000, 'token regenerated');
    }
  }
  return token;
}

/**
 * The JSON API behind the dashboard. Everything here is also usable from a script, which
 * is how the tests drive it; the HTML pages are a thin layer over these.
 */
export async function handleApi(req: IncomingMessage, res: ServerResponse, ctx: ApiContext): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://relay');
  if (!url.pathname.startsWith('/api/')) return false;

  if (req.method === 'POST' && !originAllowed(req, ctx.publicUrl)) {
    sendJson(res, 403, { error: 'cross-origin request refused' });
    return true;
  }

  const fields = req.method === 'POST' ? parseFields(await readBody(req), req.headers['content-type']) : {};

  switch (`${req.method} ${url.pathname}`) {
    case 'POST /api/signup': {
      if (!ctx.loginLimiter.allow(clientAddress(req))) return tooMany(res);
      const username = normalizeUsername(fields['username'] ?? '');
      const password = fields['password'] ?? '';
      if (!username) return bad(res, 'enter an email address or a phone number');
      if (password.length < 8) return bad(res, 'the password needs at least 8 characters');
      if (ctx.db.findUserByUsername(username.value)) return bad(res, 'that account already exists — sign in instead', 409);
      const user = ctx.db.createUser({
        id: newId(), username: username.value, usernameType: username.type, passwordHash: hashPassword(password),
      });
      setSessionCookie(res, user.id, ctx);
      sendJson(res, 201, accountSummary(user, ctx));
      return true;
    }

    case 'POST /api/login': {
      if (!ctx.loginLimiter.allow(clientAddress(req))) return tooMany(res);
      const username = normalizeUsername(fields['username'] ?? '');
      const user = username ? ctx.db.findUserByUsername(username.value) : null;
      // the same answer whether the account or the password is wrong
      if (!user || !user.passwordHash || !verifyPassword(fields['password'] ?? '', user.passwordHash)) {
        return bad(res, 'wrong username or password', 401);
      }
      if (user.totpEnabledAt !== null) {
        setPendingCookie(res, user.id, ctx);
        sendJson(res, 200, { twoFactorRequired: true });
        return true;
      }
      setSessionCookie(res, user.id, ctx);
      sendJson(res, 200, accountSummary(user, ctx));
      return true;
    }

    case 'POST /api/logout':
      clearSessionCookie(res, ctx);
      sendJson(res, 200, { ok: true });
      return true;

    case 'GET /api/me': {
      const user = currentUser(req, ctx);
      if (!user) return bad(res, 'not signed in', 401);
      sendJson(res, 200, accountSummary(user, ctx));
      return true;
    }

    case 'POST /api/tokens/agent':
    case 'POST /api/tokens/client': {
      const user = currentUser(req, ctx);
      if (!user) return bad(res, 'not signed in', 401);
      const kind: TokenKind = url.pathname.endsWith('agent') ? 'agent' : 'client';
      const token = rotateToken(user, kind, ctx);
      sendJson(res, 200, { kind, token, note: 'shown once — store it now; regenerating replaces it' });
      return true;
    }

    default:
      sendJson(res, 404, { error: 'no such endpoint' });
      return true;
  }
}

function bad(res: ServerResponse, error: string, status = 400): true {
  sendJson(res, status, { error });
  return true;
}

function tooMany(res: ServerResponse): true {
  sendJson(res, 429, { error: 'too many attempts; wait a minute' });
  return true;
}

export { bearerFrom };
