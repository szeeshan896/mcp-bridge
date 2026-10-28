import type { AgentRegistry } from './agents/registry.js';
import type { ConcurrencyLimit } from './limit.js';
import type { TaskStore } from './tasks.js';

/**
 * The four tools, as plain functions over plain JSON. Both front doors — the MCP server a
 * client talks to directly, and the relay connection that forwards calls from a hosted
 * endpoint — run exactly this, so a tool cannot behave differently depending on how the
 * request arrived.
 */
export const TOOL_NAMES = ['list_agents', 'ask_agent', 'start_task', 'get_task'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolContext {
  registry: AgentRegistry;
  tasks: TaskStore;
  limit: ConcurrencyLimit;
}

export interface DelegationArgs {
  agent: string;
  prompt: string;
  workingDirectory?: string;
}

export async function executeTool(
  name: ToolName,
  args: Record<string, unknown>,
  { registry, tasks, limit }: ToolContext,
): Promise<unknown> {
  switch (name) {
    case 'list_agents':
      return registry.statuses();

    case 'ask_agent': {
      const { agent, prompt, workingDirectory } = delegation(args);
      const target = registry.find(agent);
      if (!target) return unknownAgent(agent, registry);
      const options = workingDirectory ? { cwd: workingDirectory } : {};
      return limit.run(() => target.run(prompt, options));
    }

    case 'start_task': {
      const { agent, prompt, workingDirectory } = delegation(args);
      const target = registry.find(agent);
      if (!target) return { started: false, ...unknownAgent(agent, registry) };
      const task = tasks.start(target, prompt, workingDirectory ? { cwd: workingDirectory } : {});
      return { started: true, id: task.id, agent: task.agent, status: task.status };
    }

    case 'get_task': {
      const id = String(args['id'] ?? '');
      const task = tasks.get(id);
      return task ?? { id, found: false, diagnostics: 'no task with that id; it may have expired' };
    }
  }
}

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

function delegation(args: Record<string, unknown>): DelegationArgs {
  const agent = String(args['agent'] ?? '');
  const prompt = String(args['prompt'] ?? '');
  const wd = args['workingDirectory'];
  return { agent, prompt, ...(typeof wd === 'string' && wd ? { workingDirectory: wd } : {}) };
}

function unknownAgent(agent: string, registry: AgentRegistry) {
  return {
    agent,
    succeeded: false,
    output: '',
    diagnostics: `no agent named "${agent}" is configured. Available: ${registry.names().join(', ')}`,
    notes: '',
  };
}
