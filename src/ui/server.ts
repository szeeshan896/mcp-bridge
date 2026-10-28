import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';

import { HealthStore } from '../agents/health.js';
import { AgentRegistry } from '../agents/registry.js';
import { DEFAULT_CONFIG, configPath, loadConfig, type AgentConfig } from '../config.js';
import { connectToRelay } from '../connect.js';
import { ConcurrencyLimit } from '../limit.js';
import { applySecretsToEnv, loadSecrets, maskSecret, saveSecrets, secretsPath, type Secrets } from '../secrets.js';
import { TaskStore } from '../tasks.js';
import type { ToolContext } from '../tools.js';
import { uiPage } from './page.js';
import { PRESETS } from './presets.js';

export interface UiOptions {
  port: number;
  agentVersion: string;
  configFile?: string;
  secretsFile?: string;
  log?: (line: string) => void;
  /** replaces the call that lists a provider's models; for tests */
  fetchImpl?: typeof fetch;
}

export interface UiServer {
  server: Server;
  port: number;
  /** the address to open: carries the per-launch key, which the page swaps for a cookie */
  url: string;
  close(): Promise<void>;
}

const COOKIE = 'mcpbridge_ui';
const MAX_BODY = 64 * 1024;
const TEST_PROMPT = 'Reply with exactly one word: OK';
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENV_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;

type ConnectionState =
  | { state: 'stopped'; reason?: string }
  | { state: 'connecting' }
  | { state: 'connected'; device: string; since: number }
  | { state: 'reconnecting'; reason: string };

/**
 * The local control panel: everything `mcpbridge` asks of a terminal -- adding an agent,
 * saving its key, checking it answers, keeping this machine connected to the relay --
 * done from a page on this machine.
 *
 * <p>Three things keep it this machine's alone. It listens on 127.0.0.1 only. Every
 * request must carry a key generated at launch, which reaches the browser only through
 * the link printed in the terminal and is then held in an HttpOnly cookie. And requests
 * whose Host or Origin is not this server are refused, so a web page elsewhere cannot use
 * the browser to drive it, by DNS rebinding or by cross-site POST.
 */
