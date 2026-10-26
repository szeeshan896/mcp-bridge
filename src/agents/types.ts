/** What a delegated task produced. Every agent kind returns this same shape. */
export interface AgentResult {
  agent: string;
  succeeded: boolean;
  /** what the agent produced — the answer */
  output: string;
  /** why it failed, empty when it did not */
  diagnostics: string;
  /**
   * Something the caller should know about a call that still succeeded — for instance
   * that a workingDirectory was ignored because this agent cannot read files. Kept apart
   * from diagnostics so "succeeded with a caveat" is not mistaken for a failure.
   */
  notes: string;
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
  /**
   * Whether pointing this agent at a directory actually lets it read the files there. A
   * coding CLI can; a model behind an HTTP API cannot, and the caller has to inline the
   * context instead of assuming otherwise.
   */
  readonly readsFiles: boolean;
  /** whether it can actually be used right now */
  probe(): Promise<{ available: boolean; detail: string }>;
  run(prompt: string, options: RunOptions): Promise<AgentResult>;
}

export function failed(agent: string, diagnostics: string, durationMs = 0, timedOut = false): AgentResult {
  return {
    agent, succeeded: false, output: '', diagnostics, notes: '',
    durationMs, timedOut, outputTruncated: false,
  };
}

// eslint-disable-next-line no-control-regex
const ANSI = /[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nq-uy=><~]/g;

/**
 * Strips terminal escape sequences. A CLI writing colour, spinners or progress bars to
 * stdout would otherwise have all of it land in the calling model's context as if it were
 * part of the answer.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  const trimmed = stripAnsi(text).trim();
  if (trimmed.length <= maxChars) return { text: trimmed, truncated: false };
  return { text: `${trimmed.slice(0, maxChars)}\n...[truncated]`, truncated: true };
}
