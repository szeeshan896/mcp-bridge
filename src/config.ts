import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CliAgentConfig {
  type?: 'cli';
  description?: string;
  /** argv; needs one element containing {prompt} unless promptVia is "stdin" */
  command: string[];
  /**
   * How the prompt reaches the agent. "argv" is subject to the operating system's
   * argument-size limit, which a prompt carrying file contents passes easily — roughly
   * 64KB on Linux and 32KB on Windows, after which the spawn fails outright. "stdin" has
   * no such limit, and is right for any CLI that reads its prompt from a pipe.
   */
  promptVia?: 'argv' | 'stdin';
  timeoutMs?: number;
  /** default directory, overridden per call */
  cwd?: string;
  /** extra environment for the child, merged over this process's own */
  env?: Record<string, string>;
}

export interface OllamaAgentConfig {
  type: 'ollama';
  description?: string;
  /** omit to use the first model Ollama reports as installed */
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export type AgentConfig = CliAgentConfig | OllamaAgentConfig;

export interface Config {
  maxOutputChars: number;
  /**
   * How many delegations may run at once. Each one is a whole model doing real work, so
   * an unbounded number of them saturates the machine and burns through the quota of
   * whatever account is behind them.
   */
  maxConcurrent: number;
  agents: Record<string, AgentConfig>;
}

/**
 * Works with no configuration at all: the CLIs people already have, plus whatever Ollama
 * is serving locally. An entry whose tool is not installed is simply reported as
 * unavailable by list_agents, so shipping all four costs nothing.
 *
 * The flags are each tool's documented non-interactive mode, but they do change between
 * releases — override any entry in the config file if yours differs.
 */
export const DEFAULT_CONFIG: Config = {
  maxOutputChars: 60_000,
  maxConcurrent: 2,
  agents: {
    claude: {
      description: 'Claude Code — refactoring, tests, reading large codebases',
      // verified: claude -p reads the prompt from stdin, which lifts the argv size limit
      command: ['claude', '-p'],
      promptVia: 'stdin',
      timeoutMs: 300_000,
    },
    codex: {
      description: 'OpenAI Codex CLI — algorithms and single-file problems',
      command: ['codex', 'exec', '{prompt}'],
      timeoutMs: 300_000,
    },
    gemini: {
      description: 'Google Gemini CLI — large context, whole-repo questions',
      command: ['gemini', '-p', '{prompt}'],
      timeoutMs: 300_000,
    },
    ollama: {
      type: 'ollama',
      description: 'A model running locally in Ollama — no account, no network, always awake',
      timeoutMs: 300_000,
    },
  },
};

export function configPath(): string {
  return process.env.MCPBRIDGE_CONFIG ?? join(homedir(), '.config', 'mcpbridge', 'config.json');
}

/**
 * Agents from the file replace same-named defaults outright rather than merging field by
 * field, so overriding a command cannot leave half of the old one behind.
 */
export function loadConfig(path = configPath()): { config: Config; source: string } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { config: DEFAULT_CONFIG, source: 'defaults (no config file)' };
  }

  let parsed: Partial<Config>;
  try {
    parsed = JSON.parse(raw) as Partial<Config>;
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }

  return {
    config: {
      maxOutputChars: parsed.maxOutputChars ?? DEFAULT_CONFIG.maxOutputChars,
      maxConcurrent: Math.max(1, parsed.maxConcurrent ?? DEFAULT_CONFIG.maxConcurrent),
      agents: { ...DEFAULT_CONFIG.agents, ...(parsed.agents ?? {}) },
    },
    source: path,
  };
}
