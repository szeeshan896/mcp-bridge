import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { AgentRegistry } from './agents/registry.js';
import type { ConcurrencyLimit } from './limit.js';
import type { TaskStore } from './tasks.js';
import { executeTool, type ToolContext } from './tools.js';

const PACKAGE_NAME = 'mcpbridge';
const PACKAGE_VERSION = '0.1.0';

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

// coerced: a client holding an older copy of this schema, or one that types every
// argument as text, sends "120" -- refusing that over a type is no help to anyone
const TIMEOUT_ARG = z.coerce
  .number()
  .int()
  .min(10)
  .max(3600)
  .optional()
  .describe('Stop the agent after this many seconds. Only shortens its configured timeout.');

export function createServer(
  registry: AgentRegistry,
  tasks: TaskStore,
  limit: ConcurrencyLimit,
): McpServer {
  const context: ToolContext = { registry, tasks, limit };
  const server = new McpServer(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    {
      instructions: [
        'MCP Bridge hands work to other AI agents installed on this machine.',
        'Call list_agents first: an agent can be configured without being available, and',
        '"available": false says why. Then ask_agent to delegate and get the answer in the',
        'same call. The agent you delegate to cannot see this conversation or these files,',
        'so write a self-contained prompt and pass workingDirectory for anything about code.',
        'Agents are read-only unless list_agents says otherwise ("writesFiles", "runsCommands"):',
        'shape the task to what the agent may do. Each call stops at the agent\'s "timeoutSeconds".',
        'For work that would outlast this request, use start_task and poll get_task; only a few',
        'run at once, and the rest wait as "queued".',
      ].join(' '),
    },
  );

  server.registerTool(
    'list_agents',
    {
      title: 'List delegable agents',
      description:
        'List the AI agents this bridge can delegate to, and what to expect from each. ' +
        '"available" is true only when the command was found and no recent call hit a durable ' +
        'failure. "status" says which: "ready", "unavailable", or what an earlier call ran into -- ' +
        '"quota-exhausted", "sign-in-failed", "directory-not-trusted" -- with "lastError", ' +
        '"lastErrorAt" and, when the agent said so, "retryAt". A "ready" agent that has never ' +
        'been called ("calls": 0) is still unproven: its account may not work. ' +
        '"detail" carries the reason. ' + 'Agents are read-only unless their owner allowed more: "writesFiles" and "runsCommands" ' +
        'say whether one may change files or run commands such as tests. If neither is true, ask ' +
        'it to read and report, not to write a file or run something. ' +
        '"timeoutSeconds" is how long one call may run. "readsFiles" says whether passing ' +
        'workingDirectory actually lets that agent see your files — when it is false, put the ' +
        'content in the prompt instead.',
      inputSchema: {},
    },
    async () => json(await executeTool('list_agents', {}, context)),
  );

  server.registerTool(
    'ask_agent',
    {
      title: 'Delegate a task and wait',
      description:
        'Hand a task to another AI agent and wait for its answer. One call does the whole ' +
        'thing. The agent starts fresh with no knowledge of this conversation and cannot see ' +
        'your files unless you point it at them, so make the prompt self-contained and pass ' +
        'workingDirectory when the task is about code in a project. If "succeeded" is false, ' +
        'read "diagnostics" -- that includes an agent that ran but says it could not do the ' +
        'work. If "notes" is set, read it before trusting "output". Each call is bounded by ' +
        'the agent\'s timeout (5 minutes unless configured); pass timeoutSeconds for less. ' +
        'For a job long enough to outlast this request, use start_task.',
      inputSchema: {
        agent: z.string().describe('Which agent to use, exactly as list_agents names it, e.g. "gemini".'),
        prompt: z.string().min(1).describe('The full self-contained task or question for that agent.'),
        workingDirectory: z
          .string()
          .optional()
          .describe('Absolute path to run the agent in, so it can read the project files.'),
        timeoutSeconds: TIMEOUT_ARG,
      },
    },
    async (args) => json(await executeTool('ask_agent', args, context)),
  );

  server.registerTool(
    'start_task',
    {
      title: 'Delegate without waiting',
      description:
        'Start a delegated task and return its id immediately, for work that would outlast ' +
        'this request. Poll get_task with the id. Prefer ask_agent for anything that finishes ' +
        'in a minute or two — it is one call instead of several. ' + 'Only a few delegations run at once (two by default); more wait their turn, shown as ' +
        '"queued" by get_task, and several tasks on one agent spend its account\'s quota together. ' +
        'An agent whose last call hit its usage limit or a failed sign-in is not started again ' +
        'until that clears; the result says so at once.',
      inputSchema: {
        agent: z.string().describe('Which agent to use, exactly as list_agents names it.'),
        prompt: z.string().min(1).describe('The full self-contained task for that agent.'),
        workingDirectory: z.string().optional().describe('Absolute path to run the agent in.'),
        timeoutSeconds: TIMEOUT_ARG,
      },
    },
    async (args) => json(await executeTool('start_task', args, context)),
  );

  server.registerTool(
    'get_task',
    {
      title: 'Check a delegated task',
      description:
        'Look up a task started with start_task. "queued" means it is waiting for a free slot ' +
        '("queuePosition" ahead of it) and its timeout has not started; "running" means the agent ' +
        'is working, with its latest output in "outputSoFar" and the time of it in "lastOutputAt" ' +
        '-- a long silence there is the sign of a stuck agent. Wait between checks rather than ' +
        'polling in a tight loop. Once "finished", "result" holds the same shape ask_agent returns.',
      inputSchema: {
        id: z.string().describe('The task id returned by start_task.'),
      },
    },
    async (args) => json(await executeTool('get_task', args, context)),
  );

  return server;
}
