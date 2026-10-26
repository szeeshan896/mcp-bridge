import { existsSync } from 'node:fs';
import { win32 as windowsPath } from 'node:path';

/**
 * What a Windows batch shim actually invokes.
 *
 * @param command  the executable to run instead of the shim
 * @param prefix   arguments that must come before the agent's own, e.g. the script path
 *                 when the shim runs a .js file through node
 */
export interface ShimTarget {
  command: string;
  prefix: string[];
}

const QUOTED_DP0 = /"([^"]*%dp0%[^"]*)"/gi;
const RUNNABLE = /\.(exe|com|js|cjs|mjs)$/i;

/**
 * Finds the real program behind an npm-generated .cmd shim.
 *
 * <p>Windows users get a shim for every npm-installed CLI, and a shim can only be run
 * through a shell — which a prompt must never touch. Rather than refusing every such
 * agent, which on Windows is all of them, the shim is read and the program it calls is
 * run directly. The shim is only ever read, never executed.
 *
 * <p>npm writes the target as a quoted path built from %dp0%, the shim's own directory:
 *
 * <pre>
 *   "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*
 * </pre>
 *
 * and, for packages without a native binary, as a script passed to node:
 *
 * <pre>
 *   "%_prog%"  "%dp0%\\node_modules\\some-cli\\cli.js" %*
 * </pre>
 *
 * Both shapes are handled, and a target that is not on disk is ignored, so a shim this
 * does not understand falls back to being refused rather than producing a wrong command.
 */
export function parseShimTarget(
  content: string,
  shimDir: string,
  nodeExecutable: string,
  exists: (path: string) => boolean = existsSync,
): ShimTarget | null {
  const candidates: string[] = [];
  for (const match of content.matchAll(QUOTED_DP0)) {
    const raw = match[1];
    if (!raw) continue;
    // win32 semantics explicitly: a shim is a Windows file, and the default path module
    // would read "C:\\..." as a relative path everywhere else — including in these tests
    const substituted = raw.replace(/%dp0%/gi, `${shimDir}\\`).replace(/\\\\+/g, '\\');
    const resolved = windowsPath.isAbsolute(substituted)
      ? windowsPath.normalize(substituted)
      : windowsPath.normalize(windowsPath.join(shimDir, substituted));
    if (RUNNABLE.test(resolved) && exists(resolved)) candidates.push(resolved);
  }
  if (candidates.length === 0) return null;

  // a native binary is run as itself; a script needs the node that is running us, not the
  // bare "node" the shim would have looked up on PATH
  const binary = candidates.find((path) => /\.(exe|com)$/i.test(path));
  if (binary) return { command: binary, prefix: [] };

  const script = candidates[0]!;
  return { command: nodeExecutable, prefix: [script] };
}
