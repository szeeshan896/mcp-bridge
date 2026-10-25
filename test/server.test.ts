import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { AgentRegistry } from '../src/agents/registry.js';
import type { Config } from '../src/config.js';
import { createServer } from '../src/server.js';
import { TaskStore } from '../src/tasks.js';

const config: Config = {
  maxOutputChars: 60_000,
  agents: {
    echoer: { description: 'echoes back', command: ['echo', '{prompt}'], timeoutMs: 10_000 },
    ghost: { description: 'absent', command: ['nope-xyz-123', '{prompt}'], timeoutMs: 5_000 },
  },
};

/** A real client talking to a real server, the way a connected agent would. */
async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(new AgentRegistry(config), new TaskStore());
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const first = (result.content as { type: string; text: string }[])[0];
  return JSON.parse(first!.text) as T;
}

test('exposes exactly the four delegation tools', async () => {
  const { client, close } = await connect();
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['ask_agent', 'get_task', 'list_agents', 'start_task']);
  } finally {
    await close();
  }
});

test('every tool carries a description, since the model picks from those', async () => {
  const { client, close } = await connect();
  try {
    for (const tool of (await client.listTools()).tools) {
      assert.ok((tool.description ?? '').length > 40, `${tool.name} needs a real description`);
    }
  } finally {
    await close();
  }
});

test('ask_agent delegates and returns the answer in one call', async () => {
  const { client, close } = await connect();
  try {
    const result = await call<{ succeeded: boolean; output: string }>(
      client, 'ask_agent', { agent: 'echoer', prompt: 'refactor the OrderService' });

    assert.equal(result.succeeded, true);
    assert.equal(result.output, 'refactor the OrderService');
  } finally {
    await close();
  }
});

test('an unknown agent is answered with the ones that exist', async () => {
  const { client, close } = await connect();
  try {
    const result = await call<{ succeeded: boolean; diagnostics: string }>(
      client, 'ask_agent', { agent: 'grok', prompt: 'hello' });

    assert.equal(result.succeeded, false);
    assert.match(result.diagnostics, /no agent named "grok"/);
    assert.match(result.diagnostics, /echoer/);
  } finally {
    await close();
  }
});

test('list_agents reports availability per agent', async () => {
  const { client, close } = await connect();
  try {
    const statuses = await call<{ name: string; available: boolean }[]>(client, 'list_agents', {});

    assert.deepEqual(statuses.map((s) => s.name), ['echoer', 'ghost']);
    assert.equal(statuses.find((s) => s.name === 'echoer')?.available, true);
    assert.equal(statuses.find((s) => s.name === 'ghost')?.available, false);
  } finally {
    await close();
  }
});

test('start_task returns an id that get_task resolves to a result', async () => {
  const { client, close } = await connect();
  try {
    const started = await call<{ started: boolean; id: string }>(
      client, 'start_task', { agent: 'echoer', prompt: 'long job' });
    assert.equal(started.started, true);

    let task = await call<{ status: string; result?: { output: string } }>(
      client, 'get_task', { id: started.id });
    for (let i = 0; i < 60 && task.status !== 'finished'; i += 1) {
      await sleep(50);
      task = await call(client, 'get_task', { id: started.id });
    }

    assert.equal(task.status, 'finished');
    assert.equal(task.result?.output, 'long job');
  } finally {
    await close();
  }
});

test('get_task on an expired id says so rather than failing', async () => {
  const { client, close } = await connect();
  try {
    const task = await call<{ found: boolean }>(client, 'get_task', { id: 'no-such-id' });
    assert.equal(task.found, false);
  } finally {
    await close();
  }
});

test('bad arguments come back as a tool error naming the field', async () => {
  const { client, close } = await connect();
  try {
    for (const args of [
      { agent: 'echoer', prompt: '' },
      { agent: 'echoer' },
      { prompt: 'x' },
    ]) {
      const result = await client.callTool({ name: 'ask_agent', arguments: args as never });
      const text = (result.content as { text: string }[])[0]?.text ?? '';

      assert.equal(result.isError, true, `${JSON.stringify(args)} should be an error`);
      assert.match(text, /validation error/i);
    }
  } finally {
    await close();
  }
});
