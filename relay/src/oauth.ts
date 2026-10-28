import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { currentUser, type ApiContext } from './api.js';
import { hashToken, newId } from './auth.js';
import type { Db, OAuthGrant } from './db.js';
import { baseUrl, clientAddress, originAllowed, parseFields, readBody, redirect, sendHtml, sendJson } from './http.js';
import { esc, page } from './web.js';

/**
 * The relay as an OAuth 2.1 authorization server for its own MCP endpoint.
 *
 * <p>This is what lets claude.ai — web, desktop app and phone — connect: those clients do
 * not take a pasted bearer token, they discover an authorization server from the MCP
 * endpoint's 401, register themselves (RFC 7591) or present a Client ID Metadata Document,
 * send the person here to approve, and exchange the code for tokens with PKCE. Claude Code
 * and other MCP clients use the same flow, so a client token is no longer the only way in.
 *
 * <p>What is deliberately small: one scope, one resource, public clients (no secret needed,
 * one accepted when a client registers with one), opaque random tokens stored as hashes,
 * refresh tokens that rotate on every use.
 */

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const CLIENT_DOCUMENT_TTL_MS = 60 * 60 * 1000;
const CLIENT_DOCUMENT_MAX_BYTES = 64 * 1024;

const ACCESS_PREFIX = 'mbo_';
const REFRESH_PREFIX = 'mbr_';
const SCOPES = ['mcp', 'offline_access'] as const;
const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;

/** What the authorize and token endpoints need to know about a client, wherever it came from. */
export interface ResolvedClient {
  id: string;
  name: string;
  redirectUris: string[];
  secretHash: string | null;
  /** identified by a metadata document at its client_id URL rather than a registration here */
  viaDocument: boolean;
}

// ---- metadata ------------------------------------------------------------------

export function protectedResourceMetadata(base: string) {
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
    resource_name: 'mcpbridge',
    resource_documentation: `${base}/`,
  };
}

export function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
    scopes_supported: [...SCOPES],
    // lets Claude identify itself with the document Anthropic hosts instead of registering
    client_id_metadata_document_supported: true,
    service_documentation: `${base}/`,
  };
}

/** The header an unauthenticated MCP request gets back; it is how a client finds this server. */
export function unauthorizedHeader(base: string, tokenPresented: boolean): string {
  const parts = [`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`, 'scope="mcp"'];
  if (tokenPresented) parts.push('error="invalid_token"', 'error_description="the token is expired, revoked or unknown"');
  return parts.join(', ');
}

// ---- access tokens, as the MCP endpoint sees them --------------------------------

/** The account an OAuth access token speaks for, or null if it is unknown, expired or revoked. */
export function resolveAccessToken(token: string, db: Db): { userId: string; grant: OAuthGrant } | null {
  if (!token.startsWith(ACCESS_PREFIX)) return null;
  const grant = db.findOAuthGrantByAccess(hashToken(token));
  if (!grant || grant.revokedAt !== null || grant.accessExpiresAt < Date.now()) return null;
  db.touchOAuthGrant(grant.id);
  return { userId: grant.userId, grant };
}

// ---- routing ---------------------------------------------------------------------

export async function handleOAuth(req: IncomingMessage, res: ServerResponse, ctx: ApiContext): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://relay');
  const base = baseUrl(req, ctx.publicUrl);

  switch (`${req.method} ${url.pathname}`) {
    case 'GET /.well-known/oauth-protected-resource':
    case 'GET /.well-known/oauth-protected-resource/mcp':
      sendJson(res, 200, protectedResourceMetadata(base));
      return true;

    case 'GET /.well-known/oauth-authorization-server':
      sendJson(res, 200, authorizationServerMetadata(base));
      return true;

    case 'POST /oauth/register':
      await register(req, res, ctx);
      return true;

    case 'GET /oauth/authorize':
      await authorizePage(req, res, ctx, url.searchParams, base);
      return true;

    case 'POST /oauth/authorize':
      await authorizeDecision(req, res, ctx, base);
      return true;

    case 'POST /oauth/token':
      await token(req, res, ctx, base);
      return true;

    case 'POST /oauth/revoke':
      await revoke(req, res, ctx);
      return true;

    default:
      return false;
  }
}

// ---- dynamic client registration (RFC 7591) ----------------------------------------

