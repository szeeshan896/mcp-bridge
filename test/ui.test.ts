import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { WebSocketServer } from 'ws';

import { parseAgentMessage, type AgentToRelay } from '../src/protocol.js';
import { applySecretsToEnv, loadSecrets, maskSecret } from '../src/secrets.js';
import { startUi, type UiServer } from '../src/ui/server.js';
import { echoCommand } from './helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

/** A provider with the OpenAI shape: lists two models, answers "OK" to a known key only. */
async function fakeProvider(expectedKey: string) {
  const seen: { path: string; auth: string | undefined; body: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ path: req.url ?? '', auth: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${expectedKey}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'bad key' } }));
        return;
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'meta/llama-z' }, { id: 'meta/llama-a' }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, seen };
}

async function fakeRelay() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => server.on('listening', r));
  const sessions: { auth: string | undefined; inbox: AgentToRelay[] }[] = [];
  server.on('connection', (socket, request) => {
    const session = { auth: request.headers.authorization, inbox: [] as AgentToRelay[] };
    sessions.push(session);
    socket.on('message', (data) => {
      const message = parseAgentMessage(data.toString());
      if (!message) return;
      session.inbox.push(message);
      if (message.type === 'hello') socket.send(JSON.stringify({ type: 'welcome', device: message.device }));
    });
  });
  cleanups.push(() => new Promise((r) => { for (const c of server.clients) c.terminate(); server.close(() => r()); }));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, sessions };
}

async function launch(files?: { config?: unknown }) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpbridge-ui-'));
  const configFile = join(dir, 'config.json');
  const secretsFile = join(dir, 'secrets.json');
  if (files?.config) writeFileSync(configFile, JSON.stringify(files.config));
  const ui = await startUi({ port: 0, agentVersion: 'test', configFile, secretsFile, log: () => {} });
  cleanups.push(() => ui.close());
  const origin = `http://127.0.0.1:${ui.port}`;

  // what the browser does with the printed link: trade the key for a cookie
  const entry = await fetch(ui.url, { redirect: 'manual' });
  assert.equal(entry.status, 303);
  const cookie = entry.headers.get('set-cookie')!.split(';')[0]!;
  assert.match(entry.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);

  const call = async (path: string, body?: unknown) => {
    const res = await fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, 'X-MCPBridge-UI': '1', 'Content-Type': 'application/json', Origin: origin },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { ui, origin, cookie, call, configFile, secretsFile };
}

