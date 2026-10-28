import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Config } from 'mcpbridge/config';
import { connectToRelay } from 'mcpbridge/connect';
import { ConcurrencyLimit } from 'mcpbridge/limit';
import { AgentRegistry } from 'mcpbridge/registry';
import { TaskStore } from 'mcpbridge/tasks';
import WebSocket from 'ws';

import { createRelay, type Relay } from '../src/index.js';

// the same Node stand-in the CLI's own tests use, so this is the real agent code end to end
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

async function startRelay(publicUrl?: string) {
  const relay = createRelay({ sessionSecret: 'test-secret', databasePath: ':memory:', log: () => {}, ...(publicUrl ? { publicUrl } : {}) });
  relays.push(relay);
  const { port } = await relay.listen(0, '127.0.0.1');
  return { relay, base: `http://127.0.0.1:${port}` };
}

async function api(base: string, method: string, path: string, body?: unknown, cookie?: string, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  const session = /mcpbridge_session=([^;]+)/.exec(setCookie)?.[1];
  return { status: res.status, json: (await res.json()) as Record<string, any>, cookie: session ? `mcpbridge_session=${session}` : undefined };
}

async function signupWithTokens(base: string, username = `user-${Math.random().toString(36).slice(2)}@example.com`) {
  const signup = await api(base, 'POST', '/api/signup', { username, password: 'correct horse battery' });
  assert.equal(signup.status, 201, JSON.stringify(signup.json));
  const cookie = signup.cookie!;
  const agent = await api(base, 'POST', '/api/tokens/agent', {}, cookie);
  const client = await api(base, 'POST', '/api/tokens/client', {}, cookie);
  return { cookie, agentToken: agent.json['token'] as string, clientToken: client.json['token'] as string, username };
}

/** Runs the real `mcpbridge connect` code against the relay, with the echo agent. */
function startAgent(base: string, token: string, device = 'test-laptop') {
  const limit = new ConcurrencyLimit(2);
  const controller = new AbortController();
  stops.push(controller);
  const done = connectToRelay({
    relayUrl: base, token, device, agentVersion: 'test',
    context: { registry: new AgentRegistry(ECHO), tasks: new TaskStore(limit), limit },
    log: () => {}, signal: controller.signal,
  });
  return { controller, done };
}

async function untilOnline(base: string, cookie: string, want = true) {
  for (let i = 0; i < 100; i += 1) {
    const me = await api(base, 'GET', '/api/me', undefined, cookie);
    if (me.json['device']?.online === want) return me.json;
    await sleep(50);
  }
  throw new Error(`device never went ${want ? 'online' : 'offline'}`);
}

async function mcpClient(base: string, token: string) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  const call = async <T>(name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse((result.content as { text: string }[])[0]!.text) as T;
  };
  return { client, call, close: () => client.close() };
}

test('signup issues a session and tokens of both kinds', async () => {
  const { base } = await startRelay();
  const { cookie, agentToken, clientToken } = await signupWithTokens(base);

  assert.match(agentToken, /^mba_/);
  assert.match(clientToken, /^mbc_/);
  const me = await api(base, 'GET', '/api/me', undefined, cookie);
  assert.equal(me.json['device'].online, false);
  assert.ok(me.json['tokens'].agent.createdAt);
});

test('with no device connected, every tool explains how to connect one', async () => {
  const { base } = await startRelay();
  const { clientToken } = await signupWithTokens(base);
  const mcp = await mcpClient(base, clientToken);

  const listed = await mcp.call<{ offline: boolean; diagnostics: string }>('list_agents', {});
  assert.equal(listed.offline, true);
  assert.match(listed.diagnostics, /mcpbridge connect/);

  const asked = await mcp.call<{ succeeded: boolean; offline: boolean; diagnostics: string }>('ask_agent', { agent: 'echoer', prompt: 'hi' });
  assert.equal(asked.succeeded, false);
  assert.equal(asked.offline, true);
  await mcp.close();
});

test('a delegation travels client -> relay -> agent -> CLI and back', async () => {
  const { base } = await startRelay();
  const { cookie, agentToken, clientToken } = await signupWithTokens(base);
  startAgent(base, agentToken, 'zee-laptop');
  const me = await untilOnline(base, cookie);
  assert.equal(me['device'].name, 'zee-laptop');
  assert.deepEqual(me['device'].agents.map((a: { name: string }) => a.name), ['echoer']);

  const mcp = await mcpClient(base, clientToken);
  const tools = (await mcp.client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['ask_agent', 'get_task', 'list_agents', 'start_task']);

  const listed = await mcp.call<{ offline: boolean; device: string; agents: { name: string }[] }>('list_agents', {});
  assert.equal(listed.offline, false);
  assert.equal(listed.device, 'zee-laptop');
  assert.equal(listed.agents[0]?.name, 'echoer');

  const asked = await mcp.call<{ succeeded: boolean; output: string }>('ask_agent', { agent: 'echoer', prompt: 'round trip' });
  assert.equal(asked.succeeded, true);
  assert.equal(asked.output, 'round trip');

  const started = await mcp.call<{ started: boolean; id: string }>('start_task', { agent: 'echoer', prompt: 'later' });
  assert.equal(started.started, true);
  let task = await mcp.call<{ status: string; result?: { output: string } }>('get_task', { id: started.id });
  for (let i = 0; i < 60 && task.status !== 'finished'; i += 1) {
    await sleep(50);
    task = await mcp.call('get_task', { id: started.id });
  }
  assert.equal(task.result?.output, 'later');
  await mcp.close();
});