async function register(req: IncomingMessage, res: ServerResponse, ctx: ApiContext): Promise<void> {
  if (!ctx.oauthLimiter.allow(clientAddress(req))) {
    sendJson(res, 429, { error: 'invalid_client_metadata', error_description: 'too many registrations; wait a minute' });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: 'invalid_client_metadata', error_description: 'the body must be JSON' });
    return;
  }

  const uris = Array.isArray(body['redirect_uris']) ? (body['redirect_uris'] as unknown[]) : [];
  if (uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === 'string' && acceptableRedirectUri(u))) {
    sendJson(res, 400, {
      error: 'invalid_redirect_uri',
      error_description: 'redirect_uris must be 1-10 https URLs, or http URLs on localhost / 127.0.0.1, without fragments',
    });
    return;
  }
  const authMethod = String(body['token_endpoint_auth_method'] ?? 'none');
  if (!(AUTH_METHODS as readonly string[]).includes(authMethod)) {
    sendJson(res, 400, { error: 'invalid_client_metadata', error_description: `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(', ')}` });
    return;
  }
  const grantTypes = Array.isArray(body['grant_types']) ? body['grant_types'].map(String) : ['authorization_code', 'refresh_token'];
  if (!grantTypes.every((g) => g === 'authorization_code' || g === 'refresh_token')) {
    sendJson(res, 400, { error: 'invalid_client_metadata', error_description: 'only authorization_code and refresh_token are supported' });
    return;
  }

  const name = clientDisplayName(body['client_name'], uris[0] as string);
  const id = `mbcl_${randomBytes(16).toString('base64url')}`;
  const secret = authMethod === 'none' ? null : `mbcs_${randomBytes(32).toString('base64url')}`;
  const createdAt = Date.now();
  ctx.db.createOAuthClient({
    id, name, redirectUris: uris as string[], secretHash: secret ? hashToken(secret) : null, createdAt,
  });
  ctx.db.pruneOAuth();

  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 201, {
    client_id: id,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(createdAt / 1000),
    client_name: name,
    redirect_uris: uris,
    token_endpoint_auth_method: authMethod,
    grant_types: grantTypes,
    response_types: ['code'],
    scope: SCOPES.join(' '),
  });
}

/** https anywhere; plain http only on the loopback, which is how native clients catch the redirect. */
export function acceptableRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopback(url);
}

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

/**
 * Exact match, except that a loopback redirect may use any port: a native client binds an
 * ephemeral one per session (RFC 8252 §7.3), and Claude Code registers the port-less form.
 */
export function redirectUriAllowed(requested: string, registered: string[]): boolean {
  if (registered.includes(requested)) return true;
  let want: URL;
  try {
    want = new URL(requested);
  } catch {
    return false;
  }
  if (want.protocol !== 'http:' || !isLoopback(want)) return false;
  return registered.some((r) => {
    try {
      const have = new URL(r);
      return have.protocol === 'http:' && isLoopback(have) && have.hostname === want.hostname
        && have.pathname === want.pathname && have.search === want.search;
    } catch {
      return false;
    }
  });
}

function clientDisplayName(value: unknown, fallbackUri: string): string {
  const given = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 80) : '';
  if (given) return given;
  try {
    return new URL(fallbackUri).hostname;
  } catch {
    return 'an MCP client';
  }
}

// ---- client lookup: registered here, or described by a metadata document -----------

export async function resolveClient(clientId: string, ctx: ApiContext): Promise<ResolvedClient | null> {
  const stored = ctx.db.findOAuthClient(clientId);
  if (stored) return { ...stored, viaDocument: false };
  if (!looksLikeClientDocumentUrl(clientId)) return null;

  const cached = ctx.clientDocuments.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.client;

  const client = await fetchClientDocument(clientId, ctx);
  if (client) ctx.clientDocuments.set(clientId, { client, expiresAt: Date.now() + CLIENT_DOCUMENT_TTL_MS });
  return client;
}

