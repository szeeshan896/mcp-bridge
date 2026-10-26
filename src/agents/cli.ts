import { spawn } from 'node:child_process';
import { constants, readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, dirname, join, sep } from 'node:path';

import type { CliAgentConfig } from '../config.js';
import { type ShimTarget, parseShimTarget } from './shim.js';
import { type Agent, type AgentResult, type RunOptions, failed, truncate } from './types.js';

export const PROMPT_PLACEHOLDER = '{prompt}';

/** Colour and spinners in an answer are noise; most CLIs honour these. */
const QUIET_ENV = { NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' };

/**
 * An agent that is a command-line tool. The command comes from configuration and the
 * prompt only ever fills {prompt} or goes down stdin — never through a shell, so nothing
 * in a prompt can be read as a shell metacharacter.
 */
export class CliAgent implements Agent {
  readonly requires: string;
  readonly readsFiles = true;

  constructor(
    readonly name: string,
    private readonly config: CliAgentConfig,
    private readonly maxOutputChars: number,
  ) {
    if (config.command.length === 0) {
      throw new Error(`agent "${name}": command must not be empty`);
    }
    if (this.promptVia === 'argv' && !config.command.some((p) => p.includes(PROMPT_PLACEHOLDER))) {
      throw new Error(
        `agent "${name}": command needs one ${PROMPT_PLACEHOLDER} element, or promptVia: "stdin"`,
      );
    }
    this.requires = config.command[0]!;
  }

  private get promptVia(): 'argv' | 'stdin' {
    return this.config.promptVia ?? 'argv';
  }

  get description(): string {
    return this.config.description ?? `the ${this.requires} command`;
  }

  async probe(): Promise<{ available: boolean; detail: string }> {
    const resolved = await resolveOnPath(this.requires);
    if (!resolved) {
      return { available: false, detail: `${this.requires} is not on PATH — install it or fix the command` };
    }
    if (!needsAShell(resolved)) {
      return { available: true, detail: `${this.requires} found at ${resolved}` };
    }
    const behindShim = readShim(resolved);
    return behindShim
      ? { available: true, detail: `${this.requires} is a shim for ${behindShim.command}` }
      : { available: false, detail: batchFileAdvice(this.requires, resolved) };
  }

  async run(prompt: string, options: RunOptions): Promise<AgentResult> {
    const resolved = await resolveOnPath(this.requires);
    let replacement: ShimTarget | null = null;
    if (resolved && needsAShell(resolved)) {
      replacement = readShim(resolved);
      if (!replacement) return failed(this.name, batchFileAdvice(this.requires, resolved));
    }
    return this.spawnAgent(prompt, options, replacement);
  }

  private spawnAgent(
    prompt: string,
    options: RunOptions,
    replacement: ShimTarget | null,
  ): Promise<AgentResult> {
    const viaStdin = this.promptVia === 'stdin';
    const configured = viaStdin
      ? [...this.config.command]
      : this.config.command.map((part) => part.replaceAll(PROMPT_PLACEHOLDER, prompt));
    // the shim's own argv[0] is replaced by what it would have run, keeping the agent's
    // own flags after it
    const argv = replacement
      ? [replacement.command, ...replacement.prefix, ...configured.slice(1)]
      : configured;
    const [command, ...args] = argv as [string, ...string[]];
    const timeoutMs = this.config.timeoutMs ?? 300_000;
    const cwd = options.cwd ?? this.config.cwd;
    const started = Date.now();

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, args, {
          cwd,
          env: { ...process.env, ...QUIET_ENV, ...(this.config.env ?? {}) },
          // own process group, so a timeout can take the whole tree down: killing just the
          // child leaves grandchildren alive, and an orphan holding the pipe keeps us
          // waiting for its lifetime
          detached: process.platform !== 'win32',
          stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve(failed(this.name, this.startupAdvice(command, error as Error, prompt)));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result: AgentResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      // stdout and stderr are consumed as they arrive, so neither pipe can fill and stall
      // the child while we are busy with the other
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

      if (viaStdin && child.stdin) {
        child.stdin.on('error', () => { /* the agent closed stdin early; its output still counts */ });
        child.stdin.end(prompt, 'utf8');
      }

      const timer = setTimeout(() => {
        killTree(child.pid);
        finish(failed(this.name,
          `${this.name} did not finish within ${timeoutMs}ms and was stopped. Try a smaller task.`,
          Date.now() - started, true));
      }, timeoutMs);

      child.on('error', (error) => {
        finish(failed(this.name, this.startupAdvice(command, error, prompt), Date.now() - started));
      });

      child.on('close', (code) => {
        const body = truncate(stdout, this.maxOutputChars);
        finish({
          agent: this.name,
          succeeded: code === 0,
          output: body.text,
          diagnostics: code === 0
            ? ''
            : `${this.name} exited with code ${code}. ${truncate(stderr, 4_000).text}`.trim(),
          notes: '',
          durationMs: Date.now() - started,
          timedOut: false,
          outputTruncated: body.truncated,
        });
      });
    });
  }

  private startupAdvice(command: string, error: Error & { code?: string }, prompt: string): string {
    return startupAdvice(this.name, command, error, prompt);
  }
}

