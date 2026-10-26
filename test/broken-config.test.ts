import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AgentRegistry } from '../src/agents/registry.js';
import type { Config } from '../src/config.js';

/**
 * One bad entry used to throw while the registry was built, which killed the process --
 * taking every correctly configured agent with it, and over stdio leaving the client with
 * a dead server and no reason.
 */
const withOneTypo: Config = {
  maxOutputChars: 60_000,
  maxConcurrent: 2,
  agents: {
    broken: { command: [] },
    alsoBroken: { command: ['some-cli', '--go'] },
    noBaseUrl: { type: 'openai', model: 'm' } as never,
    working: { command: [process.execPath, '{prompt}'], timeoutMs: 5_000 },
  },
};

test('a misconfigured agent does not stop the registry being built', () => {
  assert.doesNotThrow(() => new AgentRegistry(withOneTypo));
});

test('the agents that are fine still work', async () => {
  const registry = new AgentRegistry(withOneTypo);
  const statuses = await registry.statuses();
  const byName = Object.fromEntries(statuses.map((s) => [s.name, s]));

  assert.equal(byName['working']?.available, true);
});

test('each broken agent says what is wrong with it', async () => {
  const registry = new AgentRegistry(withOneTypo);
  const byName = Object.fromEntries((await registry.statuses()).map((s) => [s.name, s]));

  assert.equal(byName['broken']?.available, false);
  assert.match(byName['broken']?.detail ?? '', /must not be empty/);

  assert.equal(byName['alsobroken']?.available, false);
  assert.match(byName['alsobroken']?.detail ?? '', /\{prompt\}/);

  assert.equal(byName['nobaseurl']?.available, false);
  assert.match(byName['nobaseurl']?.detail ?? '', /baseUrl/);
});

test('delegating to a broken agent fails with the configuration error', async () => {
  const registry = new AgentRegistry(withOneTypo);

  const result = await registry.find('broken')!.run('do a thing', {});

  assert.equal(result.succeeded, false);
  assert.match(result.diagnostics, /misconfigured/);
  assert.match(result.diagnostics, /must not be empty/);
});