/** A client_id that is itself an https URL with a path: the document lives there. */
function looksLikeClientDocumentUrl(clientId: string): boolean {
  try {
    const url = new URL(clientId);
    return url.protocol === 'https:' && url.pathname !== '/' && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function fetchClientDocument(clientId: string, ctx: ApiContext): Promise<ResolvedClient | null> {
  try {
    const response = await ctx.fetchImpl(clientId, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > CLIENT_DOCUMENT_MAX_BYTES) return null;
    const doc = JSON.parse(text) as Record<string, unknown>;
    // the document must claim the exact URL it was fetched from, or anyone could host a
    // document naming someone else's client_id
    if (doc['client_id'] !== clientId) return null;
    const uris = Array.isArray(doc['redirect_uris']) ? (doc['redirect_uris'] as unknown[]) : [];
    if (uris.length === 0 || !uris.every((u) => typeof u === 'string' && acceptableRedirectUri(u))) return null;
    return {
      id: clientId,
      name: clientDisplayName(doc['client_name'], clientId),
      redirectUris: uris as string[],
      secretHash: null,
      viaDocument: true,
    };
  } catch (error) {
    ctx.log(`client metadata document at ${clientId} could not be used: ${(error as Error).message}`);
    return null;
  }
}

// ---- authorization endpoint ----------------------------------------------------------

interface AuthorizeParams {
  client: ResolvedClient;
  redirectUri: string;
  state: string;
  scope: string;
  codeChallenge: string;
}

type AuthorizeCheck =
  | { kind: 'ok'; params: AuthorizeParams }
  | { kind: 'page'; status: number; message: string }
  | { kind: 'redirect'; location: string };

/**
 * Validates an authorization request. Until the client and its redirect URI are known to
 * be genuine nothing is redirected anywhere -- an error page is the only safe answer; once
 * they are, the client gets its errors the OAuth way, on the redirect.
 */
async function checkAuthorize(fields: URLSearchParams | Record<string, string>, ctx: ApiContext, base: string): Promise<AuthorizeCheck> {
  const get = (key: string) => (fields instanceof URLSearchParams ? fields.get(key) : fields[key]) ?? '';
  const clientId = get('client_id');
  if (!clientId) return { kind: 'page', status: 400, message: 'The request names no client.' };
  const client = await resolveClient(clientId, ctx);
  if (!client) return { kind: 'page', status: 400, message: 'The client is not known here. If it is Claude, remove the connector and add it again so it registers afresh.' };

  let redirectUri = get('redirect_uri');
  if (!redirectUri && client.redirectUris.length === 1) redirectUri = client.redirectUris[0]!;
  if (!redirectUri || !redirectUriAllowed(redirectUri, client.redirectUris)) {
    return { kind: 'page', status: 400, message: 'The redirect address does not match what this client registered, so the request was not forwarded anywhere.' };
  }

  const state = get('state');
  const fail = (error: string, description: string) => ({ kind: 'redirect' as const, location: withParams(redirectUri, { error, error_description: description, state }) });

  if (get('response_type') !== 'code') return fail('unsupported_response_type', 'only response_type=code is supported');
  const codeChallenge = get('code_challenge');
  if (!codeChallenge || get('code_challenge_method') !== 'S256') return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeChallenge)) return fail('invalid_request', 'code_challenge is malformed');

  const resource = get('resource');
  if (resource && stripSlash(resource) !== `${base}/mcp`) return fail('invalid_target', `this server only issues tokens for ${base}/mcp`);

  const requested = get('scope').split(/\s+/).filter(Boolean);
  if (!requested.every((s) => (SCOPES as readonly string[]).includes(s))) return fail('invalid_scope', `supported scopes: ${SCOPES.join(' ')}`);
  const scope = requested.length > 0 ? requested.join(' ') : 'mcp';

  return { kind: 'ok', params: { client, redirectUri, state, scope, codeChallenge } };
}

async function authorizePage(req: IncomingMessage, res: ServerResponse, ctx: ApiContext, query: URLSearchParams, base: string): Promise<void> {
  const check = await checkAuthorize(query, ctx, base);
  if (check.kind === 'page') return sendHtml(res, check.status, page('Cannot continue', `<h1>Cannot continue</h1><p>${esc(check.message)}</p>`));
  if (check.kind === 'redirect') return redirect(res, check.location);

  const user = currentUser(req, ctx);
  if (!user) {
    // sign in first, then come straight back to this same request
    const next = `/oauth/authorize?${query.toString()}`;
    return redirect(res, `/?next=${encodeURIComponent(next)}`);
  }
  const { client, redirectUri, state, scope, codeChallenge } = check.params;
  const hidden = { client_id: client.id, redirect_uri: redirectUri, state, scope, code_challenge: codeChallenge, response_type: 'code', code_challenge_method: 'S256' };
  return sendHtml(res, 200, consentPage(user.username, client, redirectUri, hidden));
}

