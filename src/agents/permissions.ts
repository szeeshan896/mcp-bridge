import { basename } from 'node:path';

import type { CliAgentConfig } from '../config.js';

/**
 * What a coding CLI may do when it runs unattended, and the flags that grant it.
 *
 * <p>Every one of these CLIs is cautious by default when there is no person to approve a
 * step: Codex runs in a read-only sandbox, Claude Code denies edits and shell commands it
 * was not pre-approved for, Grok Build and Gemini CLI stop at their approval prompts. That
 * is the right default for a bridge any connected client can call -- but a second field
 * report showed the cost of leaving it unsaid: five detailed briefs asking agents to write
 * a test file and run it, against agents that could do neither, discovered only because
 * one of them happened to explain itself. So the bridge now says, per agent, whether it
 * can write files and run commands, and lets the owner switch that on per agent.
 *
 * <p>The flags are each CLI's documented ones at the time of writing. A CLI the bridge
 * does not know gets no flags; its owner can declare what it can do with "capabilities".
 */
export interface Allow {
  /** let it create and change files in the working directory */
  edits?: boolean;
  /** let it run shell commands (tests, builds) */
  commands?: boolean;
  /** treat the working directory as trusted, for CLIs that refuse untrusted ones */
  trustDirectory?: boolean;
}

export interface Permissions {
  /** appended after the configured command */
  args: string[];
  env: Record<string, string>;
  writesFiles: boolean;
  runsCommands: boolean;
  /** which switches mean anything for this CLI, so the control panel shows only those */
  supports: { edits: boolean; commands: boolean; trustDirectory: boolean };
  /** e.g. that one switch implies the other for this CLI */
  note: string;
}

type Known = 'claude' | 'codex' | 'grok' | 'gemini';

/** The CLI a command runs, by executable name, whatever path or extension it has. */
export function knownCli(executable: string): Known | null {
  const name = basename(executable.replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  return name === 'claude' || name === 'codex' || name === 'grok' || name === 'gemini' ? name : null;
}

export function permissionsFor(config: CliAgentConfig): Permissions {
  const allow: Allow = config.allow ?? {};
  const declared = config.capabilities ?? {};
  const none = { args: [], env: {}, note: '' };

  switch (knownCli(config.command[0] ?? '')) {
    case 'claude': {
      const args = [
        ...(allow.edits ? ['--permission-mode', 'acceptEdits'] : []),
        ...(allow.commands ? ['--allowedTools', 'Bash'] : []),
      ];
      return {
        args, env: {}, writesFiles: Boolean(allow.edits), runsCommands: Boolean(allow.commands),
        supports: { edits: true, commands: true, trustDirectory: false }, note: '',
      };
    }
    case 'codex': {
      // one sandbox switch covers both: workspace-write lets it change files and run
      // commands inside the working directory, still without network access
      const on = Boolean(allow.edits || allow.commands);
      return {
        args: on ? ['--sandbox', 'workspace-write'] : [], env: {}, writesFiles: on, runsCommands: on,
        supports: { edits: true, commands: true, trustDirectory: false },
        note: 'For Codex, edits and commands are one sandbox setting: turning on either turns on both.',
      };
    }
    case 'grok': {
      const on = Boolean(allow.edits || allow.commands);
      return {
        args: on ? ['--always-approve'] : [], env: {}, writesFiles: on, runsCommands: on,
        supports: { edits: true, commands: true, trustDirectory: false },
        note: 'Grok Build approves everything or nothing: turning on either turns on both.',
      };
    }
    case 'gemini': {
      const mode = allow.commands ? 'yolo' : allow.edits ? 'auto_edit' : null;
      return {
        args: mode ? ['--approval-mode', mode] : [],
        env: allow.trustDirectory ? { GEMINI_CLI_TRUST_WORKSPACE: 'true' } : {},
        writesFiles: mode !== null, runsCommands: mode === 'yolo',
        supports: { edits: true, commands: true, trustDirectory: true },
        note: 'Allowing commands also allows edits for Gemini CLI.',
      };
    }
    default:
      return {
        ...none,
        writesFiles: Boolean(declared.writesFiles), runsCommands: Boolean(declared.runsCommands),
        supports: { edits: false, commands: false, trustDirectory: false },
      };
  }
}
