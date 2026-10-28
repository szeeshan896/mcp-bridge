import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { WebSocketServer, type WebSocket } from 'ws';

import { AgentRegistry } from '../src/agents/registry.js';
import type { Config } from '../src/config.js';
import { connectToRelay, toWebSocketUrl } from '../src/connect.js';
import { ConcurrencyLimit } from '../src/limit.js';
import { parseAgentMessage, type AgentToRelay } from '../src/protocol.js';
import { TaskStore } from '../src/tasks.js';
import type { ToolContext } from '../src/tools.js';
import { echoCommand } from './helpers.js';

function context(): ToolContext {
  const config: Config = {
    maxOutputChars: 60_000, maxConcurrent: 2,
    agents: { echoer: { command: echoCommand, timeoutMs: 10_000 } },
  };
  const limit = new ConcurrencyLimit(2);
  return { registry: new AgentRegistry(config), tasks: new TaskStore(limit), limit };
}

/** A stand-in relay: records what the agent sends and lets the test drive the socket. */
async function fakeRelay() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const sockets: WebSocket[] = [];
  const authHeaders: (string | undefined)[] = [];
  const inbox: AgentToRelay[] = [];
  server.on('connection', (socket, request) => {
    sockets.push(socket);
    authHeaders.push(request.headers.authorization);
    socket.on('message', (data) => {
      const message = parseAgentMessage(data.toString());
      if (message) inbox.push(message);
    });
  });
  const waitFor = async <T extends AgentToRelay['type']>(type: T, attempts = 100) => {
    for (let i = 0; i < attempts; i += 1) {
      const found = inbox.find((m) => m.type === type);
      if (found) return found as Extract<AgentToRelay, { type: T }>;
      await sleep(30);
    }
    throw new Error(`never received ${type}`);
  };
  return {
    url: `http://127.0.0.1:${port}`, sockets, authHeaders, inbox, waitFor,
    // the http server underneath only reports closed once every connection is gone, so a
    // client still mid-handshake would hold the test open; dropping them first cannot hang
    close: () => new Promise<void>((resolve) => {
      for (const socket of server.clients) socket.terminate();
      server.close(() => resolve());
    }),
  };
}

test('converts an http origin to the relay agent endpoint', () => {
  assert.equal(toWebSocketUrl('https://bridge.example.com'), 'wss://bridge.example.com/agent');
  assert.equal(toWebSocketUrl('http://127.0.0.1:8080'), 'ws://127.0.0.1:8080/agent');
  assert.equal(toWebSocketUrl('wss://x.test/custom'), 'wss://x.test/custom');
});

test('presents the token, introduces itself with its agents, and answers a call', async () => {
  const relay = await fakeRelay();
  const controller = new AbortController();
  const run = connectToRelay({
    relayUrl: relay.url, token: 'agent-secret', device: 'test-laptop', agentVersion: '0.1.0',
    context: context(), log: () => {}, signal: controller.signal,
  });

  const hello = await relay.waitFor('hello');
  assert.equal(relay.authHeaders[0], 'Bearer agent-secret');
  assert.equal(hello.device, 'test-laptop');
  assert.deepEqual(hello.agents.map((a) => a.name), ['echoer']);

  const socket = relay.sockets[0]!;
  socket.send(JSON.stringify({ type: 'welcome', device: 'test-laptop' }));
  socket.send(JSON.stringify({ type: 'call', id: 'c1', tool: 'ask_agent', args: { agent: 'echoer', prompt: 'ping' } }));

  const result = await relay.waitFor('result');
  assert.equal(result.id, 'c1');
  assert.equal(result.ok, true);
  assert.equal((result.payload as { output: string }).output, 'ping');

  controller.abort();
  await run;
  await relay.close();
});

test('reconnects after the relay drops the socket', async () => {
  const relay = await fakeRelay();
  const controller = new AbortController();
  const run = connectToRelay({
    relayUrl: relay.url, token: 't', device: 'd', agentVersion: '0',
    context: context(), log: () => {}, signal: controller.signal,
  });

  await relay.waitFor('hello');
  relay.sockets[0]!.send(JSON.stringify({ type: 'welcome', device: 'd' }));
  await sleep(50);
  relay.sockets[0]!.close(1012, 'restarting');

  // the backoff after a welcomed session is the minimum, about a second
  for (let i = 0; i < 100 && relay.sockets.length < 2; i += 1) await sleep(50);
  assert.ok(relay.sockets.length >= 2, 'the agent did not come back');

  controller.abort();
  await run;
  await relay.close();
});

test('a goodbye that says not to retry ends the loop', async () => {
  const relay = await fakeRelay();
  const run = connectToRelay({
    relayUrl: relay.url, token: 't', device: 'd', agentVersion: '0',
    context: context(), log: () => {},
  });
  await relay.waitFor('hello');
  relay.sockets[0]!.send(JSON.stringify({ type: 'goodbye', reason: 'token revoked', retry: false }));

  await Promise.race([run, sleep(5_000).then(() => { throw new Error('kept running'); })]);
  await relay.close();
});

test('a 4001 close — a refused token — is not retried', async () => {
  const relay = await fakeRelay();
  const run = connectToRelay({
    relayUrl: relay.url, token: 'bad', device: 'd', agentVersion: '0',
    context: context(), log: () => {},
  });
  await relay.waitFor('hello');
  relay.sockets[0]!.close(4001, 'unauthorized');

  await Promise.race([run, sleep(5_000).then(() => { throw new Error('kept retrying a bad token'); })]);
  assert.equal(relay.sockets.length, 1);
  await relay.close();
});

test('a tool that throws comes back as ok:false, not a dead socket', async () => {
  const relay = await fakeRelay();
  const controller = new AbortController();
  const ctx = context();
  ctx.registry.find = () => { throw new Error('registry exploded'); };
  const run = connectToRelay({
    relayUrl: relay.url, token: 't', device: 'd', agentVersion: '0',
    context: ctx, log: () => {}, signal: controller.signal,
  });
  await relay.waitFor('hello');
  relay.sockets[0]!.send(JSON.stringify({ type: 'call', id: 'x', tool: 'ask_agent', args: { agent: 'a', prompt: 'p' } }));

  const result = await relay.waitFor('result');
  assert.equal(result.ok, false);
  assert.match(String(result.payload), /registry exploded/);

  controller.abort();
  await run;
  await relay.close();
});