async function authorizeDecision(req: IncomingMessage, res: ServerResponse, ctx: ApiContext, base: string): Promise<void> {
  if (!originAllowed(req, ctx.publicUrl)) return sendHtml(res, 403, page('Refused', '<h1>Refused</h1><p>Cross-origin request refused.</p>'));
  const user = currentUser(req, ctx);
  if (!user) return sendHtml(res, 401, page('Sign in', '<h1>Sign in first</h1><p>Your session ended. <a href="/">Sign in</a> and try connecting again.</p>'));

  const fields = parseFields(await readBody(req), req.headers['content-type']);
  const check = await checkAuthorize(fields, ctx, base);
  if (check.kind === 'page') return sendHtml(res, check.status, page('Cannot continue', `<h1>Cannot continue</h1><p>${esc(check.message)}</p>`));
  if (check.kind === 'redirect') return redirect(res, check.location);
  const { client, redirectUri, state, scope, codeChallenge } = check.params;

  if (fields['decision'] !== 'approve') {
    return redirect(res, withParams(redirectUri, { error: 'access_denied', error_description: 'the user declined', state }));
  }

  const code = `mbac_${randomBytes(32).toString('base64url')}`;
  ctx.db.createOAuthCode({
    hash: hashToken(code), userId: user.id, clientId: client.id, clientName: client.name,
    redirectUri, codeChallenge, scope, expiresAt: Date.now() + CODE_TTL_MS,
  });
  ctx.db.pruneOAuth();
  ctx.log(`oauth: ${user.username} approved ${client.name}`);
  return redirect(res, withParams(redirectUri, { code, state }));
}

function consentPage(username: string, client: ResolvedClient, redirectUri: string, hidden: Record<string, string>): string {
  const target = new URL(redirectUri);
  const loopback = target.protocol === 'http:' && isLoopback(target);
  const inputs = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  const warning = loopback
    ? `<p class="warn">This client receives its code on <b>${esc(target.host)}</b> — a program on your own computer. Only approve if you just started that connection yourself: any local program could claim that address.</p>`
    : `<p class="muted">After you approve, you go back to <b>${esc(target.host)}</b>.</p>`;
  return page('Approve a connection', `
<h1>Allow <b>${esc(client.name)}</b> to use your mcpbridge?</h1>
<p class="sub">Signed in as ${esc(username)}</p>
<div class="panel">
  <p>It will be able to, as you:</p>
  <ul><li>see which AI agents your connected machine has</li><li>send them tasks and read the answers</li></ul>
  <p class="muted">It cannot change your account, your tokens, or your sign-in settings, and you can disconnect it from the dashboard at any time.</p>
  ${warning}
  <form method="post" action="/oauth/authorize">${inputs}
    <button name="decision" value="approve">Allow</button>
    <button class="secondary" name="decision" value="deny">Cancel</button>
  </form>
</div>`);
}

// ---- token endpoint ------------------------------------------------------------------

interface ClientAuth {
  clientId: string;
  secret: string | null;
}

/** HTTP Basic takes precedence, then the body; a public client sends only its id. */
function clientAuthFrom(req: IncomingMessage, fields: Record<string, string>): ClientAuth | null {
  const header = req.headers.authorization;
  const basic = /^Basic\s+(\S+)$/i.exec(header ?? '');
  if (basic) {
    const [id = '', ...rest] = Buffer.from(basic[1]!, 'base64').toString('utf8').split(':');
    return { clientId: decodeURIComponent(id), secret: rest.length > 0 ? decodeURIComponent(rest.join(':')) : null };
  }
  if (!fields['client_id']) return null;
  return { clientId: fields['client_id'], secret: fields['client_secret'] || null };
}

