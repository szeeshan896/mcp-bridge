import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AgentRegistry } from '../src/agents/registry.js';
import type { Config } from '../src/config.js';
import { echoCommand } from './helpers.js';

const config: Config = {
  maxOutputChars: 60_000,
  maxConcurrent: 2,
  agents: {
    echoer: { description: 'echoes', command: echoCommand, timeoutMs: 5_000 },
    ghost: { description: 'absent', command: ['nope-xyz-123', '{prompt}'], timeoutMs: 5_000 },
    local: { type: 'ollama', description: 'local model', baseUrl: 'http://127.0.0.1:1' },
  },
};

test('resolves names case-insensitively', () => {
  const registry = new AgentRegistry(config);

  assert.equal(registry.find('ECHOER')?.name, 'echoer');
  assert.equal(registry.find('  echoer  ')?.name, 'echoer');
  assert.equal(registry.find('nobody'), undefined);
});

test('lists every configured agent', () => {
  assert.deepEqual(new AgentRegistry(config).names(), ['echoer', 'ghost', 'local']);
});

test('says which agents are usable and why not', async () => {
  const statuses = await new AgentRegistry(config).statuses();

  const byName = Object.fromEntries(statuses.map((s) => [s.name, s]));
  assert.equal(byName['echoer']?.available, true);
  assert.equal(byName['ghost']?.available, false);
  assert.match(byName['ghost']?.detail ?? '', /not on PATH/);
  // nothing is serving on port 1, so the local model must report unreachable
  assert.equal(byName['local']?.available, false);
  assert.match(byName['local']?.detail ?? '', /ollama serve/);
});
