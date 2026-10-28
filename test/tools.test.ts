import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { AgentRegistry } from '../src/agents/registry.js';
import type { Config } from '../src/config.js';
import { ConcurrencyLimit } from '../src/limit.js';
import { TaskStore } from '../src/tasks.js';
import { executeTool, isToolName, type ToolContext } from '../src/tools.js';
import { echoCommand } from './helpers.js';

function context(): ToolContext {
  const config: Config = {
    maxOutputChars: 60_000, maxConcurrent: 2,
    agents: { echoer: { command: echoCommand, timeoutMs: 10_000 } },
  };
  const limit = new ConcurrencyLimit(2);
  return { registry: new AgentRegistry(config), tasks: new TaskStore(limit), limit };
}

test('list_agents returns statuses', async () => {
  const statuses = (await executeTool('list_agents', {}, context())) as { name: string }[];
  assert.deepEqual(statuses.map((s) => s.name), ['echoer']);
});

test('ask_agent delegates and returns the result', async () => {
  const result = (await executeTool('ask_agent', { agent: 'echoer', prompt: 'hi' }, context())) as { output: string };
  assert.equal(result.output, 'hi');
});

test('ask_agent names the available agents for an unknown one', async () => {
  const result = (await executeTool('ask_agent', { agent: 'ghost', prompt: 'hi' }, context())) as { diagnostics: string };
  assert.match(result.diagnostics, /no agent named "ghost"/);
  assert.match(result.diagnostics, /echoer/);
});

test('start_task then get_task completes', async () => {
  const ctx = context();
  const started = (await executeTool('start_task', { agent: 'echoer', prompt: 'later' }, ctx)) as { id: string; started: boolean };
  assert.equal(started.started, true);
  let task = (await executeTool('get_task', { id: started.id }, ctx)) as { status: string; result?: { output: string } };
  for (let i = 0; i < 60 && task.status !== 'finished'; i += 1) {
    await sleep(50);
    task = (await executeTool('get_task', { id: started.id }, ctx)) as typeof task;
  }
  assert.equal(task.result?.output, 'later');
});

test('get_task on nothing says so', async () => {
  const missing = (await executeTool('get_task', { id: 'nope' }, context())) as { found: boolean };
  assert.equal(missing.found, false);
});

test('isToolName guards the four names', () => {
  assert.equal(isToolName('ask_agent'), true);
  assert.equal(isToolName('exec'), false);
});
