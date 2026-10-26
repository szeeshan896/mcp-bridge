import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseShimTarget } from '../src/agents/shim.js';

const DIR = 'C:\\Users\\szees\\AppData\\Roaming\\npm';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';

/** Verbatim from a Windows machine: npm's shim for an npm-installed Claude Code. */
const EXE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
].join('\r\n');

/** The other shape npm writes, for a package whose bin is a script. */
const SCRIPT_SHIM = [
  '@ECHO off',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  ')',
  '"%_prog%"  "%dp0%\\node_modules\\some-cli\\bin\\cli.js" %*',
].join('\r\n');

const existsOnly = (...paths: string[]) => (candidate: string) => paths.includes(candidate);

test('finds the native binary an npm shim calls', () => {
  const expected = `${DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;

  const target = parseShimTarget(EXE_SHIM, DIR, NODE, existsOnly(expected));

  assert.deepEqual(target, { command: expected, prefix: [] });
});

test('runs a script shim through the node already running, not a bare "node"', () => {
  const script = `${DIR}\\node_modules\\some-cli\\bin\\cli.js`;

  const target = parseShimTarget(SCRIPT_SHIM, DIR, NODE, existsOnly(script));

  // picking up whatever "node" is first on PATH could be a different major version
  assert.deepEqual(target, { command: NODE, prefix: [script] });
});

test('prefers the binary when a shim mentions both', () => {
  const exe = `${DIR}\\node_modules\\x\\x.exe`;
  const js = `${DIR}\\node_modules\\x\\x.js`;
  const content = `"%dp0%\\node_modules\\x\\x.js"\r\n"%dp0%\\node_modules\\x\\x.exe" %*`;

  const target = parseShimTarget(content, DIR, NODE, existsOnly(exe, js));

  assert.equal(target?.command, exe);
});

test('ignores a target that is not actually there', () => {
  assert.equal(parseShimTarget(EXE_SHIM, DIR, NODE, () => false), null);
});

test('ignores paths that are not runnable programs', () => {
  const content = '"%dp0%\\node_modules\\thing\\README.md" %*';

  assert.equal(parseShimTarget(content, DIR, NODE, () => true), null);
});

test('a shim it cannot read returns nothing rather than a guess', () => {
  assert.equal(parseShimTarget('@ECHO off\r\nnpm help', DIR, NODE, () => true), null);
});

test('tolerates doubled separators from the %dp0% trailing backslash', () => {
  const expected = `${DIR}\\node_modules\\x\\x.exe`;
  // %dp0% already ends in a backslash, so npm's own path has two in a row
  const content = '"%dp0%\\\\node_modules\\\\x\\\\x.exe" %*';

  assert.equal(parseShimTarget(content, DIR, NODE, existsOnly(expected))?.command, expected);
});
