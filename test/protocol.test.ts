import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROTOCOL_VERSION, parseAgentMessage, parseRelayMessage } from '../src/protocol.js';

const status = { name: 'x', description: 'd', requires: 'r', available: true, readsFiles: true, detail: '' };

test('parses a hello and rejects the wrong protocol version', () => {
  const ok = parseAgentMessage(JSON.stringify({
    type: 'hello', protocol: PROTOCOL_VERSION, agentVersion: '0.1.0', device: 'laptop', agents: [status],
  }));
  assert.equal(ok?.type, 'hello');

  assert.equal(parseAgentMessage(JSON.stringify({
    type: 'hello', protocol: 99, agentVersion: '0.1.0', device: 'laptop', agents: [],
  })), null);
});

test('parses a call and rejects a tool that does not exist', () => {
  assert.equal(parseRelayMessage(JSON.stringify({ type: 'call', id: '1', tool: 'ask_agent', args: {} }))?.type, 'call');
  assert.equal(parseRelayMessage(JSON.stringify({ type: 'call', id: '1', tool: 'rm_rf', args: {} })), null);
});

test('garbage is null rather than a throw', () => {
  assert.equal(parseAgentMessage('not json'), null);
  assert.equal(parseRelayMessage('{"type":"nope"}'), null);
  assert.equal(parseAgentMessage(''), null);
});

test('a device name cannot be empty or unbounded', () => {
  const base = { type: 'hello', protocol: PROTOCOL_VERSION, agentVersion: '0', agents: [] };
  assert.equal(parseAgentMessage(JSON.stringify({ ...base, device: '' })), null);
  assert.equal(parseAgentMessage(JSON.stringify({ ...base, device: 'x'.repeat(81) })), null);
});