async function token(req: IncomingMessage, res: ServerResponse, ctx: ApiContext, base: string): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  const fail = (status: number, error: string, description: string) => {
    if (error === 'invalid_client') res.setHeader('WWW-Authenticate', 'Basic realm="mcpbridge"');
    sendJson(res, status, { error, error_description: description });
  };

  let fields: Record<string, string>;
  try {
    fields = parseFields(await readBody(req), req.headers['content-type']);
  } catch {
    return fail(400, 'invalid_request', 'the body could not be read');
  }

  const auth = clientAuthFrom(req, fields);
  if (!auth) return fail(401, 'invalid_client', 'client_id is required');
  const client = await resolveClient(auth.clientId, ctx);
  if (!client) return fail(401, 'invalid_client', 'unknown client');
  if (client.secretHash && (!auth.secret || hashToken(auth.secret) !== client.secretHash)) {
    return fail(401, 'invalid_client', 'the client secret is wrong');
  }

  switch (fields['grant_type']) {
    case 'authorization_code': {
      const code = fields['code'] ?? '';
      const verifier = fields['code_verifier'] ?? '';
      if (!code) return fail(400, 'invalid_request', 'code is required');
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return fail(400, 'invalid_request', 'code_verifier is required (PKCE)');

      const stored = ctx.db.consumeOAuthCode(hashToken(code));
      if (!stored || stored.expiresAt < Date.now()) return fail(400, 'invalid_grant', 'the code is unknown, used or expired');
      if (stored.clientId !== client.id) return fail(400, 'invalid_grant', 'the code was issued to another client');
      if (fields['redirect_uri'] && fields['redirect_uri'] !== stored.redirectUri) return fail(400, 'invalid_grant', 'redirect_uri does not match the authorization request');
      if (s256(verifier) !== stored.codeChallenge) return fail(400, 'invalid_grant', 'code_verifier does not match');

      const issued = newTokenPair();
      ctx.db.createOAuthGrant({
        id: newId(), userId: stored.userId, clientId: client.id, clientName: stored.clientName, scope: stored.scope,
        accessHash: issued.accessHash, refreshHash: issued.refreshHash,
        accessExpiresAt: issued.accessExpiresAt, refreshExpiresAt: issued.refreshExpiresAt,
        createdAt: Date.now(), lastUsedAt: null, revokedAt: null,
      });
      sendJson(res, 200, tokenResponse(issued, stored.scope));
      return;
    }

    case 'refresh_token': {
      const presented = fields['refresh_token'] ?? '';
      const grant = presented.startsWith(REFRESH_PREFIX) ? ctx.db.findOAuthGrantByRefresh(hashToken(presented)) : null;
      if (!grant || grant.revokedAt !== null || grant.refreshExpiresAt < Date.now()) return fail(400, 'invalid_grant', 'the refresh token is unknown, revoked or expired');
      if (grant.clientId !== client.id) return fail(400, 'invalid_grant', 'the refresh token belongs to another client');

      const issued = newTokenPair();
      ctx.db.rotateOAuthGrant(grant.id, issued);
      sendJson(res, 200, tokenResponse(issued, grant.scope));
      return;
    }

    default:
      return fail(400, 'unsupported_grant_type', `grant_type must be authorization_code or refresh_token (for ${base}/mcp)`);
  }
}

interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessHash: string;
  refreshHash: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

function newTokenPair(now = Date.now()): IssuedTokens {
  const accessToken = ACCESS_PREFIX + randomBytes(32).toString('base64url');
  const refreshToken = REFRESH_PREFIX + randomBytes(32).toString('base64url');
  return {
    accessToken, refreshToken,
    accessHash: hashToken(accessToken), refreshHash: hashToken(refreshToken),
    accessExpiresAt: now + ACCESS_TOKEN_TTL_MS, refreshExpiresAt: now + REFRESH_TOKEN_TTL_MS,
  };
}

function tokenResponse(issued: IssuedTokens, scope: string) {
  return {
    access_token: issued.accessToken,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: issued.refreshToken,
    scope,
  };
}

// ---- revocation (RFC 7009) -------------------------------------------------------------

async function revoke(req: IncomingMessage, res: ServerResponse, ctx: ApiContext): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  let fields: Record<string, string>;
  try {
    fields = parseFields(await readBody(req), req.headers['content-type']);
  } catch {
    sendJson(res, 400, { error: 'invalid_request', error_description: 'the body could not be read' });
    return;
  }
  const presented = fields['token'] ?? '';
  const grant = presented.startsWith(ACCESS_PREFIX)
    ? ctx.db.findOAuthGrantByAccess(hashToken(presented))
    : presented.startsWith(REFRESH_PREFIX)
      ? ctx.db.findOAuthGrantByRefresh(hashToken(presented))
      : null;
  // a client may only revoke what was issued to it; an unknown token is a success too (RFC 7009 §2.2)
  const auth = clientAuthFrom(req, fields);
  if (grant && (!auth || auth.clientId === grant.clientId)) ctx.db.revokeOAuthGrant(grant.id, grant.userId);
  sendJson(res, 200, {});
}

// ---- helpers ---------------------------------------------------------------------------

export function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function withParams(uri: string, params: Record<string, string>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return url.toString();
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
