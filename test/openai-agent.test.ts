import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, test } from 'node:test';

import { OpenAiAgent } from '../src/agents/openai.js';

const SECRET = 'sk-test-SUPERSECRET-do-not-leak';

interface Recorded { authorization?: string; body?: unknown }

/** A stand-in for any OpenAI-compatible provider, so the adapter is exercised for real. */
async function provider(handler: (url: string, body: unknown) => { status: number; json: unknown }) {
  const seen: Recorded = {};
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.authorization = req.headers.authorization;
      seen.body = raw ? JSON.parse(raw) : undefined;
      const { status, json } = handler(req.url ?? '', seen.body);
      const out = JSON.stringify(json);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(out.length) });
      res.end(out);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, seen, close: () => server.close() };
}

const servers: (() => void)[] = [];
after(() => servers.forEach((close) => close()));

async function agentFor(handler: Parameters<typeof provider>[0], extra: Record<string, unknown> = {}) {
  const p = await provider(handler);
  servers.push(p.close);
  process.env['TEST_PROVIDER_KEY'] = SECRET;
  const agent = new OpenAiAgent('grok-like', {
    type: 'openai', baseUrl: p.baseUrl, model: 'test-model',
    apiKeyEnv: 'TEST_PROVIDER_KEY', ...extra,
  } as never, 60_000);
  return { agent, seen: p.seen };
}

const ok = (content: string, extra: Record<string, unknown> = {}) => ({
  status: 200,
  json: { choices: [{ message: { content }, finish_reason: 'stop' }], ...extra },
});

test('an agent with no key is unavailable and names the variable to set', async () => {
  delete process.env['ABSENT_KEY_VAR'];
  const agent = new OpenAiAgent('grok', {
    type: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKeyEnv: 'ABSENT_KEY_VAR',
  } as never, 60_000);

  const probed = await agent.probe();

  assert.equal(probed.available, false);
  assert.match(probed.detail, /ABSENT_KEY_VAR/);
  // and delegating says the same thing rather than throwing
  assert.match((await agent.run('hi', {})).diagnostics, /ABSENT_KEY_VAR/);
});

test('delegates and returns the answer', async () => {
  const { agent, seen } = await agentFor((url) =>
    url.endsWith('/chat/completions') ? ok('the answer') : { status: 404, json: {} });

  const result = await agent.run('what is 2+2', {});

  assert.equal(result.succeeded, true);
  assert.equal(result.output, 'the answer');
  assert.equal(seen.authorization, `Bearer ${SECRET}`);
  assert.deepEqual((seen.body as { messages: unknown[] }).messages, [{ role: 'user', content: 'what is 2+2' }]);
});

test('the key never appears in anything handed back', async () => {
  const { agent } = await agentFor(() => ({ status: 500, json: { error: { message: 'upstream exploded' } } }));

  const result = await agent.run('x', { cwd: '/tmp' });
  const everything = JSON.stringify(result);

  assert.ok(!everything.includes(SECRET), 'the API key leaked into the result');
  assert.ok(!everything.includes('Bearer'), 'the authorization header leaked into the result');
});

test('a rejected key says so plainly', async () => {
  const { agent } = await agentFor(() => ({ status: 401, json: { error: { message: 'bad key' } } }));

  const result = await agent.run('x', {});

  assert.equal(result.succeeded, false);
  assert.match(result.diagnostics, /key was rejected/);
  assert.match(result.diagnostics, /TEST_PROVIDER_KEY/);
});

test('token spend is reported, since these calls cost money', async () => {
  const { agent } = await agentFor(() =>
    ok('answer', { usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 } }));

  const result = await agent.run('x', {});

  assert.match(result.notes, /used 46 tokens/);
  assert.match(result.notes, /12 in, 34 out/);
});

test('an answer cut off at the output limit is flagged', async () => {
  const { agent } = await agentFor(() => ({
    status: 200, json: { choices: [{ message: { content: 'half an ans' }, finish_reason: 'length' }] },
  }));

  const result = await agent.run('x', {});

  assert.equal(result.succeeded, true);
  assert.match(result.notes, /stopped at its output limit/);
  assert.match(result.notes, /maxOutputTokens/);
});

test('a workingDirectory is reported as ignored, not silently dropped', async () => {
  const { agent } = await agentFor(() => ok('answer'));

  const result = await agent.run('x', { cwd: '/home/me/project' });

  assert.equal(result.succeeded, true);
  assert.match(result.notes, /workingDirectory \(\/home\/me\/project\) was ignored/);
  assert.match(result.notes, /readsFiles/);
  assert.equal(agent.readsFiles, false);
});

test('a model the endpoint does not list is refused, with what it does list', async () => {
  const { agent } = await agentFor((url) =>
    url.endsWith('/models')
      ? { status: 200, json: { data: [{ id: 'other-model' }, { id: 'another' }] } }
      : ok('x'));

  const probed = await agent.probe();

  assert.equal(probed.available, false);
  assert.match(probed.detail, /does not list "test-model"/);
  assert.match(probed.detail, /other-model/);
});

test('a provider without a /models listing is still usable', async () => {
  const { agent } = await agentFor((url) =>
    url.endsWith('/models') ? { status: 404, json: {} } : ok('x'));

  const probed = await agent.probe();

  assert.equal(probed.available, true);
  assert.match(probed.detail, /not verified/);
});

test('extra headers some providers require are sent', async () => {
  const p = await provider(() => ok('x'));
  servers.push(p.close);
  process.env['TEST_PROVIDER_KEY'] = SECRET;
  const agent = new OpenAiAgent('router', {
    type: 'openai', baseUrl: p.baseUrl, model: 'test-model', apiKeyEnv: 'TEST_PROVIDER_KEY',
    headers: { 'HTTP-Referer': 'https://example.test' },
  } as never, 60_000);

  assert.equal((await agent.run('x', {})).succeeded, true);
});

test('baseUrl is required to construct one at all', () => {
  assert.throws(() => new OpenAiAgent('x', { type: 'openai', model: 'm' } as never, 100), /baseUrl/);
});

test('a missing model is reported, and the endpoint lists what it offers', async () => {
  const { agent } = await agentFor(
    (url) => (url.endsWith('/models')
      ? { status: 200, json: { data: [{ id: 'fast-one' }, { id: 'clever-one' }] } }
      : ok('x')),
    { model: undefined },
  );

  const probed = await agent.probe();

  assert.equal(probed.available, false);
  assert.match(probed.detail, /no model set/);
  assert.match(probed.detail, /fast-one, clever-one/);
  // and delegating says the same rather than sending a request with no model
  assert.match((await agent.run('x', {})).diagnostics, /no model set/);
});

test('a missing model without a listing points at the documentation', async () => {
  const { agent } = await agentFor(
    (url) => (url.endsWith('/models') ? { status: 404, json: {} } : ok('x')),
    { model: undefined },
  );

  assert.match((await agent.probe()).detail, /documentation/);
});
