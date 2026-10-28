import type { IncomingMessage, ServerResponse } from 'node:http';

import { bearerFrom, hashPassword, hashToken, newId, newToken, signSession, verifyPassword, verifySession } from './auth.js';
import type { Db, TokenKind, User } from './db.js';
import type { DeviceHub } from './hub.js';
import type { ResolvedClient } from './oauth.js';
import { clientAddress, cookieHeader, originAllowed, parseCookies, parseFields, readBody, sendJson, type RateLimiter } from './http.js';
import { normalizeUsername } from './identity.js';
import { sendToAgent } from './agentSocket.js';
import { newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, otpauthUri, verifyTotp } from './totp.js';
import { toString as qrToString } from 'qrcode';

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
  /** blunts junk OAuth client registrations, which anyone may make */
  oauthLimiter: RateLimiter;
  /** the last TOTP counter each user passed with, so a code cannot be replayed inside its window */
  totpUsed: Map<string, number>;
  /** fetches an OAuth client's metadata document; replaced in tests */
  fetchImpl: typeof fetch;
  /** metadata documents already fetched, by client_id */
  clientDocuments: Map<string, { client: ResolvedClient; expiresAt: number }>;
  log: (line: string) => void;
}

/**
 * Accepts an authenticator code or a recovery code for a user with 2FA on. A TOTP counter
 * is remembered so the same code is refused a second time; a recovery code is burned.
 */
export function passesSecondFactor(user: User, input: string, ctx: ApiContext): boolean {
  if (!user.totpSecret || user.totpEnabledAt === null) return false;
  const counter = verifyTotp(user.totpSecret, input);
  if (counter !== null) {
    if ((ctx.totpUsed.get(user.id) ?? -1) >= counter) return false;
    ctx.totpUsed.set(user.id, counter);
    return true;
  }
  const normalized = normalizeRecoveryCode(input);
  return normalized.length === 8 && ctx.db.consumeRecoveryCode(user.id, hashToken(normalized));
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
      ? { online: true as const, name: device.name, agentVersion: device.agentVersion, connectedAt: device.connectedAt, agents: device.agents }
      : { online: false as const },
    tokens: {
      agent: ctx.db.tokenInfo(user.id, 'agent'),
      client: ctx.db.tokenInfo(user.id, 'client'),
    },
    // clients that connected through OAuth -- claude.ai, Claude Code and the like
    connectedApps: ctx.db.listOAuthGrants(user.id).map((g) => ({
      id: g.id, name: g.clientName, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt,
    })),
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

    case 'POST /api/login/2fa': {
      if (!ctx.loginLimiter.allow(clientAddress(req))) return tooMany(res);
      const user = pendingUser(req, ctx);
      if (!user) return bad(res, 'sign in with your password first', 401);
      if (!passesSecondFactor(user, fields['code'] ?? '', ctx)) return bad(res, 'that code is not right', 401);
      setSessionCookie(res, user.id, ctx);
      sendJson(res, 200, accountSummary(user, ctx));
      return true;
    }

    case 'POST /api/logout':
      clearSessionCookie(res, ctx);
      sendJson(res, 200, { ok: true });
      return true;

    case 'POST /api/2fa/setup': {
      const user = currentUser(req, ctx);
      if (!user) return bad(res, 'not signed in', 401);
      if (user.totpEnabledAt !== null) return bad(res, '2-step verification is already on', 409);
      const secret = newTotpSecret();
      ctx.db.setTotp(user.id, secret, null);
      const otpauth = otpauthUri(secret, user.username);
      const qrSvg = await qrToString(otpauth, { type: 'svg', margin: 1 });
      sendJson(res, 200, { secret, otpauth, qrSvg });
      return true;
    }

    case 'POST /api/2fa/enable': {
      const user = currentUser(req, ctx);
      if (!user) return bad(res, 'not signed in', 401);
      if (user.totpEnabledAt !== null) return bad(res, '2-step verification is already on', 409);
      if (!user.totpSecret) return bad(res, 'start setup first');
      const counter = verifyTotp(user.totpSecret, fields['code'] ?? '');
      if (counter === null) return bad(res, 'that code is not right — check the time on your phone', 401);
      ctx.totpUsed.set(user.id, counter);
      ctx.db.setTotp(user.id, user.totpSecret, Date.now());
      const recoveryCodes = newRecoveryCodes();
      ctx.db.replaceRecoveryCodes(user.id, recoveryCodes.map((c) => hashToken(normalizeRecoveryCode(c))));
      sendJson(res, 200, { enabled: true, recoveryCodes, note: 'shown once — keep these somewhere safe' });
      return true;
    }

    case 'POST /api/2fa/disable': {
      const user = currentUser(req, ctx);
      if (!user) return bad(res, 'not signed in', 401);
      if (user.totpEnabledAt === null) return bad(res, '2-step verification is not on');
      if (!passesSecondFactor(user, fields['code'] ?? '', ctx)) return bad(res, 'a current code is needed to turn it off', 401);
      ctx.db.setTotp(user.id, null, null);
      ctx.db.replaceRecoveryCodes(user.id, []);
      ctx.totpUsed.delete(user.id);
      sendJson(res, 200, { enabled: false });
      return true;
    }

    case 'POST /api/2fa/recovery-codes': {
      const user = currentUser(req, ctx);
      if (!user) return bad(res, 'not signed in', 401);
      if (user.totpEnabledAt === null) return bad(res, '2-step verification is not on');
      if (!passesSecondFactor(user, fields['code'] ?? '', ctx)) return bad(res, 'a current code is needed', 401);
      const recoveryCodes = newRecoveryCodes();
      ctx.db.replaceRecoveryCodes(user.id, recoveryCodes.map((c) => hashToken(normalizeRecoveryCode(c))));
      sendJson(res, 200, { recoveryCodes, note: 'the previous codes no longer work' });
      return true;
    }

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

    case 'POST /api/oauth/revoke': {
      const user = currentUser(req, ctx);
      if (!user) return bad(res, 'not signed in', 401);
      const id = fields['id'] ?? '';
      if (!ctx.db.revokeOAuthGrant(id, user.id)) return bad(res, 'no such connected app', 404);
      sendJson(res, 200, { revoked: true });
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
