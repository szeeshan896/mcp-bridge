/** What a delegated task produced. Every agent kind returns this same shape. */
export interface AgentResult {
  agent: string;
  succeeded: boolean;
  /** what the agent produced — the answer */
  output: string;
  /** why it failed, empty when it did not */
  diagnostics: string;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
}

export interface RunOptions {
  /** directory to run in, so the agent can see a project's files */
  cwd?: string;
}

/**
 * One agent the bridge can hand work to. A CLI and a local model look identical from
 * here, which is what lets a caller treat them interchangeably.
 */
export interface Agent {
  readonly name: string;
  readonly description: string;
  /** the executable or endpoint that has to exist, reported by list_agents */
  readonly requires: string;
  /** whether it can actually be used right now */
  probe(): Promise<{ available: boolean; detail: string }>;
  run(prompt: string, options: RunOptions): Promise<AgentResult>;
}

export function failed(agent: string, diagnostics: string, durationMs = 0, timedOut = false): AgentResult {
  return { agent, succeeded: false, output: '', diagnostics, durationMs, timedOut, outputTruncated: false };
}

export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return { text: trimmed, truncated: false };
  return { text: `${trimmed.slice(0, maxChars)}\n...[truncated]`, truncated: true };
}