test('only the launch link opens it, and only from this machine', async () => {
  const { ui, origin, cookie } = await launch();

  assert.equal((await fetch(`${origin}/`)).status, 403, 'no cookie, no page');
  assert.equal((await fetch(`${origin}/?k=wrong`)).status, 403);
  const page = await fetch(`${origin}/`, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy')!, /default-src 'none'/);
  assert.match(await page.text(), /Relay connection/);

  // the API needs the cookie and the header a cross-site form cannot send
  assert.equal((await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await fetch(`${origin}/api/state`, { headers: { 'X-MCPBridge-UI': '1' } })).status, 403);
  const foreign = await fetch(`${origin}/api/relay/disconnect`, {
    method: 'POST', headers: { Cookie: cookie, 'X-MCPBridge-UI': '1', Origin: 'https://evil.example' }, body: '{}',
  });
  assert.equal(foreign.status, 403);

  // DNS rebinding arrives with someone else's host name
  const rebound = await new Promise<number>((resolve) => {
    const req = (async () => {
      const { request } = await import('node:http');
      const r = request({ host: '127.0.0.1', port: ui.port, path: '/', headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0));
      r.end();
    })();
    void req;
  });
  assert.equal(rebound, 403);
});

test('an API agent added here: its key is saved apart from the config, listed models, and it answers', async () => {
  const { call, configFile, secretsFile } = await launch();
  const key = 'nvapi-test-1234567890abcd';
  const provider = await fakeProvider(key);

  const models = await call('/api/models', { baseUrl: provider.baseUrl, apiKey: key });
  assert.equal(models.status, 200, JSON.stringify(models.json));
  assert.deepEqual(models.json['models'], ['meta/llama-a', 'meta/llama-z']);

  const saved = await call('/api/agents/save', {
    name: 'nvidia', kind: 'openai', baseUrl: provider.baseUrl, model: 'meta/llama-a',
    apiKeyEnv: 'MCPBRIDGE_UITEST_NVIDIA_KEY', apiKey: key, description: 'NVIDIA test',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));

  // the config names the variable; only the secrets file holds the key
  const config = readFileSync(configFile, 'utf8');
  assert.match(config, /MCPBRIDGE_UITEST_NVIDIA_KEY/);
  assert.doesNotMatch(config, new RegExp(key));
  assert.equal(loadSecrets(secretsFile).keys['MCPBRIDGE_UITEST_NVIDIA_KEY'], key);

  const state = await call('/api/state');
  const nvidia = state.json['agents'].find((a: { name: string }) => a.name === 'nvidia');
  assert.equal(nvidia.available, true, nvidia.detail);
  assert.equal(nvidia.origin, 'yours');
  assert.equal(nvidia.key.saved, '••••abcd');
  assert.doesNotMatch(JSON.stringify(state.json), new RegExp(key), 'the key never goes back to the page');
  assert.ok(state.json['agents'].some((a: { name: string; origin: string }) => a.name === 'claude' && a.origin === 'built-in'));

  const tested = await call('/api/agents/test', { name: 'nvidia' });
  assert.equal(tested.json['succeeded'], true, JSON.stringify(tested.json));
  assert.equal(tested.json['output'], 'OK');

  const removed = await call('/api/agents/remove', { name: 'nvidia' });
  assert.equal(removed.status, 200);
  const after = await call('/api/state');
  assert.ok(!after.json['agents'].some((a: { name: string }) => a.name === 'nvidia'));
  assert.equal((await call('/api/agents/remove', { name: 'claude' })).status, 400, 'built-ins stay');
});

test('a config the bridge would reject is refused before it is written', async () => {
  const { call, configFile } = await launch({ config: { maxConcurrent: 3, agents: { mine: { command: echoCommand } } } });

  const noPlaceholder = await call('/api/agents/save', { name: 'bad', kind: 'cli', command: ['tool', '--flag'] });
  assert.equal(noPlaceholder.status, 400);
  assert.match(noPlaceholder.json['error'], /\{prompt\}/);
  const plainHttp = await call('/api/agents/save', { name: 'bad', kind: 'openai', baseUrl: 'http://example.com/v1' });
  assert.equal(plainHttp.status, 400);
  const badName = await call('/api/agents/save', { name: 'Bad Name', kind: 'ollama' });
  assert.equal(badName.status, 400);

  // what was already in the file survives every edit
  const ok = await call('/api/agents/save', { name: 'echo2', kind: 'cli', command: echoCommand });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const file = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(file.maxConcurrent, 3);
  assert.ok(file.agents.mine);
  assert.ok(file.agents.echo2);
  assert.ok(!file.agents.bad);

  const tested = await call('/api/agents/test', { name: 'echo2' });
  assert.equal(tested.json['succeeded'], true);
  assert.match(tested.json['output'], /OK/);
});

test('connects to the relay from saved settings, and a new agent reaches the relay at once', async () => {
  const relay = await fakeRelay();
  const { call, secretsFile } = await launch();

  assert.equal((await call('/api/relay/save', { url: relay.url, token: 'not-an-agent-token' })).status, 400);
  const saved = await call('/api/relay/save', { url: relay.url, token: 'mba_testtoken123456', device: 'ui-box' });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(loadSecrets(secretsFile).relay?.token, 'mba_testtoken123456');

  let state = await call('/api/state');
  for (let i = 0; i < 100 && state.json['connection'].state !== 'connected'; i += 1) {
    await sleep(30);
    state = await call('/api/state');
  }
  assert.equal(state.json['connection'].state, 'connected');
  assert.equal(state.json['connection'].device, 'ui-box');
  assert.equal(state.json['relay'].token, '••••3456');
  assert.equal(relay.sessions[0]!.auth, 'Bearer mba_testtoken123456');

  await call('/api/agents/save', { name: 'echo3', kind: 'cli', command: echoCommand });
  for (let i = 0; i < 100 && relay.sessions.length < 2; i += 1) await sleep(30);
  for (let i = 0; i < 100 && !relay.sessions.at(-1)!.inbox.some((m) => m.type === 'hello'); i += 1) await sleep(30);
  const hello = relay.sessions.at(-1)!.inbox.find((m) => m.type === 'hello');
  assert.ok(hello && hello.type === 'hello' && hello.agents.some((a) => a.name === 'echo3'), 'the relay sees the new agent');

  const stopped = await call('/api/relay/disconnect', {});
  assert.equal(stopped.status, 200);
  assert.equal((await call('/api/state')).json['connection'].state, 'stopped');
});

test('saved keys reach the environment without overriding one already exported', () => {
  const env: NodeJS.ProcessEnv = { ALREADY: 'from-shell' };
  applySecretsToEnv({ keys: { ALREADY: 'saved', FRESH: 'saved-fresh' } }, env);
  assert.equal(env['ALREADY'], 'from-shell');
  assert.equal(env['FRESH'], 'saved-fresh');
  assert.equal(maskSecret('sk-abcdefgh1234'), '••••1234');
  assert.equal(maskSecret('short'), '••••');
  assert.equal(maskSecret(undefined), null);
});
