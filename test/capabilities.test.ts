import assert from 'node:assert/strict';
import { copyFileSync, linkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { permissionsFor } from '../src/agents/permissions.js';
import { AgentRegistry, type AgentStatus } from '../src/agents/registry.js';
import type { AgentResult } from '../src/agents/types.js';
import type { AgentConfig, Config } from '../src/config.js';
import { ConcurrencyLimit } from '../src/limit.js';
import { TaskStore, type Task } from '../src/tasks.js';
import { executeTool } from '../src/tools.js';
import { FIXTURE } from './helpers.js';

/** node under another name, so the bridge recognises it as that CLI and adds its flags */
function nodeNamed(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcpbridge-cli-'));
  const target = join(dir, process.platform === 'win32' ? `${name}.exe` : name);
  try { linkSync(process.execPath, target); } catch { copyFileSync(process.execPath, target); }
  return target;
}

function setup(agents: Record<string, AgentConfig>, maxConcurrent = 4) {
  const config: Config = { maxOutputChars: 60_000, maxConcurrent, agents };
  const limit = new ConcurrencyLimit(maxConcurrent);
  const context = { registry: new AgentRegistry(config), tasks: new TaskStore(limit), limit };
  return {
    context,
    ask: (agent: string, extra: Record<string, unknown> = {}) =>
      executeTool('ask_agent', { agent, prompt: 'review payment.ts', ...extra }, context) as Promise<AgentResult>,
    start: (agent: string, extra: Record<string, unknown> = {}) =>
      executeTool('start_task', { agent, prompt: 'review payment.ts', ...extra }, context) as Promise<{ id: string; status: string; queuePosition?: number; notes?: string }>,
    get: (id: string) => executeTool('get_task', { id }, context) as Promise<Task>,
    list: async () => (await executeTool('list_agents', {}, context)) as AgentStatus[],
  };
}

const fixture = (mode: string, extra: Partial<AgentConfig> = {}): AgentConfig =>
  ({ command: [process.execPath, FIXTURE, mode, '{prompt}'], timeoutMs: 20_000, ...extra }) as AgentConfig;

test('each known CLI gets its own flags for what its owner allowed, and nothing by default', () => {
  const cmd = (exe: string) => [exe, '-p', '{prompt}'];
  assert.deepEqual(permissionsFor({ command: cmd('claude') }).args, []);
  assert.deepEqual(permissionsFor({ command: cmd('claude'), allow: { edits: true, commands: true } }).args,
    ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash']);
  assert.deepEqual(permissionsFor({ command: ['C:\\tools\\codex.exe', 'exec', '{prompt}'], allow: { edits: true } }).args, ['--sandbox', 'workspace-write']);
  assert.equal(permissionsFor({ command: cmd('codex'), allow: { edits: true } }).runsCommands, true, 'one sandbox setting covers both');
  assert.deepEqual(permissionsFor({ command: cmd('grok'), allow: { commands: true } }).args, ['--always-approve']);
  assert.deepEqual(permissionsFor({ command: cmd('gemini'), allow: { edits: true } }).args, ['--approval-mode', 'auto_edit']);
  assert.deepEqual(permissionsFor({ command: cmd('gemini'), allow: { commands: true, trustDirectory: true } }),
    { args: ['--approval-mode', 'yolo'], env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' }, writesFiles: true, runsCommands: true,
      supports: { edits: true, commands: true, trustDirectory: true }, note: 'Allowing commands also allows edits for Gemini CLI.' });
  // an unknown CLI gets no flags, only what its owner declares
  const custom = permissionsFor({ command: ['my-agent', '{prompt}'], allow: { edits: true }, capabilities: { writesFiles: true } });
  assert.deepEqual(custom.args, []);
  assert.equal(custom.writesFiles, true);
  assert.equal(custom.runsCommands, false);
});

test('list_agents says what each agent may do and how long it may run', async () => {
  const { list } = setup({ reader: fixture('echo', { timeoutMs: 90_000 }), api: { type: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'k', model: 'm' } });
  const agents = await list();
  const reader = agents.find((a) => a.name === 'reader')!;
  assert.equal(reader.writesFiles, false);
  assert.equal(reader.runsCommands, false);
  assert.equal(reader.timeoutSeconds, 90);
  assert.equal(agents.find((a) => a.name === 'api')!.writesFiles, false);
});

test('an allowed CLI is launched with its flags', async () => {
  const grok = nodeNamed('grok');
  const { ask, list } = setup({ grok: { command: [grok, FIXTURE, 'args', '{prompt}'], allow: { edits: true } } });
  const result = await ask('grok');
  assert.equal(result.succeeded, true, result.diagnostics);
  assert.deepEqual(JSON.parse(result.output).args, ['review payment.ts', '--always-approve']);
  const status = (await list()).find((a) => a.name === 'grok')!;
  assert.equal(status.writesFiles, true);
  assert.equal(status.runsCommands, true);
});

test('an answer that only announces what it will do is a failure that names the likely cause', async () => {
  const { ask } = setup({ grokish: fixture('preamble') });
  const result = await ask('grokish');
  assert.equal(result.succeeded, false);
  assert.match(result.diagnostics, /only says what it was about to do/);
  assert.match(result.diagnostics, /not allowed to change files or run commands/);
});

test('a timeout keeps what the agent had written by then', async () => {
  const { ask } = setup({ dripper: fixture('drip') });
  const result = await ask('dripper', { timeoutSeconds: 1 });
  assert.equal(result.timedOut, true);
  assert.match(result.output, /Finding 1: rounding happens before summing/);
  assert.match(result.diagnostics, /in "output"; it is incomplete/);
});

test('a task waits as queued with its place, then shows its output while it runs', async () => {
  const { start, get } = setup({ dripper: fixture('drip', { timeoutMs: 3_000 }) }, 1);
  const first = await start('dripper');
  const second = await start('dripper');
  assert.equal(first.status, 'running');
  assert.equal(second.status, 'queued');
  assert.equal(second.queuePosition, 0);

  let running = await get(first.id);
  for (let i = 0; i < 100 && !running.outputSoFar; i += 1) { await sleep(30); running = await get(first.id); }
  assert.match(running.outputSoFar!, /Finding 1/);
  assert.ok(running.lastOutputAt);
  assert.ok(!('prompt' in running), 'the caller\'s prompt is not handed back on every poll');
  assert.equal((await get(second.id)).status, 'queued', 'its timeout has not started');
});

test('after a quota failure the next calls are not started, and an explicit retry still runs', async () => {
  const { ask, context, list } = setup({ codexish: fixture('quota') });
  const first = await ask('codexish');
  assert.match(first.diagnostics, /usage limit/);

  const started = Date.now();
  const second = await ask('codexish');
  assert.equal(second.succeeded, false);
  assert.match(second.diagnostics, /^not started: codexish hit "usage limit reached"/);
  assert.match(second.diagnostics, /try again 4:22 AM/);
  assert.ok(Date.now() - started < 500, 'nothing was spawned');
  assert.equal((await list()).find((a) => a.name === 'codexish')!.calls, 1, 'a skip is not a call');

  const forced = await context.registry.find('codexish')!.run('again', { force: true });
  assert.match(forced.diagnostics, /exited with code 1/, 'force runs it for real');
});

test('start_task says up front when the working directory will be ignored', async () => {
  const { start } = setup({ api: { type: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', timeoutMs: 2_000 } });
  const task = await start('api', { workingDirectory: process.cwd() });
  assert.match(task.notes!, /workingDirectory will be ignored: api cannot read files/);
});
