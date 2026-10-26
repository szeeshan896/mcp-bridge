import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { AgentRegistry } from './agents/registry.js';
import type { ConcurrencyLimit } from './limit.js';
import type { TaskStore } from './tasks.js';

const PACKAGE_NAME = 'mcpbridge';
const PACKAGE_VERSION = '0.1.0';

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function createServer(
  registry: AgentRegistry,
  tasks: TaskStore,
  limit: ConcurrencyLimit,
): McpServer {
  const server = new McpServer(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    {
      instructions: [
        'MCP Bridge hands work to other AI agents installed on this machine.',
        'Call list_agents first: an agent can be configured without being available, and',
        '"available": false says why. Then ask_agent to delegate and get the answer in the',
        'same call. The agent you delegate to cannot see this conversation or these files,',
        'so write a self-contained prompt and pass workingDirectory for anything about code.',
        'For work that would outlast this request, use start_task and poll get_task.',
      ].join(' '),
    },
  );

  server.registerTool(
    'list_agents',
    {
      title: 'List delegable agents',
      description:
        'List the AI agents this bridge can delegate to. "available" means its command was ' +
        'found and can be started — not that its account works: a signed-out CLI or a ' +
        'withdrawn subscription still lists as available and fails when asked, reporting why ' +
        'in "diagnostics". Check this before delegating, since "available": false carries its ' +
        'own reason, such as a CLI that is not installed. "readsFiles" says whether passing ' +
        'workingDirectory actually lets that agent see your files — when it is false, put the ' +
        'content in the prompt instead.',
      inputSchema: {},
    },
    async () => json(await registry.statuses()),
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
        'read "diagnostics". For a job long enough to outlast this request, use start_task.',
      inputSchema: {
        agent: z.string().describe('Which agent to use, exactly as list_agents names it, e.g. "gemini".'),
        prompt: z.string().min(1).describe('The full self-contained task or question for that agent.'),
        workingDirectory: z
          .string()
          .optional()
          .describe('Absolute path to run the agent in, so it can read the project files.'),
      },
    },
    async ({ agent, prompt, workingDirectory }) => {
      const target = registry.find(agent);
      if (!target) {
        return json({
          agent,
          succeeded: false,
          output: '',
          diagnostics: `no agent named "${agent}" is configured. Available: ${registry.names().join(', ')}`,
        });
      }
      const options = workingDirectory ? { cwd: workingDirectory } : {};
      return json(await limit.run(() => target.run(prompt, options)));
    },
  );

  server.registerTool(
    'start_task',
    {
      title: 'Delegate without waiting',
      description:
        'Start a delegated task and return its id immediately, for work that would outlast ' +
        'this request. Poll get_task with the id. Prefer ask_agent for anything that finishes ' +
        'in a minute or two — it is one call instead of several.',
      inputSchema: {
        agent: z.string().describe('Which agent to use, exactly as list_agents names it.'),
        prompt: z.string().min(1).describe('The full self-contained task for that agent.'),
        workingDirectory: z.string().optional().describe('Absolute path to run the agent in.'),
      },
    },
    async ({ agent, prompt, workingDirectory }) => {
      const target = registry.find(agent);
      if (!target) {
        return json({
          started: false,
          diagnostics: `no agent named "${agent}" is configured. Available: ${registry.names().join(', ')}`,
        });
      }
      const task = tasks.start(target, prompt, workingDirectory ? { cwd: workingDirectory } : {});
      return json({ started: true, id: task.id, agent: task.agent, status: task.status });
    },
  );

  server.registerTool(
    'get_task',
    {
      title: 'Check a delegated task',
      description:
        'Look up a task started with start_task. While "status" is "running" the agent is ' +
        'still working — wait before asking again rather than polling in a tight loop. Once it ' +
        'is "finished", "result" holds the same shape ask_agent returns.',
      inputSchema: {
        id: z.string().describe('The task id returned by start_task.'),
      },
    },
    async ({ id }) => {
      const task = tasks.get(id);
      return task
        ? json(task)
        : json({ id, found: false, diagnostics: 'no task with that id; it may have expired' });
    },
  );

  return server;
}