/**
 * Both of these mean the operating system refused an over-long argument list, which a
 * prompt carrying file contents reaches easily. POSIX reports E2BIG and Windows
 * ENAMETOOLONG; treating only one of them as the size problem left Windows users with
 * "is it installed?", which is the wrong thing to go and check.
 */
const ARG_TOO_LONG = new Set(['E2BIG', 'ENAMETOOLONG']);

/**
 * Turns a spawn failure into something the caller can act on. The size limit varies by
 * platform — roughly 128KB per argument on Linux, about 1MB on macOS, and as little as
 * 32KB on Windows — so the advice names the setting that removes it rather than a number.
 */
export function startupAdvice(
  agent: string,
  command: string,
  error: Error & { code?: string },
  prompt: string,
): string {
  if (error.code && ARG_TOO_LONG.has(error.code)) {
    return (
      `the prompt is too large to pass as a command-line argument (${prompt.length} characters; ` +
      `the operating system's limit is as low as 32KB on Windows). Set "promptVia": "stdin" for ` +
      `agent "${agent}" if ${command} reads its prompt from a pipe, or send a shorter prompt.`
    );
  }
  return `could not start ${command}. Is it installed and on PATH? (${error.message})`;
}

/**
 * Reads what a Windows shim would have run. Reading it is safe where executing it is not:
 * nothing from the prompt reaches the file, and the program it names is spawned directly.
 */
function readShim(shimPath: string): ShimTarget | null {
  try {
    return parseShimTarget(readFileSync(shimPath, 'utf8'), dirname(shimPath), process.execPath);
  } catch {
    return null;
  }
}

/** Kills the process group on POSIX, the tree via taskkill on Windows. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // already gone
  }
}

/**
 * A .cmd or .bat can only be run through a shell, and running the prompt through a shell
 * is exactly what this program must never do: quoting rules for batch files are their own
 * minefield (see CVE-2024-27980). So such an agent is refused with the fix, rather than
 * made to work unsafely or left to fail as a bare ENOENT.
 */
export function needsAShell(resolvedPath: string): boolean {
  if (process.platform !== 'win32') return false;
  const lower = resolvedPath.toLowerCase();
  return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

function batchFileAdvice(executable: string, resolved: string): string {
  return (
    `${executable} resolves to ${resolved}, a Windows batch shim whose target could not be ` +
    `read, and a shim can only run through a shell — which a prompt must not touch. Point ` +
    `this agent at the real executable instead, e.g. ` +
    `"command": ["C:\\\\path\\\\to\\\\${executable}.exe", "{prompt}"].`
  );
}

export async function resolveOnPath(executable: string): Promise<string | null> {
  if (executable.includes(sep) || executable.includes('/')) {
    return (await accessible(executable)) ? executable : null;
  }
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const suffixes = process.platform === 'win32' ? ['.exe', '.com', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, executable + suffix);
      if (await accessible(candidate)) return candidate;
    }
  }
  return null;
}

export async function onPath(executable: string): Promise<boolean> {
  return (await resolveOnPath(executable)) !== null;
}

async function accessible(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
