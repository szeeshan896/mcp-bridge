import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join, sep } from 'node:path';

import type { CliAgentConfig } from '../config.js';
import { type Agent, type AgentResult, type RunOptions, failed, truncate } from './types.js';

export const PROMPT_PLACEHOLDER = '{prompt}';

/**
 * An agent that is a command-line tool. The command comes from configuration and the
 * prompt only ever fills {prompt}, as one argv element handed straight to spawn with no
 * shell, so nothing in a prompt can be read as a shell metacharacter.
 */
export class CliAgent implements Agent {
  readonly requires: string;

  constructor(
    readonly name: string,
    private readonly config: CliAgentConfig,
    private readonly maxOutputChars: number,
  ) {
    if (config.command.length === 0) {
      throw new Error(`agent "${name}": command must not be empty`);
    }
    if (!config.command.some((part) => part.includes(PROMPT_PLACEHOLDER))) {
      throw new Error(`agent "${name}": command needs one ${PROMPT_PLACEHOLDER} element`);
    }
    this.requires = config.command[0]!;
  }

  get description(): string {
    return this.config.description ?? `the ${this.requires} command`;
  }

  async probe(): Promise<{ available: boolean; detail: string }> {
    const found = await onPath(this.requires);
    return found
      ? { available: true, detail: `${this.requires} found on PATH` }
      : { available: false, detail: `${this.requires} is not on PATH — install it or fix the command` };
  }

  run(prompt: string, options: RunOptions): Promise<AgentResult> {
    const argv = this.config.command.map((part) => part.replaceAll(PROMPT_PLACEHOLDER, prompt));
    const [command, ...args] = argv as [string, ...string[]];
    const timeoutMs = this.config.timeoutMs ?? 300_000;
    const cwd = options.cwd ?? this.config.cwd;
    const started = Date.now();

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, args, {
          cwd,
          // own process group, so a timeout can take the whole tree down: killing just the
          // child leaves grandchildren alive, and an orphan holding the pipe keeps us
          // waiting for its lifetime
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve(failed(this.name, `could not start ${command}: ${(error as Error).message}`));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      // stdout and stderr are consumed as they arrive, so neither pipe can fill and stall
      // the child while we are busy with the other
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killTree(child.pid);
        resolve(failed(this.name,
          `${this.name} did not finish within ${timeoutMs}ms and was stopped. Try a smaller task.`,
          Date.now() - started, true));
      }, timeoutMs);

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(failed(this.name,
          `could not start ${command}. Is it installed and on PATH? (${error.message})`,
          Date.now() - started));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const body = truncate(stdout, this.maxOutputChars);
        if (code === 0) {
          resolve({
            agent: this.name, succeeded: true, output: body.text, diagnostics: '',
            durationMs: Date.now() - started, timedOut: false, outputTruncated: body.truncated,
          });
        } else {
          resolve({
            agent: this.name, succeeded: false, output: body.text,
            diagnostics: `${this.name} exited with code ${code}. ${truncate(stderr, 4_000).text}`.trim(),
            durationMs: Date.now() - started, timedOut: false, outputTruncated: body.truncated,
          });
        }
      });
    });
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

export async function onPath(executable: string): Promise<boolean> {
  if (executable.includes(sep) || executable.includes('/')) {
    return accessible(executable);
  }
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      if (await accessible(join(dir, executable + suffix))) return true;
    }
  }
  return false;
}

async function accessible(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
