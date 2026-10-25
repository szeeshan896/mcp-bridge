import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CliAgentConfig {
  type?: 'cli';
  description?: string;
  /** argv, exactly one element of which contains {prompt} */
  command: string[];
  timeoutMs?: number;
  /** default directory, overridden per call */
  cwd?: string;
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
  agents: {
    claude: {
      description: 'Claude Code — refactoring, tests, reading large codebases',
      command: ['claude', '-p', '{prompt}'],
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
      agents: { ...DEFAULT_CONFIG.agents, ...(parsed.agents ?? {}) },
    },
    source: path,
  };
}
