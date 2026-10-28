import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts');
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], { encoding: 'utf8', timeout: 30_000, input: '' });

test('an unknown command is refused instead of silently starting the stdio server', () => {
  // what an old checkout without `connect` used to do with `connect --relay ...`
  const result = cli('conect', '--relay', 'https://relay.example', '--token', 'mba_x');

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command or option: conect --relay https:\/\/relay\.example --token mba_x/);
  assert.match(result.stderr, /git pull/);
  assert.doesNotMatch(result.stderr, /on stdio/);
});

test('a stray argument after --http is refused too, but its port is not', () => {
  const result = cli('--http', '9999', 'extra');

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command or option: extra$/m);
});
