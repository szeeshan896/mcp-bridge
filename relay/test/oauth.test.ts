import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Config } from 'mcpbridge/config';
import { connectToRelay } from 'mcpbridge/connect';
import { ConcurrencyLimit } from 'mcpbridge/limit';
import { AgentRegistry } from 'mcpbridge/registry';
import { TaskStore } from 'mcpbridge/tasks';

import { createRelay, type Relay, type RelayConfig } from '../src/index.js';
import { acceptableRedirectUri, redirectUriAllowed, s256 } from '../src/oauth.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'agent.mjs');
const ECHO: Config = {
  maxOutputChars: 60_000,
  maxConcurrent: 2,
  agents: { echoer: { description: 'echoes', command: [process.execPath, FIXTURE, 'echo', '{prompt}'], timeoutMs: 10_000 } },
};

const relays: Relay[] = [];
const stops: AbortController[] = [];
after(async () => {
  stops.forEach((c) => c.abort());
  await Promise.all(relays.map((r) => r.close()));
});

async function startRelay(extra: Partial<RelayConfig> = {}) {
  const relay = createRelay({ sessionSecret: 'test-secret', databasePath: ':memory:', log: () => {}, ...extra });
  relays.push(relay);
  const { port } = await relay.listen(0, '127.0.0.1');
  return { relay, base: `http://127.0.0.1:${port}` };
}

// ---- a browser, as far as the relay can tell ---------------------------------------------

type Jar = Record<string, string>;
function absorb(jar: Jar, res: Response): Jar {
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';');
    const [name, value] = pair!.split('=');
    if (attrs.map((a) => a.trim()).includes('Max-Age=0')) delete jar[name!];
    else jar[name!] = value ?? '';
  }
  return jar;
}
const cookieHeader = (jar: Jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function browse(base: string, jar: Jar, method: string, path: string, body?: Record<string, string> | string, contentType = 'application/x-www-form-urlencoded') {
  const res = await fetch(path.startsWith('http') ? path : `${base}${path}`, {
    method, redirect: 'manual',
    headers: { 'Content-Type': contentType, Cookie: cookieHeader(jar) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : new URLSearchParams(body).toString(),
  });
  absorb(jar, res);
  return { status: res.status, text: await res.text(), location: res.headers.get('location'), headers: res.headers };
}

async function signIn(base: string, username = `oauth-${randomBytes(4).toString('hex')}@example.com`) {
  const jar: Jar = {};
  const res = await browse(base, jar, 'POST', '/api/signup', JSON.stringify({ username, password: 'correct horse battery' }), 'application/json');
  assert.equal(res.status, 201, res.text);
  return { jar, username };
}

function startAgent(base: string, token: string) {
  const limit = new ConcurrencyLimit(2);
  const controller = new AbortController();
  stops.push(controller);
  void connectToRelay({
    relayUrl: base, token, device: 'zee-laptop', agentVersion: 'test',
    context: { registry: new AgentRegistry(ECHO), tasks: new TaskStore(limit), limit },
    log: () => {}, signal: controller.signal,
  });
}

async function apiJson(base: string, jar: Jar, method: string, path: string, body?: unknown) {
  const res = await browse(base, jar, method, path, body === undefined ? undefined : JSON.stringify(body), 'application/json');
  return { status: res.status, json: JSON.parse(res.text || '{}') as Record<string, any> };
}

/** Fetches the consent page for an authorization URL and clicks Allow; returns the redirect. */
async function approve(base: string, jar: Jar, authorizeUrl: URL) {
  const consent = await browse(base, jar, 'GET', authorizeUrl.toString());
  assert.equal(consent.status, 200, consent.text);
  assert.match(consent.text, /Allow/);
  const fields = Object.fromEntries(authorizeUrl.searchParams);
  const decided = await browse(base, jar, 'POST', '/oauth/authorize', { ...fields, decision: 'approve' });
  assert.equal(decided.status, 303, decided.text);
  const location = new URL(decided.location!);
  return { consent, location, code: location.searchParams.get('code'), state: location.searchParams.get('state') };
}

/** What the MCP SDK needs from an application: somewhere to keep what the flow produces. */
class MemoryProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  authorizationUrl: URL | undefined;
  constructor(private readonly redirect: string, private readonly name: string) {}
  get redirectUrl() { return this.redirect; }
  get clientMetadata() {
    return {
      redirect_uris: [this.redirect], client_name: this.name, token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    };
  }
  clientInformation() { return this.info; }
  saveClientInformation(info: OAuthClientInformationMixed) { this.info = info; }
  tokens() { return this.saved; }
  saveTokens(tokens: OAuthTokens) { this.saved = tokens; }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() { return this.verifier; }
}

async function mcpWith(base: string, provider: OAuthClientProvider) {
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider });
  const call = async <T>(name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse((result.content as { text: string }[])[0]!.text) as T;
  };
  return { client, transport, call };
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: s256(verifier) };
}

