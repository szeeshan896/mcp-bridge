import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DEFAULT_CONFIG, loadConfig } from '../src/config.js';

function tempFile(name: string, contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'mcpbridge-')), name);
  writeFileSync(path, contents);
  return path;
}

test('falls back to defaults when there is no config file', () => {
  const { config, source } = loadConfig(join(tmpdir(), 'definitely-absent-mcpbridge.json'));

  assert.equal(config, DEFAULT_CONFIG);
  assert.match(source, /defaults/);
});

test('ships usable defaults so it works with no configuration', () => {
  assert.deepEqual(
    Object.keys(DEFAULT_CONFIG.agents).sort(),
    ['antigravity', 'claude', 'codex', 'gemini', 'ollama'],
  );
});

test('every default agent is one the registry can actually build', async () => {
  // a default with a malformed command would ship as a BrokenAgent and nobody would
  // notice until a user ran --agents
  const { AgentRegistry } = await import('../src/agents/registry.js');
  const registry = new AgentRegistry(DEFAULT_CONFIG);

  for (const status of await registry.statuses()) {
    assert.doesNotMatch(status.detail, /misconfigured/, status.name);
  }
});

test('adds agents from the file and keeps the defaults', () => {
  const path = tempFile('config.json', JSON.stringify({
    agents: { mine: { command: ['my-cli', '{prompt}'] } },
  }));

  const { config } = loadConfig(path);

  assert.ok(config.agents['mine'], 'the configured agent should be present');
  assert.ok(config.agents['claude'], 'defaults should survive');
});

test('an overridden agent replaces the default outright', () => {
  const path = tempFile('config.json', JSON.stringify({
    agents: { gemini: { command: ['gemini', 'run', '{prompt}'] } },
  }));

  const { config } = loadConfig(path);
  const gemini = config.agents['gemini'];

  // a field-by-field merge would leave the default's -p behind
  assert.deepEqual(gemini && 'command' in gemini ? gemini.command : [], ['gemini', 'run', '{prompt}']);
});

test('says which file is bad rather than silently using defaults', () => {
  const path = tempFile('config.json', '{ not json');

  assert.throws(() => loadConfig(path), /is not valid JSON/);
});