export async function startUi(options: UiOptions): Promise<UiServer> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const configFile = options.configFile ?? configPath();
  const secretsFile = options.secretsFile ?? secretsPath();
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const key = randomBytes(18).toString('base64url');

  let secrets: Secrets = loadSecrets(secretsFile);
  applySecretsToEnv(secrets);

  // outlives every rebuild of the registry, so editing an agent does not forget what
  // earlier calls learned about the others
  const health = new HealthStore();
  const context: ToolContext = (() => {
    const { config } = loadConfig(configFile);
    const limit = new ConcurrencyLimit(config.maxConcurrent);
    return { registry: new AgentRegistry(config, health), tasks: new TaskStore(limit), limit };
  })();

  let connection: ConnectionState = { state: 'stopped' };
  let connectionController: AbortController | undefined;
  const connectionLog: string[] = [];
  const remember = (line: string) => {
    connectionLog.push(`${new Date().toLocaleTimeString()}  ${line}`);
    if (connectionLog.length > 30) connectionLog.shift();
  };

  // probing an API agent calls its provider, so a page that polls must not probe each time
  let statusCache: { at: number; value: Awaited<ReturnType<AgentRegistry['statuses']>> } | undefined;
  const statuses = async () => {
    if (!statusCache || Date.now() - statusCache.at > 30_000) {
      statusCache = { at: Date.now(), value: await context.registry.statuses() };
    }
    return statusCache.value;
  };

  /** Rebuilds the agents from the file; a live connection is restarted so the relay sees them. */
  const reload = () => {
    const { config } = loadConfig(configFile);
    context.registry = new AgentRegistry(config, health);
    statusCache = undefined;
    if (connectionController) startConnection();
  };

  const stopConnection = (reason = 'stopped from this page') => {
    connectionController?.abort();
    connectionController = undefined;
    connection = { state: 'stopped', reason };
  };

  const startConnection = () => {
    stopConnection('restarting');
    const relay = secrets.relay;
    if (!relay) throw new Error('save the relay address and agent token first');
    const controller = new AbortController();
    connectionController = controller;
    connection = { state: 'connecting' };
    remember(`connecting to ${relay.url}`);
    void connectToRelay({
      relayUrl: relay.url,
      token: relay.token,
      ...(relay.device ? { device: relay.device } : {}),
      agentVersion: options.agentVersion,
      context,
      signal: controller.signal,
      log: (line) => { remember(line); log(line); },
      onState: (state) => {
        if (connectionController !== controller) return;
        connection = state.connected
          ? { state: 'connected', device: state.device, since: Date.now() }
          : { state: 'reconnecting', reason: state.reason };
      },
    }).then(() => {
      // the loop only ends by itself when the relay refused this machine for good
      if (connectionController === controller) {
        connectionController = undefined;
        connection = { state: 'stopped', reason: lastReason(connection) ?? 'the relay refused this machine' };
        remember('stopped: the relay refused this machine; check the agent token');
      }
    });
  };

  // ---- config.json, edited in place ---------------------------------------------------

  const readFile = (): Record<string, unknown> => {
    let raw: string;
    try {
      raw = readFileSync(configFile, 'utf8');
    } catch {
      return {};
    }
    // a file that does not parse is the person's to fix; overwriting it would lose their work
    return JSON.parse(raw) as Record<string, unknown>;
  };

  const writeFile = (file: Record<string, unknown>) => {
    mkdirSync(dirname(configFile), { recursive: true });
    const temporary = `${configFile}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(temporary, configFile);
  };

  const fileAgents = (): Record<string, AgentConfig> => {
    try {
      return ((readFile()['agents'] ?? {}) as Record<string, AgentConfig>);
    } catch {
      return {};
    }
  };

  // ---- the API --------------------------------------------------------------------------

  const state = async () => {
    const mine = fileAgents();
    const probed = await statuses();
    let configError: string | null = null;
    try {
      readFile();
    } catch (error) {
      configError = `${configFile} is not valid JSON: ${(error as Error).message}`;
    }
    return {
      configFile,
      secretsFile,
      configError,
      agents: probed.map((s) => {
        const own = mine[s.name];
        const keyEnv = own && own.type === 'openai' ? own.apiKeyEnv : undefined;
        return {
          ...s,
          origin: own ? (s.name in DEFAULT_CONFIG.agents ? 'override' : 'yours') : 'built-in',
          config: own ?? null,
          key: keyEnv ? { env: keyEnv, saved: maskSecret(secrets.keys[keyEnv]), inEnvironment: Boolean(process.env[keyEnv]) } : null,
        };
      }),
      relay: secrets.relay
        ? { url: secrets.relay.url, device: secrets.relay.device ?? '', token: maskSecret(secrets.relay.token) }
        : null,
      connection,
      connectionLog,
      presets: PRESETS,
    };
  };

  const saveAgent = (body: Record<string, unknown>) => {
    const name = String(body['name'] ?? '').trim().toLowerCase();
    if (!NAME_PATTERN.test(name)) throw new Error('a name is lowercase letters, digits, - and _, up to 32 characters');
    const kind = String(body['kind'] ?? '');
    const description = String(body['description'] ?? '').trim().slice(0, 200) || undefined;
    const timeoutMs = body['timeoutMs'] ? Number(body['timeoutMs']) : undefined;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000)) {
      throw new Error('the timeout is in milliseconds, between 1000 and 3600000');
    }

    let agent: AgentConfig;
    let keyEnv: string | undefined;
    if (kind === 'openai') {
      const baseUrl = String(body['baseUrl'] ?? '').trim().replace(/\/+$/, '');
      if (!acceptableBaseUrl(baseUrl)) throw new Error('the base URL must be https://, or http:// on localhost');
      keyEnv = String(body['apiKeyEnv'] ?? '').trim() || `${name.toUpperCase().replace(/-/g, '_')}_API_KEY`;
      if (!ENV_PATTERN.test(keyEnv)) throw new Error('the key variable is uppercase letters, digits and _');
      const model = String(body['model'] ?? '').trim();
      agent = {
        type: 'openai', baseUrl, apiKeyEnv: keyEnv,
        ...(model ? { model } : {}), ...(description ? { description } : {}), ...(timeoutMs ? { timeoutMs } : {}),
      };
    } else if (kind === 'cli') {
      const command = Array.isArray(body['command']) ? body['command'].map(String).filter(Boolean) : [];
      const promptVia = body['promptVia'] === 'stdin' ? 'stdin' : 'argv';
      agent = {
        command, ...(promptVia === 'stdin' ? { promptVia } : {}),
        ...(description ? { description } : {}), ...(timeoutMs ? { timeoutMs } : {}),
      };
    } else if (kind === 'ollama') {
      const model = String(body['model'] ?? '').trim();
      const baseUrl = String(body['baseUrl'] ?? '').trim();
      if (baseUrl && !acceptableBaseUrl(baseUrl)) throw new Error('the base URL must be https://, or http:// on localhost');
      agent = {
        type: 'ollama', ...(model ? { model } : {}), ...(baseUrl ? { baseUrl } : {}),
        ...(description ? { description } : {}), ...(timeoutMs ? { timeoutMs } : {}),
      };
    } else {
      throw new Error('kind must be openai, cli or ollama');
    }

    // the same construction the bridge does, so a config it would reject is refused here
    const rejected = new AgentRegistry({ ...DEFAULT_CONFIG, agents: { [name]: agent } }).configError(name);
    if (rejected) throw new Error(rejected);

    const file = readFile();
    file['agents'] = { ...((file['agents'] ?? {}) as Record<string, unknown>), [name]: agent };
    writeFile(file);

    const apiKey = typeof body['apiKey'] === 'string' ? body['apiKey'].trim() : '';
    if (keyEnv && apiKey) {
      secrets = { ...secrets, keys: { ...secrets.keys, [keyEnv]: apiKey } };
      saveSecrets(secrets, secretsFile);
      // a key typed here replaces whatever the variable held at startup
      process.env[keyEnv] = apiKey;
    }
    reload();
    return { saved: name };
  };

  const removeAgent = (body: Record<string, unknown>) => {
    const name = String(body['name'] ?? '').trim().toLowerCase();
    const file = readFile();
    const agents = { ...((file['agents'] ?? {}) as Record<string, unknown>) };
    if (!(name in agents)) throw new Error(`"${name}" is not in your config file; built-in agents cannot be removed`);
    delete agents[name];
    file['agents'] = agents;
    writeFile(file);
    reload();
    return { removed: name, builtIn: name in DEFAULT_CONFIG.agents };
  };

  const testAgent = async (body: Record<string, unknown>) => {
    const name = String(body['name'] ?? '');
    const agent = context.registry.find(name);
    if (!agent) throw new Error(`no agent named "${name}"`);
    const prompt = typeof body['prompt'] === 'string' && body['prompt'].trim() ? body['prompt'].trim() : TEST_PROMPT;
    const result = await context.limit.run(() => agent.run(prompt, {}));
    // what the test learned belongs in the next listing, not one cached from before it
    statusCache = undefined;
    return result;
  };

  const listModels = async (body: Record<string, unknown>) => {
    const baseUrl = String(body['baseUrl'] ?? '').trim().replace(/\/+$/, '');
    if (!acceptableBaseUrl(baseUrl)) throw new Error('the base URL must be https://, or http:// on localhost');
    const env = String(body['apiKeyEnv'] ?? '').trim();
    const apiKey = (typeof body['apiKey'] === 'string' && body['apiKey'].trim()) || (env ? process.env[env] : undefined);
    if (!apiKey) throw new Error('paste the key first, so the provider will list what it can reach');
    const response = await fetchImpl(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`the provider answered ${response.status} ${response.statusText}; check the key`);
    const payload = (await response.json()) as { data?: { id?: unknown }[] };
    const models = (payload.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
    return { models: [...new Set(models)].sort().slice(0, 500) };
  };

  const saveRelay = (body: Record<string, unknown>) => {
    const url = String(body['url'] ?? '').trim().replace(/\/+$/, '');
    if (!/^(https?|wss?):\/\/[^\s/]+/.test(url)) throw new Error('the relay address starts with https://');
    const token = String(body['token'] ?? '').trim() || secrets.relay?.token || '';
    if (!token.startsWith('mba_')) throw new Error('paste the agent token from the relay dashboard; it starts with mba_');
    const device = String(body['device'] ?? '').trim().slice(0, 80);
    secrets = { ...secrets, relay: { url, token, ...(device ? { device } : {}) } };
    saveSecrets(secrets, secretsFile);
    startConnection();
    return { saved: true };
  };

  // ---- HTTP -----------------------------------------------------------------------------

  let port = options.port;
  const allowedHosts = () => [`127.0.0.1:${port}`, `localhost:${port}`];

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) json(res, 500, { error: (error as Error).message });
      else res.end();
    });
  });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!allowedHosts().includes(req.headers.host ?? '')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('this page only answers on 127.0.0.1');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      const presented = url.searchParams.get('k');
      if (presented !== null) {
        if (!same(presented, key)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('that link is from another launch; use the one the terminal printed');
          return;
        }
        // trade the key in the address for a cookie, so it leaves the address bar and history
        res.writeHead(303, {
          'Set-Cookie': `${COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/`,
          Location: '/',
        }).end();
        return;
      }
      if (!same(cookieFrom(req), key)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end('open the link that `mcpbridge ui` printed in the terminal; it carries this launch\'s key');
        return;
      }
      const html = uiPage();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      });
      res.end(html);
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      res.writeHead(404).end();
      return;
    }
    // the cookie proves the browser opened the launch link; the custom header cannot be
    // sent cross-origin without a preflight this server never approves
    if (!same(cookieFrom(req), key) || req.headers['x-mcpbridge-ui'] !== '1') {
      json(res, 403, { error: 'not authorised: reopen the link the terminal printed' });
      return;
    }
    const origin = req.headers.origin;
    if (origin && !allowedHosts().some((h) => origin === `http://${h}`)) {
      json(res, 403, { error: 'cross-origin request refused' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      json(res, 200, await state());
      return;
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (error) {
      json(res, 400, { error: (error as Error).message });
      return;
    }
    const routes: Record<string, (b: Record<string, unknown>) => unknown> = {
      '/api/agents/save': saveAgent,
      '/api/agents/remove': removeAgent,
      '/api/agents/test': testAgent,
      '/api/models': listModels,
      '/api/relay/save': saveRelay,
      '/api/relay/connect': () => { startConnection(); return { connecting: true }; },
      '/api/relay/disconnect': () => { stopConnection(); remember('disconnected from this page'); return { stopped: true }; },
      '/api/reload': () => { reload(); return { reloaded: true }; },
    };
    const route = routes[url.pathname];
    if (!route) {
      json(res, 404, { error: 'no such endpoint' });
      return;
    }
    try {
      json(res, 200, await route(body));
    } catch (error) {
      json(res, 400, { error: (error as Error).message });
    }
  };

  port = await listenNear(server, options.port);

  // a machine set up once should come back online by itself when the page is opened
  if (secrets.relay) {
    try {
      startConnection();
    } catch (error) {
      remember((error as Error).message);
    }
  }

  return {
    server,
    port,
    url: `http://127.0.0.1:${port}/?k=${key}`,
    close: () => new Promise((resolve) => {
      stopConnection('closing');
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

// ---- helpers ------------------------------------------------------------------------------

function lastReason(state: ConnectionState): string | undefined {
  return state.state === 'reconnecting' || state.state === 'stopped' ? state.reason : undefined;
}

/** https anywhere; http only to this machine, which is where local model servers live. */
function acceptableBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function same(a: string | undefined | null, b: string): boolean {
  if (!a) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieFrom(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return undefined;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the body must be a JSON object');
  return parsed as Record<string, unknown>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/** The requested port, or the next free one: a second launch should not just fail. */
async function listenNear(server: Server, start: number): Promise<number> {
  for (let candidate = start; candidate < start + 10 || start === 0; candidate += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidate, '127.0.0.1');
      });
      return (server.address() as { port: number }).port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || start === 0) throw error;
    }
  }
  throw new Error(`ports ${start}-${start + 9} are all in use; pass --port`);
}
