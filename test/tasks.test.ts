import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { CliAgent } from '../src/agents/cli.js';
import type { Agent } from '../src/agents/types.js';
import { ConcurrencyLimit } from '../src/limit.js';
import { TaskStore } from '../src/tasks.js';
import { echoCommand } from './helpers.js';

const echoer = new CliAgent('echoer', { command: echoCommand, timeoutMs: 10_000 }, 60_000);

async function settle(store: TaskStore, id: string, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    if (store.get(id)?.status === 'finished') return store.get(id);
    await sleep(50);
  }
  return store.get(id);
}

test('start returns an id before the work is done', () => {
  const store = new TaskStore(new ConcurrencyLimit(2));

  const task = store.start(echoer, 'hello', {});

  assert.ok(task.id);
  assert.equal(task.status, 'running');
});

test('the task reaches finished and carries the result', async () => {
  const store = new TaskStore(new ConcurrencyLimit(2));

  const { id } = store.start(echoer, 'delegated work', {});
  const task = await settle(store, id);

  assert.equal(task?.status, 'finished');
  assert.equal(task?.result?.output, 'delegated work');
  assert.ok(task?.finishedAt);
});

test('an agent that throws becomes a finished task with diagnostics, not a lost one', async () => {
  const store = new TaskStore(new ConcurrencyLimit(2));
  const exploding: Agent = {
    name: 'exploding',
    description: 'throws',
    requires: 'nothing',
    probe: async () => ({ available: true, detail: '' }),
    run: async () => { throw new Error('boom'); },
  };

  const { id } = store.start(exploding, 'x', {});
  const task = await settle(store, id);

  assert.equal(task?.status, 'finished');
  assert.equal(task?.result?.succeeded, false);
  assert.match(task?.result?.diagnostics ?? '', /boom/);
});

test('an unknown id is simply absent', () => {
  assert.equal(new TaskStore(new ConcurrencyLimit(2)).get('no-such-id'), undefined);
});
