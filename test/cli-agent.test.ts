import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { CliAgent, needsAShell, resolveOnPath } from '../src/agents/cli.js';

// the stand-in agent is a Node script, not a shell command, so these tests run unchanged
// on Windows as well as POSIX
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'agent.mjs');

const fixture = (mode: string, timeoutMs = 10_000, max = 60_000) =>
  new CliAgent('test', { command: [process.execPath, FIXTURE, mode, '{prompt}'], timeoutMs }, max);

const run = (command: string[], timeoutMs = 10_000, max = 60_000) =>
  new CliAgent('test', { command, timeoutMs }, max);

const tempDir = () => mkdtempSync(join(tmpdir(), 'mcpbridge-'));

test('returns what the agent wrote', async () => {
  const result = await fixture('echo').run('the answer is 42', {});

  assert.equal(result.succeeded, true);
  assert.equal(result.output, 'the answer is 42');
});

test('rejects a command with no prompt placeholder', () => {
  assert.throws(() => new CliAgent('x', { command: ['gemini', '-p'] }, 100), /\{prompt\}/);
});

test('a prompt cannot escape into a shell', async () => {
  const marker = join(tempDir(), 'pwned');
  const hostile = `harmless; touch ${marker}; echo $(whoami) \`id\` && ls / & del /q *`;

  const result = await fixture('echo').run(hostile, {});

  assert.equal(result.output, hostile, 'metacharacters must come back as text');
  assert.equal(existsSync(marker), false, 'nothing in the prompt may execute');
});

test('reports a non-zero exit with its stderr', async () => {
  const result = await fixture('fail').run('x', {});

  assert.equal(result.succeeded, false);
  assert.match(result.diagnostics, /exited with code 3/);
  assert.match(result.diagnostics, /bad/);
});

test('a timeout kills the whole process tree, not just the child', async () => {
  const marker = join(tempDir(), 'survived');

  const result = await fixture(`grandchild:${marker}`, 400).run('x', {});
  assert.equal(result.timedOut, true);

  // the direct child dies either way; only taking down the group stops its grandchild,
  // which is the one that would write this file
  await sleep(2_500);
  assert.equal(existsSync(marker), false, 'the grandchild kept running after the timeout');
});

test('explains a missing executable instead of throwing', async () => {
  const result = await run(['definitely-not-installed-xyz', '{prompt}']).run('x', {});

  assert.equal(result.succeeded, false);
  assert.match(result.diagnostics, /PATH/);
});

test('does not stall when an agent floods both streams', async () => {
  const result = await fixture('flood', 30_000, 1_000_000).run('x', {});

  assert.equal(result.succeeded, true);
  assert.match(result.output, /20000/);
});

test('truncates output that would flood the caller', async () => {
  const result = await fixture('big:500', 10_000, 50).run('x', {});

  assert.equal(result.outputTruncated, true);
  assert.match(result.output, /\.\.\.\[truncated\]$/);
});

test('runs in the requested working directory', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'marker.txt'), 'found me');

  const result = await fixture('read:marker.txt').run('x', { cwd: dir });

  assert.equal(result.output, 'found me');
});

test('probe tells an installed agent from a missing one', async () => {
  assert.equal((await run([process.execPath, '{prompt}']).probe()).available, true);
  assert.equal((await run(['nope-xyz-123', '{prompt}']).probe()).available, false);
});

test('a Windows batch shim is refused with the fix, not run through a shell', () => {
  const onWindows = process.platform === 'win32';

  // the guard is what keeps a prompt away from cmd.exe quoting rules
  assert.equal(needsAShell('C:\\npm\\claude.CMD'), onWindows);
  assert.equal(needsAShell('C:\\tools\\agent.bat'), onWindows);
  assert.equal(needsAShell('C:\\tools\\agent.exe'), false);
  assert.equal(needsAShell('/usr/local/bin/claude'), false);
});

test('resolveOnPath finds a real executable and misses an absent one', async () => {
  assert.ok(await resolveOnPath(process.execPath));
  assert.equal(await resolveOnPath('nope-xyz-123'), null);
});
