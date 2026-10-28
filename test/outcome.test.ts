import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HealthStore } from '../src/agents/health.js';
import { cleanDiagnostics, classifyFailure, selfReportedFailure } from '../src/agents/outcome.js';
import { AgentRegistry, type AgentStatus } from '../src/agents/registry.js';
import type { AgentResult } from '../src/agents/types.js';
import type { Config } from '../src/config.js';
import { ConcurrencyLimit } from '../src/limit.js';
import { TaskStore } from '../src/tasks.js';
import { executeTool } from '../src/tools.js';
import { FIXTURE } from './helpers.js';

const PROMPT =
  'Read lib/main.dart, lib/router.dart and pubspec.yaml in this Flutter repository and explain, in under ' +
  '400 words, how navigation is wired, naming the files and functions involved.';

function setup(health = new HealthStore()) {
  const agent = (mode: string) => ({ command: [process.execPath, FIXTURE, mode, '{prompt}'], timeoutMs: 20_000 });
  const config: Config = {
    maxOutputChars: 60_000, maxConcurrent: 4,
    agents: { codexish: agent('quota'), agyish: agent('blocked'), geminiish: agent('untrusted'), sleepy: agent('sleep:15000'), echo: agent('echo') },
  };
  const limit = new ConcurrencyLimit(4);
  const context = { registry: new AgentRegistry(config, health), tasks: new TaskStore(limit), limit };
  const ask = (agentName: string, extra: Record<string, unknown> = {}) =>
    executeTool('ask_agent', { agent: agentName, prompt: PROMPT, ...extra }, context) as Promise<AgentResult>;
  const status = async (name: string) =>
    ((await executeTool('list_agents', {}, context)) as AgentStatus[]).find((a) => a.name === name)!;
  return { context, ask, status, health };
}

test('a run that exited 0 but says it did nothing is a failure, with its own words quoted', async () => {
  const { ask } = setup();
  const result = await ask('agyish', { workingDirectory: process.cwd() });

  assert.equal(result.succeeded, false);
  assert.match(result.diagnostics, /exited normally, but its answer says it could not do the task/);
  assert.match(result.diagnostics, /blocked from inspecting your files/);
  assert.match(result.output, /every tool execution is failing/, 'the explanation is kept, not thrown away');
  assert.match(result.notes, /printed errors while running/);
  assert.match(result.notes, /PreToolUse hook failed/);
});

test('a quota failure: lean diagnostics, then remembered by list_agents until a success clears it', async () => {
  const { ask, status, health } = setup();
  const before = await status('codexish');
  assert.equal(before.status, 'ready');
  assert.equal(before.calls, 0);

  const result = await ask('codexish');
  assert.equal(result.succeeded, false);
  assert.ok(!result.diagnostics.includes(PROMPT), 'the caller\'s own prompt is not handed back');
  assert.equal(result.diagnostics.match(/usage limit/g)?.length, 1, 'the error appears once');
  assert.ok(result.diagnostics.length < 600, `diagnostics stayed short: ${result.diagnostics.length}`);

  const after = await status('codexish');
  assert.equal(after.available, false);
  assert.equal(after.status, 'quota-exhausted');
  assert.equal(after.retryAt, '4:22 AM');
  assert.match(after.detail, /usage limit reached on the last call/);
  assert.match(after.lastError!, /exited with code 1/);
  assert.ok(after.lastErrorAt);

  // a later success clears it -- even one that lands in the same millisecond, which is
  // what CI's fast runners did to an earlier version that compared timestamps
  const failedAt = Date.parse(after.lastErrorAt!);
  health.record('codexish', { agent: 'codexish', succeeded: true, output: 'ok', diagnostics: '', notes: '', durationMs: 1, timedOut: false, outputTruncated: false }, failedAt);
  const healed = await status('codexish');
  assert.equal(healed.status, 'ready');
  assert.equal(healed.available, true);
  assert.equal(healed.calls, 2);
  assert.ok(healed.lastSuccessAt);
});

test('an untrusted-directory refusal names the remedy without the bridge trusting anything itself', async () => {
  const { ask, status } = setup();
  const result = await ask('geminiish', { workingDirectory: process.cwd() });

  assert.equal(result.succeeded, false);
  assert.match(result.diagnostics, /does not trust them on its behalf/);
  assert.match(result.diagnostics, /"env": \{ "GEMINI_CLI_TRUST_WORKSPACE": "true" \}/);
  assert.equal((await status('geminiish')).status, 'directory-not-trusted');
});

test('timeoutSeconds bounds one call, and a timeout does not mark the agent broken', async () => {
  const { ask, status } = setup();
  const started = Date.now();
  const result = await ask('sleepy', { timeoutSeconds: 1 });

  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 8_000, 'stopped near the requested bound, not the configured one');
  assert.equal((await status('sleepy')).status, 'ready');
});

test('an ordinary answer is left alone, including one that talks about errors in the code', async () => {
  const { ask } = setup();
  const ok = await ask('echo');
  assert.equal(ok.succeeded, true);
  assert.equal(ok.notes, '');

  assert.equal(selfReportedFailure('The loader throws "permission denied" when it cannot read the file, so wrap it in a try block.'), null);
  assert.equal(selfReportedFailure('I could not find any call to Navigator.push; routing goes through go_router in lib/router.dart.'), null);
  assert.ok(selfReportedFailure("I'm unable to read the files in this directory because access was denied."));
});

test('failures are sorted into kinds a caller can act on', () => {
  assert.deepEqual(classifyFailure("ERROR: You've hit your usage limit. try again at 4:22 AM."), { kind: 'quota', retryAt: '4:22 AM' });
  assert.equal(classifyFailure('API error (status 402 Payment Required): Grok Build usage balance exhausted').kind, 'quota');
  assert.equal(classifyFailure('Error authenticating: IneligibleTierError: This client is no longer supported').kind, 'auth');
  assert.equal(classifyFailure('not running in a trusted directory').kind, 'trust');
  assert.equal(classifyFailure('segfault').kind, 'other');

  const noisy = Array.from({ length: 200 }, (_, i) => `banner line ${i}`).join('\n') + '\nERROR: the real problem\n';
  const cleaned = cleanDiagnostics(noisy, 'irrelevant prompt text here');
  assert.match(cleaned, /ERROR: the real problem/);
  assert.ok(cleaned.length <= 1_520);
});