test('one account cannot reach another account\'s machine', async () => {
  const { base } = await startRelay();
  const alice = await signupWithTokens(base, 'alice@example.com');
  const bob = await signupWithTokens(base, 'bob@example.com');
  startAgent(base, alice.agentToken, 'alice-laptop');
  await untilOnline(base, alice.cookie);

  const asBob = await mcpClient(base, bob.clientToken);
  const listed = await asBob.call<{ offline: boolean }>('list_agents', {});
  assert.equal(listed.offline, true, 'bob must not see alice\'s device');
  await asBob.close();
});

test('a bad client token is refused with a WWW-Authenticate hint', async () => {
  const { base } = await startRelay();
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer mbc_nope' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /Bearer/);
});

test('an agent token is not a client token, and vice versa', async () => {
  const { base } = await startRelay();
  const { agentToken, clientToken } = await signupWithTokens(base);

  const asAgentToken = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${agentToken}` } });
  assert.equal(asAgentToken.status, 401);

  const closed = await new Promise<number>((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/agent`, { headers: { Authorization: `Bearer ${clientToken}` } });
    ws.on('close', (code) => resolve(code));
  });
  assert.equal(closed, 4001);
});

test('a second device for the same account displaces the first, which stops', async () => {
  const { base } = await startRelay();
  const { cookie, agentToken } = await signupWithTokens(base);
  const first = startAgent(base, agentToken, 'old-laptop');
  await untilOnline(base, cookie);

  startAgent(base, agentToken, 'new-laptop');
  for (let i = 0; i < 100; i += 1) {
    const me = await api(base, 'GET', '/api/me', undefined, cookie);
    if (me.json['device'].name === 'new-laptop') break;
    await sleep(50);
  }
  const me = await api(base, 'GET', '/api/me', undefined, cookie);
  assert.equal(me.json['device'].name, 'new-laptop');

  // the displaced agent received goodbye retry:false and returned instead of reconnecting
  await Promise.race([first.done, sleep(5_000).then(() => { throw new Error('the old agent kept reconnecting'); })]);
});

test('regenerating the agent token disconnects the device using the old one', async () => {
  const { base } = await startRelay();
  const { cookie, agentToken } = await signupWithTokens(base);
  const agent = startAgent(base, agentToken);
  await untilOnline(base, cookie);

  await api(base, 'POST', '/api/tokens/agent', {}, cookie);

  await untilOnline(base, cookie, false);
  await Promise.race([agent.done, sleep(5_000).then(() => { throw new Error('agent kept reconnecting with a revoked token'); })]);
});

test('email and phone usernames are normalised, so variants are one account', async () => {
  const { base } = await startRelay();
  await signupWithTokens(base, 'Zee@Example.COM');
  const dupe = await api(base, 'POST', '/api/signup', { username: 'zee@example.com', password: 'another password' });
  assert.equal(dupe.status, 409);

  const phone = await api(base, 'POST', '/api/signup', { username: '+91 98765-43210', password: 'phone password!' });
  assert.equal(phone.status, 201);
  assert.equal(phone.json['username'], '+919876543210');
  assert.equal(phone.json['usernameType'], 'phone');
  const phoneDupe = await api(base, 'POST', '/api/signup', { username: '919876543210', password: 'phone password!' });
  assert.equal(phoneDupe.status, 409);

  const junk = await api(base, 'POST', '/api/signup', { username: 'not an identifier', password: 'phone password!' });
  assert.equal(junk.status, 400);
});

test('wrong password and unknown account get the same answer, and are rate limited', async () => {
  const { base } = await startRelay();
  await signupWithTokens(base, 'limited@example.com');
  const wrong = await api(base, 'POST', '/api/login', { username: 'limited@example.com', password: 'nope nope nope' });
  const unknown = await api(base, 'POST', '/api/login', { username: 'nobody@example.com', password: 'nope nope nope' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.json, unknown.json);

  let last = 0;
  for (let i = 0; i < 12; i += 1) {
    last = (await api(base, 'POST', '/api/login', { username: 'limited@example.com', password: 'nope nope nope' })).status;
  }
  assert.equal(last, 429);
});

test('a cookie-authenticated POST from a foreign origin is refused', async () => {
  const { base } = await startRelay('https://bridge.example.com');
  const { cookie } = await signupWithTokens(base);
  const foreign = await api(base, 'POST', '/api/tokens/client', {}, cookie, { Origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  const own = await api(base, 'POST', '/api/tokens/client', {}, cookie, { Origin: 'https://bridge.example.com' });
  assert.equal(own.status, 200);
});
