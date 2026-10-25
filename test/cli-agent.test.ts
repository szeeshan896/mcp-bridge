import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { CliAgent } from '../src/agents/cli.js';

const run = (command: string[], timeoutMs = 10_000, max = 60_000) =>
  new CliAgent('test', { command, timeoutMs }, max);

test('returns what the agent wrote', async () => {
  const result = await run(['echo', '{prompt}']).run('the answer is 42', {});

  assert.equal(result.succeeded, true);
  assert.equal(result.output, 'the answer is 42');
});

test('rejects a command with no prompt placeholder', () => {
  assert.throws(() => new CliAgent('x', { command: ['gemini', '-p'] }, 100), /\{prompt\}/);
});

test('a prompt cannot escape into a shell', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'mcpbridge-')), 'pwned');
  const hostile = `harmless; touch ${marker}; echo $(whoami) \`id\` && ls /`;

  const result = await run(['echo', '{prompt}']).run(hostile, {});

  assert.equal(result.output, hostile, 'metacharacters must come back as text');
  assert.equal(existsSync(marker), false, 'nothing in the prompt may execute');
});

test('reports a non-zero exit with its stderr', async () => {
  const result = await run(['sh', '-c', 'echo bad >&2; exit 3; : {prompt}']).run('x', {});

  assert.equal(result.succeeded, false);
  assert.match(result.diagnostics, /exited with code 3/);
  assert.match(result.diagnostics, /bad/);
});

test('a timeout kills the whole process tree, not just the child', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'mcpbridge-')), 'survived');

  const result = await run(['sh', '-c', `sleep 1; touch ${marker}; : {prompt}`], 300).run('x', {});
  assert.equal(result.timedOut, true);

  // the shell is gone either way; only killing the group stops its sleeping child
  await sleep(2_000);
  assert.equal(existsSync(marker), false, 'the grandchild kept running after the timeout');
});

test('explains a missing executable instead of throwing', async () => {
  const result = await run(['definitely-not-installed-xyz', '{prompt}']).run('x', {});

  assert.equal(result.succeeded, false);
  assert.match(result.diagnostics, /PATH/);
});

test('does not stall when an agent floods both streams', async () => {
  const result = await run(['sh', '-c', 'seq 1 20000; seq 1 20000 >&2; : {prompt}'], 30_000, 1_000_000)
    .run('x', {});

  assert.equal(result.succeeded, true);
  assert.match(result.output, /20000/);
});

test('truncates output that would flood the caller', async () => {
  const result = await run(['sh', '-c', "printf 'x%.0s' $(seq 1 500); : {prompt}"], 10_000, 50).run('x', {});

  assert.equal(result.outputTruncated, true);
  assert.match(result.output, /\.\.\.\[truncated\]$/);
});

test('runs in the requested working directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpbridge-'));
  writeFileSync(join(dir, 'marker.txt'), 'found me');

  const result = await run(['sh', '-c', 'cat marker.txt; : {prompt}']).run('x', { cwd: dir });

  assert.equal(result.output, 'found me');
});

test('probe tells an installed agent from a missing one', async () => {
  assert.equal((await run(['echo', '{prompt}']).probe()).available, true);
  assert.equal((await run(['nope-xyz-123', '{prompt}']).probe()).available, false);
});
