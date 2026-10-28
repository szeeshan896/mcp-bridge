import type { AgentRegistry } from './agents/registry.js';
import type { RunOptions } from './agents/types.js';
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
  /** the caller's bound on this one call; only ever shortens the agent's own timeout */
  timeoutSeconds?: number;
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
      const parsed = delegation(args);
      const target = registry.find(parsed.agent);
      if (!target) return unknownAgent(parsed.agent, registry);
      return limit.run(() => target.run(parsed.prompt, runOptions(parsed)));
    }

    case 'start_task': {
      const parsed = delegation(args);
      const target = registry.find(parsed.agent);
      if (!target) return { started: false, ...unknownAgent(parsed.agent, registry) };
      const task = tasks.start(target, parsed.prompt, runOptions(parsed));
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
  const seconds = Number(args['timeoutSeconds']);
  return {
    agent, prompt,
    ...(typeof wd === 'string' && wd ? { workingDirectory: wd } : {}),
    ...(Number.isFinite(seconds) && seconds > 0 ? { timeoutSeconds: Math.min(seconds, 3_600) } : {}),
  };
}

function runOptions(args: DelegationArgs): RunOptions {
  return {
    ...(args.workingDirectory ? { cwd: args.workingDirectory } : {}),
    ...(args.timeoutSeconds ? { timeoutMs: args.timeoutSeconds * 1000 } : {}),
  };
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
