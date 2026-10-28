import type { IncomingMessage, ServerResponse } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { bearerFrom, hashToken, tokenKind } from './auth.js';
import type { Db } from './db.js';
import { DeviceOfflineError, type DeviceHub } from './hub.js';
import { baseUrl, sendJson } from './http.js';
import { resolveAccessToken, unauthorizedHeader } from './oauth.js';

export interface McpDeps {
  db: Db;
  hub: DeviceHub;
  publicUrl: string | undefined;
}

/** A long delegation is a real model doing real work; the agent's own cap is 5 minutes. */
const DELEGATION_TIMEOUT_MS = 10 * 60 * 1000;
const QUICK_TIMEOUT_MS = 30 * 1000;

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * The account behind a bearer token: a client token pasted from the dashboard, or an access
 * token issued by the OAuth flow. Both are hashes in the database; neither is ever stored.
 */
function authenticate(token: string | null, db: Db): string | null {
  if (!token) return null;
  if (tokenKind(token) === 'client') {
    const record = db.findToken(hashToken(token), 'client');
    if (!record) return null;
    db.touchToken(record.hash);
    return record.userId;
  }
  return resolveAccessToken(token, db)?.userId ?? null;
}

/**
 * The public MCP endpoint. A token identifies the account; every tool is forwarded to that
 * account's connected device, which does the work. Nothing runs here.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, deps: McpDeps): Promise<void> {
  const token = bearerFrom(req.headers.authorization);
  const userId = authenticate(token, deps.db);
  if (!userId) {
    // the header is what tells claude.ai and Claude Code where to sign in; a 401 is required
    res.setHeader('WWW-Authenticate', unauthorizedHeader(baseUrl(req, deps.publicUrl), token !== null));
    sendJson(res, 401, {
      error: token
        ? 'the token is expired, revoked or unknown — sign in again, or generate a new client token in the dashboard'
        : 'sign in through OAuth, or send a client token: Authorization: Bearer mbc_... (generate one in the dashboard)',
    });
    return;
  }

  const server = buildServer(userId, deps.hub);
  const publicHost = deps.publicUrl ? new URL(deps.publicUrl).host : undefined;
  const transport = new StreamableHTTPServerTransport({
    ...(publicHost
      ? { enableDnsRebindingProtection: true, allowedHosts: [publicHost] }
      : {}),
  });
  res.on('close', () => void transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

function forward(hub: DeviceHub, userId: string, tool: string, args: Record<string, unknown>, timeoutMs: number) {
  return hub.call(userId, tool, args, timeoutMs).catch((error: unknown) => ({
    agent: typeof args['agent'] === 'string' ? args['agent'] : undefined,
    succeeded: false,
    output: '',
    diagnostics: (error as Error).message,
    notes: '',
    offline: error instanceof DeviceOfflineError,
  }));
}

function buildServer(userId: string, hub: DeviceHub): McpServer {
  const server = new McpServer(
    { name: 'mcpbridge-relay', version: '0.1.0' },
    {
      instructions:
        'MCP Bridge relays work to AI agents installed on the account owner\'s own machine, ' +
        'where those agents are signed in. Call list_agents first — it also says whether that ' +
        'machine is connected right now; if "offline" is true, nothing can be delegated until ' +
        'the owner runs `mcpbridge connect` there. Then ask_agent to delegate and get the answer ' +
        'in one call. The agent cannot see this conversation, so write a self-contained prompt, ' +
        'and pass workingDirectory for anything about files on that machine.',
    },
  );

  const delegation = {
    agent: z.string().describe('Which agent to use, exactly as list_agents names it.'),
    prompt: z.string().min(1).describe('The full self-contained task or question.'),
    workingDirectory: z
      .string()
      .optional()
      .describe('Absolute path on the connected machine to run the agent in.'),
  };

  server.registerTool(
    'list_agents',
    {
      title: 'List delegable agents on the connected machine',
      description:
        'List the AI agents on the account owner\'s connected machine and whether each can be ' +
        'started. If the machine is not connected the result says so, with how to connect it. ' +
        '"available" means the command was found — not that its account works; a signed-out ' +
        'CLI still fails when asked and explains why in "diagnostics".',
      inputSchema: {},
    },
    async () => {
      const device = hub.get(userId);
      if (!device) return json({ offline: true, agents: [], diagnostics: new DeviceOfflineError().message });
      const agents = await forward(hub, userId, 'list_agents', {}, QUICK_TIMEOUT_MS);
      return json({ offline: false, device: device.name, agents });
    },
  );

  server.registerTool(
    'ask_agent',
    {
      title: 'Delegate a task and wait',
      description:
        'Hand a task to an agent on the connected machine and wait for its answer, in one ' +
        'call. The agent starts fresh with no knowledge of this conversation, so make the ' +
        'prompt self-contained. If "succeeded" is false, read "diagnostics"; if "offline" is ' +
        'true the owner\'s machine is not connected. For long jobs use start_task.',
      inputSchema: delegation,
    },
    async (args) => json(await forward(hub, userId, 'ask_agent', args, DELEGATION_TIMEOUT_MS)),
  );

  server.registerTool(
    'start_task',
    {
      title: 'Delegate without waiting',
      description:
        'Start a delegated task on the connected machine and return its id at once. Poll ' +
        'get_task with the id. Prefer ask_agent for anything that finishes in a minute or two.',
      inputSchema: delegation,
    },
    async (args) => json(await forward(hub, userId, 'start_task', args, QUICK_TIMEOUT_MS)),
  );

  server.registerTool(
    'get_task',
    {
      title: 'Check a delegated task',
      description:
        'Look up a task started with start_task. While "status" is "running" wait before ' +
        'asking again; once "finished", "result" holds the same shape ask_agent returns.',
      inputSchema: { id: z.string().describe('The task id from start_task.') },
    },
    async (args) => json(await forward(hub, userId, 'get_task', args, QUICK_TIMEOUT_MS)),
  );

  return server;
}
