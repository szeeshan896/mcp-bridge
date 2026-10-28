import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { createRelay, type Relay } from '../src/index.js';
import { currentCounter, totpCode } from '../src/totp.js';

const relays: Relay[] = [];
after(async () => { await Promise.all(relays.map((r) => r.close())); });

async function startRelay(extra: Record<string, unknown> = {}) {
  const relay = createRelay({ sessionSecret: 'test-secret', databasePath: ':memory:', log: () => {}, ...extra } as never);
  relays.push(relay);
  const { port } = await relay.listen(0, '127.0.0.1');
  return { relay, base: `http://127.0.0.1:${port}` };
}

type Jar = Record<string, string>;
function absorb(jar: Jar, res: Response): Jar {
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';');
    const [name, value] = pair!.split('=');
    const maxAge = attrs.map((a) => a.trim()).find((a) => a.startsWith('Max-Age='));
    if (maxAge === 'Max-Age=0') delete jar[name!];
    else jar[name!] = value ?? '';
  }
  return jar;
}
const cookieHeader = (jar: Jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function call(base: string, jar: Jar, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  absorb(jar, res);
  const text = await res.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text, location: res.headers.get('location') };
}

test('2-step verification: enrol, require on login, refuse replay, recovery code once, disable', async () => {
  const { base } = await startRelay();
  const jar: Jar = {};
  assert.equal((await call(base, jar, 'POST', '/api/signup', { username: 'two@example.com', password: 'a strong passphrase' })).status, 201);

  const setup = await call(base, jar, 'POST', '/api/2fa/setup');
  assert.equal(setup.status, 200);
  assert.match(setup.json['otpauth'], /^otpauth:\/\/totp\//);
  assert.match(setup.json['qrSvg'], /<svg/);
  const secret = setup.json['secret'] as string;

  // not on until a code proves the app has the secret
  assert.equal((await call(base, jar, 'GET', '/api/me')).json['twoFactorEnabled'], false);
  assert.equal((await call(base, jar, 'POST', '/api/2fa/enable', { code: '000000' })).status, 401);

  const c0 = currentCounter();
  const enabled = await call(base, jar, 'POST', '/api/2fa/enable', { code: totpCode(secret, c0) });
  assert.equal(enabled.status, 200);
  const recovery = enabled.json['recoveryCodes'] as string[];
  assert.equal(recovery.length, 10);
  const me = (await call(base, jar, 'GET', '/api/me')).json;
  assert.equal(me['twoFactorEnabled'], true);
  assert.equal(me['recoveryCodesLeft'], 10);

  // a fresh sign-in now stops at the second step
  const fresh: Jar = {};
  const login = await call(base, fresh, 'POST', '/api/login', { username: 'two@example.com', password: 'a strong passphrase' });
  assert.equal(login.status, 200);
  assert.equal(login.json['twoFactorRequired'], true);
  assert.equal((await call(base, fresh, 'GET', '/api/me')).status, 401, 'no session before the second step');
  assert.equal((await call(base, fresh, 'POST', '/api/login/2fa', { code: '123456' })).status, 401);

  // the code used to enrol was consumed; the next step's code is inside the window
  assert.equal((await call(base, fresh, 'POST', '/api/login/2fa', { code: totpCode(secret, c0) })).status, 401, 'replayed enrolment code');
  const passed = await call(base, fresh, 'POST', '/api/login/2fa', { code: totpCode(secret, c0 + 1) });
  assert.equal(passed.status, 200);
  assert.equal((await call(base, fresh, 'GET', '/api/me')).status, 200);

  // recovery codes: once each
  const again: Jar = {};
  await call(base, again, 'POST', '/api/login', { username: 'two@example.com', password: 'a strong passphrase' });
  assert.equal((await call(base, again, 'POST', '/api/login/2fa', { code: recovery[0]!.toUpperCase() })).status, 200);
  assert.equal((await call(base, again, 'GET', '/api/me')).json['recoveryCodesLeft'], 9);
  const third: Jar = {};
  await call(base, third, 'POST', '/api/login', { username: 'two@example.com', password: 'a strong passphrase' });
  assert.equal((await call(base, third, 'POST', '/api/login/2fa', { code: recovery[0]! })).status, 401, 'a burned recovery code');

  // turning it off needs a current code, and then login is one step again
  assert.equal((await call(base, jar, 'POST', '/api/2fa/disable', { code: 'nope' })).status, 401);
  assert.equal((await call(base, jar, 'POST', '/api/2fa/disable', { code: recovery[1]! })).status, 200);
  const last: Jar = {};
  const plain = await call(base, last, 'POST', '/api/login', { username: 'two@example.com', password: 'a strong passphrase' });
  assert.equal(plain.json['twoFactorRequired'], undefined);
  assert.equal((await call(base, last, 'GET', '/api/me')).status, 200);
});

test('Google sign-in: creates, then recognises, then links by verified email; refuses unverified', async () => {
  const seen: unknown[] = [];
  let identity = { sub: 'google-123', email: 'Zee@Example.com', emailVerified: true };
  const { base } = await startRelay({
    publicUrl: 'https://bridge.example.com',
    googleClientId: 'id', googleClientSecret: 'secret',
    googleExchange: async (...args: unknown[]) => { seen.push(args); return identity; },
  });

  const start = async () => {
    const jar: Jar = {};
    const r = await call(base, jar, 'GET', '/auth/google');
    assert.equal(r.status, 303);
    const to = new URL(r.location!);
    assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(to.searchParams.get('redirect_uri'), 'https://bridge.example.com/auth/google/callback');
    return { jar, state: to.searchParams.get('state')! };
  };

  // first time: a new account under the normalised email
  let { jar, state } = await start();
  let cb = await call(base, jar, 'GET', `/auth/google/callback?code=abc&state=${state}`);
  assert.equal(cb.status, 303);
  assert.equal(cb.location, '/dashboard');
  let me = (await call(base, jar, 'GET', '/api/me')).json;
  assert.equal(me['username'], 'zee@example.com');
  assert.equal(me['googleLinked'], true);
  assert.equal(me['hasPassword'], false);
  assert.equal((seen[0] as unknown[])[2], 'abc', 'the code reaches the exchange');

  // second time: the same account, by sub
  ({ jar, state } = await start());
  await call(base, jar, 'GET', `/auth/google/callback?code=def&state=${state}`);
  assert.equal((await call(base, jar, 'GET', '/api/me')).json['username'], 'zee@example.com');

  // a password account with that email gets linked rather than duplicated
  const pw: Jar = {};
  assert.equal((await call(base, pw, 'POST', '/api/signup', { username: 'other@example.com', password: 'password12345' })).status, 201);
  identity = { sub: 'google-999', email: 'other@example.com', emailVerified: true };
  ({ jar, state } = await start());
  await call(base, jar, 'GET', `/auth/google/callback?code=ghi&state=${state}`);
  me = (await call(base, jar, 'GET', '/api/me')).json;
  assert.equal(me['username'], 'other@example.com');
  assert.equal(me['googleLinked'], true);
  assert.equal(me['hasPassword'], true);

  // an unverified address must not link to anything
  identity = { sub: 'google-evil', email: 'other@example.com', emailVerified: false };
  ({ jar, state } = await start());
  cb = await call(base, jar, 'GET', `/auth/google/callback?code=jkl&state=${state}`);
  assert.equal(cb.status, 403);
  assert.equal((await call(base, jar, 'GET', '/api/me')).status, 401);

  // a mismatched state is refused before any exchange
  const before = seen.length;
  ({ jar } = await start());
  cb = await call(base, jar, 'GET', '/auth/google/callback?code=mno&state=forged');
  assert.equal(cb.status, 400);
  assert.equal(seen.length, before);
});

test('pages: landing, dashboard needs a session, 2fa page needs a pending step', async () => {
  const { base } = await startRelay();
  const anon: Jar = {};
  const landing = await call(base, anon, 'GET', '/');
  assert.equal(landing.status, 200);
  assert.match(landing.text, /Create an account/);
  assert.doesNotMatch(landing.text, /Continue with Google/, 'no Google button without config');
  assert.equal((await call(base, anon, 'GET', '/dashboard')).status, 303);
  assert.equal((await call(base, anon, 'GET', '/login/2fa')).status, 303);

  const jar: Jar = {};
  await call(base, jar, 'POST', '/api/signup', { username: '+91 98765 43210', password: 'a strong passphrase' });
  const dash = await call(base, jar, 'GET', '/dashboard');
  assert.equal(dash.status, 200);
  assert.match(dash.text, /\+919876543210/);
  assert.match(dash.text, /Offline/);
  assert.match(dash.text, /mcpbridge connect --relay/);
  assert.equal((await call(base, jar, 'GET', '/')).status, 303, 'signed in users skip the landing page');

  const out = await call(base, jar, 'POST', '/logout');
  assert.equal(out.status, 303);
  assert.equal((await call(base, jar, 'GET', '/api/me')).status, 401);
});

test('a username is escaped on the page', async () => {
  const { base } = await startRelay();
  const jar: Jar = {};
  // an email can legally carry these characters; they must not become markup
  await call(base, jar, 'POST', '/api/signup', { username: '"<b>x</b>"@example.com', password: 'a strong passphrase' });
  const dash = await call(base, jar, 'GET', '/dashboard');
  assert.equal(dash.status, 200);
  assert.doesNotMatch(dash.text, /<b>x<\/b>/);
  assert.match(dash.text, /&lt;b&gt;x&lt;\/b&gt;/);
});
