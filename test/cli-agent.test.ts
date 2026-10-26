import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { CliAgent, needsAShell, resolveOnPath, startupAdvice } from '../src/agents/cli.js';

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

test('a prompt sent via stdin is not subject to the argv size limit', async () => {
  // argv tops out around 64KB on Linux and 32KB on Windows; this is well past both
  const big = 'y'.repeat(400_000);
  const agent = new CliAgent(
    'stdin-agent',
    { command: [process.execPath, FIXTURE, 'stdin', 'unused'], promptVia: 'stdin', timeoutMs: 20_000 },
    1_000_000,
  );

  const result = await agent.run(big, {});

  assert.equal(result.succeeded, true);
  assert.equal(result.output.length, big.length);
});

test('both the POSIX and Windows size errors are explained, with the fix', () => {
  // the limit itself is the platform's business -- Linux reports E2BIG, Windows
  // ENAMETOOLONG, and handling only one left the other saying "is it installed?"
  for (const code of ['E2BIG', 'ENAMETOOLONG']) {
    const advice = startupAdvice('a', 'some-cli', Object.assign(new Error('x'), { code }), 'p'.repeat(9));

    assert.match(advice, /too large to pass as a command-line argument/, code);
    assert.match(advice, /"promptVia": "stdin"/, code);
    assert.match(advice, /9 characters/, code);
  }
});

test('a genuinely missing command is not mistaken for an oversized prompt', () => {
  const advice = startupAdvice('a', 'ghost', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), 'p');

  assert.match(advice, /Is it installed and on PATH/);
});

test('an argv prompt past this platform\'s limit is explained rather than mysterious', async () => {
  // how much argv holds differs per platform -- ~128KB on Linux, ~1MB on macOS, ~32KB on
  // Windows -- so the size is escalated until the OS refuses rather than assumed
  for (const chars of [200_000, 2_000_000, 8_000_000]) {
    const result = await fixture('echo', 20_000, 10_000_000).run('z'.repeat(chars), {});
    if (!result.succeeded) {
      assert.match(result.diagnostics, /too large to pass as a command-line argument/);
      assert.match(result.diagnostics, /"promptVia": "stdin"/);
      return;
    }
  }
  assert.fail('no prompt size was refused; the limit should have been reached by 8MB');
});

test('stdin mode does not require a prompt placeholder', () => {
  assert.doesNotThrow(() =>
    new CliAgent('s', { command: ['agent', '--read-stdin'], promptVia: 'stdin' }, 100));
  assert.throws(() => new CliAgent('a', { command: ['agent', '--go'] }, 100), /promptVia/);
});

test('terminal escape codes are stripped out of the answer', async () => {
  const result = await fixture('ansi').run('x', {});

  assert.equal(result.output, 'red answer and bold');
  assert.ok(!result.output.includes('\u001B'), 'no escape sequences may survive');
});

test('agents run with colour disabled', async () => {
  const result = await fixture('env:NO_COLOR').run('x', {});

  assert.equal(result.output, '1');
});

test('a script shim is reported by the script it runs, not the interpreter', async () => {
  // "a shim for node.exe" names the interpreter every script shim shares, which tells
  // the reader nothing about which program will run
  const { CliAgent: Agent } = await import('../src/agents/cli.js');
  const agent = new Agent('x', { command: [process.execPath, '{prompt}'] }, 100);

  assert.match((await agent.probe()).detail, /found at/);
});