async function registerClient(base: string, redirectUris: string[], name = 'Test Claude') {
  const res = await fetch(`${base}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: name, token_endpoint_auth_method: 'none' }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

function authorizeUrl(base: string, params: Record<string, string>): URL {
  const url = new URL(`${base}/oauth/authorize`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

async function exchange(base: string, body: Record<string, string>) {
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function mcpStatus(base: string, token: string | undefined) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
  });
  await res.text();
  return { status: res.status, authenticate: res.headers.get('www-authenticate') ?? '' };
}

// ---- tests ---------------------------------------------------------------------------------

test('discovery: the metadata documents agree with each other and the 401 points at them', async () => {
  const { base } = await startRelay();

  const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as Record<string, any>;
  assert.equal(prm['resource'], `${base}/mcp`);
  assert.deepEqual(prm['authorization_servers'], [base]);
  const prmForPath = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, any>;
  assert.deepEqual(prmForPath, prm);

  const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, any>;
  assert.equal(as['issuer'], base);
  assert.equal(as['authorization_endpoint'], `${base}/oauth/authorize`);
  assert.equal(as['token_endpoint'], `${base}/oauth/token`);
  assert.equal(as['registration_endpoint'], `${base}/oauth/register`);
  assert.deepEqual(as['code_challenge_methods_supported'], ['S256']);
  assert.ok(as['token_endpoint_auth_methods_supported'].includes('none'));
  assert.equal(as['client_id_metadata_document_supported'], true);

  const anonymous = await mcpStatus(base, undefined);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.authenticate, new RegExp(`resource_metadata="${base}/.well-known/oauth-protected-resource"`));
  assert.doesNotMatch(anonymous.authenticate, /invalid_token/);

  const stale = await mcpStatus(base, 'mbo_not-a-real-token');
  assert.equal(stale.status, 401);
  assert.match(stale.authenticate, /error="invalid_token"/);
});

test('the MCP SDK client signs in end to end: discover, register, approve, exchange, delegate', async () => {
  const { base } = await startRelay();
  const { jar } = await signIn(base);
  const agentToken = (await apiJson(base, jar, 'POST', '/api/tokens/agent')).json['token'] as string;
  startAgent(base, agentToken);
  for (let i = 0; i < 100; i += 1) {
    if ((await apiJson(base, jar, 'GET', '/api/me')).json['device']?.online) break;
    await sleep(50);
  }

  const provider = new MemoryProvider('http://localhost:48213/callback', 'Test Claude');
  const first = await mcpWith(base, provider);
  await assert.rejects(first.client.connect(first.transport), (error: unknown) => error instanceof UnauthorizedError);

  // the SDK registered itself and built the authorization request
  assert.ok(provider.info?.client_id);
  const url = provider.authorizationUrl!;
  assert.equal(url.origin, base);
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('resource'), `${base}/mcp`);

  // not signed in: the browser is sent to the sign-in page and will come back to this request
  const anonymous = await browse(base, {}, 'GET', url.toString());
  assert.equal(anonymous.status, 303);
  assert.match(anonymous.location!, /^\/\?next=%2Foauth%2Fauthorize%3F/);

  const { consent, location, code, state } = await approve(base, jar, url);
  assert.match(consent.text, /Test Claude/);
  assert.match(consent.text, /localhost:48213/, 'a loopback redirect is named on the consent page');
  assert.equal(location.origin + location.pathname, 'http://localhost:48213/callback');
  assert.equal(state, url.searchParams.get('state'));
  assert.ok(code);

  await first.transport.finishAuth(code!);
  assert.match(provider.saved!.access_token, /^mbo_/);
  assert.match(provider.saved!.refresh_token!, /^mbr_/);

  const second = await mcpWith(base, provider);
  await second.client.connect(second.transport);
  const listed = await second.call<{ offline: boolean; device: string; agents: { name: string }[] }>('list_agents', {});
  assert.equal(listed.offline, false);
  assert.equal(listed.device, 'zee-laptop');
  const asked = await second.call<{ succeeded: boolean; output: string }>('ask_agent', { agent: 'echoer', prompt: 'via oauth' });
  assert.equal(asked.succeeded, true);
  assert.equal(asked.output, 'via oauth');
  await second.client.close();

  const me = (await apiJson(base, jar, 'GET', '/api/me')).json;
  assert.equal(me['connectedApps'].length, 1);
  assert.equal(me['connectedApps'][0].name, 'Test Claude');
  assert.ok(me['connectedApps'][0].lastUsedAt, 'use is recorded');

  // refresh rotates: the new pair works, the old pair is dead
  const before = provider.saved!;
  const refreshed = await exchange(base, { grant_type: 'refresh_token', refresh_token: before.refresh_token!, client_id: provider.info!.client_id });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json));
  assert.notEqual(refreshed.json['access_token'], before.access_token);
  assert.equal((await mcpStatus(base, before.access_token)).status, 401);
  assert.equal((await mcpStatus(base, refreshed.json['access_token'])).status, 200);
  const replay = await exchange(base, { grant_type: 'refresh_token', refresh_token: before.refresh_token!, client_id: provider.info!.client_id });
  assert.equal(replay.status, 400);
  assert.equal(replay.json['error'], 'invalid_grant');

  // disconnecting from the dashboard ends it
  const revoked = await apiJson(base, jar, 'POST', '/api/oauth/revoke', { id: me['connectedApps'][0].id });
  assert.equal(revoked.status, 200);
  assert.equal((await mcpStatus(base, refreshed.json['access_token'])).status, 401);
  assert.equal((await apiJson(base, jar, 'GET', '/api/me')).json['connectedApps'].length, 0);
});

test('a code is single-use and bound to its PKCE verifier, client and redirect', async () => {
  const { base } = await startRelay();
  const { jar } = await signIn(base);
  const client = await registerClient(base, ['https://claude.ai/api/mcp/auth_callback']);
  assert.equal(client.status, 201, JSON.stringify(client.json));
  const other = await registerClient(base, ['https://other.example/cb'], 'Other');
  const { verifier, challenge } = pkce();
  const params = {
    client_id: client.json['client_id'], redirect_uri: 'https://claude.ai/api/mcp/auth_callback', response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'mcp',
  };

  const { code } = await approve(base, jar, authorizeUrl(base, params));
  const common = { grant_type: 'authorization_code', code: code!, redirect_uri: params.redirect_uri };

  const wrongVerifier = await exchange(base, { ...common, client_id: params.client_id, code_verifier: pkce().verifier });
  assert.equal(wrongVerifier.json['error'], 'invalid_grant');
  // a failed exchange burns the code: a stolen code cannot be retried with guesses
  const retry = await exchange(base, { ...common, client_id: params.client_id, code_verifier: verifier });
  assert.equal(retry.json['error'], 'invalid_grant');

  const { code: code2 } = await approve(base, jar, authorizeUrl(base, params));
  const wrongClient = await exchange(base, { ...common, code: code2!, client_id: other.json['client_id'], code_verifier: verifier });
  assert.equal(wrongClient.json['error'], 'invalid_grant');

  const { code: code3 } = await approve(base, jar, authorizeUrl(base, params));
  const wrongRedirect = await exchange(base, { ...common, code: code3!, redirect_uri: 'https://claude.ai/elsewhere', client_id: params.client_id, code_verifier: verifier });
  assert.equal(wrongRedirect.json['error'], 'invalid_grant');

  const { code: code4 } = await approve(base, jar, authorizeUrl(base, params));
  const good = await exchange(base, { ...common, code: code4!, client_id: params.client_id, code_verifier: verifier });
  assert.equal(good.status, 200, JSON.stringify(good.json));
  assert.equal(good.json['token_type'], 'Bearer');
  assert.equal(good.json['scope'], 'mcp');
  const again = await exchange(base, { ...common, code: code4!, client_id: params.client_id, code_verifier: verifier });
  assert.equal(again.json['error'], 'invalid_grant', 'a code works once');
});

test('nothing is redirected to an address the client did not register; declining goes back with access_denied', async () => {
  const { base } = await startRelay();
  const { jar } = await signIn(base);
  const client = await registerClient(base, ['https://claude.ai/api/mcp/auth_callback']);
  const { challenge } = pkce();
  const good = {
    client_id: client.json['client_id'], redirect_uri: 'https://claude.ai/api/mcp/auth_callback', response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', state: 's',
  };

  const foreign = await browse(base, jar, 'GET', authorizeUrl(base, { ...good, redirect_uri: 'https://evil.example/cb' }).toString());
  assert.equal(foreign.status, 400);
  assert.equal(foreign.location, null);
  assert.match(foreign.text, /does not match/);

  const unknown = await browse(base, jar, 'GET', authorizeUrl(base, { ...good, client_id: 'mbcl_nope' }).toString());
  assert.equal(unknown.status, 400);
  assert.equal(unknown.location, null);

  // a genuine client with a bad request hears about it the OAuth way
  const noPkce = await browse(base, jar, 'GET', authorizeUrl(base, { ...good, code_challenge: '' }).toString());
  assert.equal(noPkce.status, 303);
  const noPkceUrl = new URL(noPkce.location!);
  assert.equal(noPkceUrl.origin + noPkceUrl.pathname, 'https://claude.ai/api/mcp/auth_callback');
  assert.equal(noPkceUrl.searchParams.get('error'), 'invalid_request');
  assert.equal(noPkceUrl.searchParams.get('state'), 's');

  const wrongResource = await browse(base, jar, 'GET', authorizeUrl(base, { ...good, resource: 'https://other.example/mcp' }).toString());
  assert.equal(new URL(wrongResource.location!).searchParams.get('error'), 'invalid_target');

  const declined = await browse(base, jar, 'POST', '/oauth/authorize', { ...good, decision: 'deny' });
  assert.equal(declined.status, 303);
  assert.equal(new URL(declined.location!).searchParams.get('error'), 'access_denied');

  // a decision needs a session, and a foreign origin cannot forge one
  const nobody = await browse(base, {}, 'POST', '/oauth/authorize', { ...good, decision: 'approve' });
  assert.equal(nobody.status, 401);
});

test('registration accepts https and loopback redirects only; a loopback may use any port', async () => {
  const { base } = await startRelay();
  const { jar } = await signIn(base);

  const plainHttp = await registerClient(base, ['http://example.com/cb']);
  assert.equal(plainHttp.status, 400);
  assert.equal(plainHttp.json['error'], 'invalid_redirect_uri');
  const none = await registerClient(base, []);
  assert.equal(none.status, 400);

  // what Claude Code's metadata document declares
  const native = await registerClient(base, ['http://localhost/callback', 'http://127.0.0.1/callback'], 'Claude Code');
  assert.equal(native.status, 201);
  const { challenge } = pkce();
  const consent = await browse(base, jar, 'GET', authorizeUrl(base, {
    client_id: native.json['client_id'], redirect_uri: 'http://localhost:3118/callback', response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256',
  }).toString());
  assert.equal(consent.status, 200, consent.text);
  assert.match(consent.text, /any local program could claim/);

  assert.equal(acceptableRedirectUri('https://claude.ai/api/mcp/auth_callback'), true);
  assert.equal(acceptableRedirectUri('http://localhost:5555/cb'), true);
  assert.equal(acceptableRedirectUri('http://localhost/cb#frag'), false);
  assert.equal(acceptableRedirectUri('http://10.0.0.5/cb'), false);
  assert.equal(redirectUriAllowed('http://127.0.0.1:9999/callback', ['http://127.0.0.1/callback']), true);
  assert.equal(redirectUriAllowed('http://127.0.0.1:9999/other', ['http://127.0.0.1/callback']), false);
  assert.equal(redirectUriAllowed('https://claude.ai:444/api/mcp/auth_callback', ['https://claude.ai/api/mcp/auth_callback']), false);
});

test('a client identified by a metadata document needs no registration', async () => {
  const documentUrl = 'https://claude.ai/oauth/test-client-metadata';
  const documents: Record<string, unknown> = {
    [documentUrl]: { client_id: documentUrl, client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] },
    'https://claude.ai/oauth/impostor': { client_id: documentUrl, client_name: 'Impostor', redirect_uris: ['https://evil.example/cb'] },
  };
  let fetches = 0;
  const fetchImpl: typeof fetch = async (input) => {
    fetches += 1;
    const doc = documents[String(input)];
    return doc ? Response.json(doc) : new Response('nope', { status: 404 });
  };
  const { base } = await startRelay({ fetchImpl });
  const { jar } = await signIn(base);
  const { verifier, challenge } = pkce();
  const params = {
    client_id: documentUrl, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', state: 'st', scope: 'mcp offline_access',
  };

  const { consent, code } = await approve(base, jar, authorizeUrl(base, params));
  assert.match(consent.text, /Allow <b>Claude<\/b>/);
  const tokens = await exchange(base, { grant_type: 'authorization_code', code: code!, redirect_uri: params.redirect_uri, client_id: documentUrl, code_verifier: verifier });
  assert.equal(tokens.status, 200, JSON.stringify(tokens.json));
  assert.equal(tokens.json['scope'], 'mcp offline_access');
  assert.equal((await mcpStatus(base, tokens.json['access_token'])).status, 200);
  assert.equal(fetches, 1, 'the document is cached across the authorize and token calls');

  // a document that names a different client_id is not that client
  const impostor = await browse(base, jar, 'GET', authorizeUrl(base, { ...params, client_id: 'https://claude.ai/oauth/impostor', redirect_uri: 'https://evil.example/cb' }).toString());
  assert.equal(impostor.status, 400);
  assert.equal(impostor.location, null);

  const missing = await browse(base, jar, 'GET', authorizeUrl(base, { ...params, client_id: 'https://claude.ai/oauth/absent' }).toString());
  assert.equal(missing.status, 400);
});

test('signing in from the consent redirect returns to the pending request, and only to that', async () => {
  const { base } = await startRelay();
  const client = await registerClient(base, ['https://claude.ai/api/mcp/auth_callback']);
  const { challenge } = pkce();
  const url = authorizeUrl(base, {
    client_id: client.json['client_id'], redirect_uri: 'https://claude.ai/api/mcp/auth_callback', response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', state: 's',
  });
  const next = url.pathname + url.search;

  const landing = await browse(base, {}, 'GET', `/?next=${encodeURIComponent(next)}`);
  assert.equal(landing.status, 200);
  assert.match(landing.text, /A client is waiting to connect/);
  assert.ok(landing.text.includes(JSON.stringify(next)), 'the page knows where to go after sign-in');

  const elsewhere = await browse(base, {}, 'GET', `/?next=${encodeURIComponent('https://evil.example/')}`);
  assert.doesNotMatch(elsewhere.text, /evil\.example/);

  // already signed in: straight back to the request
  const { jar } = await signIn(base);
  const back = await browse(base, jar, 'GET', `/?next=${encodeURIComponent(next)}`);
  assert.equal(back.status, 303);
  assert.equal(back.location, next);
});
