import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { configPath } from './config.js';

/**
 * What must not sit in config.json: API keys and the relay token.
 *
 * <p>config.json is the file people paste into issues and copy between machines, so it
 * names keys by environment variable (`apiKeyEnv`) and never holds one. The values live
 * here instead, next to it, readable only by the user where the platform allows. At
 * startup they are copied into the process environment for any variable not already set,
 * so a key saved once works in every window -- no `setx`, no terminal restart -- and a
 * variable exported the usual way still wins.
 */
export interface Secrets {
  /** environment variable name -> value */
  keys: Record<string, string>;
  relay?: { url: string; token: string; device?: string };
}

export function secretsPath(): string {
  return process.env['MCPBRIDGE_SECRETS'] ?? join(dirname(configPath()), 'secrets.json');
}

export function loadSecrets(path = secretsPath()): Secrets {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { keys: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Secrets>;
    const keys = Object.fromEntries(
      Object.entries(parsed.keys ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
    const relay = parsed.relay && typeof parsed.relay.url === 'string' && typeof parsed.relay.token === 'string'
      ? parsed.relay
      : undefined;
    return relay ? { keys, relay } : { keys };
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

/** Written whole, through a temporary file, so a crash mid-write cannot leave half a file. */
export function saveSecrets(secrets: Secrets, path = secretsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows has no POSIX modes; the user profile directory is what protects it there
  }
}

/** Saved keys become environment variables, without overriding one already exported. */
export function applySecretsToEnv(secrets: Secrets, env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, value] of Object.entries(secrets.keys)) {
    if (!env[name]) env[name] = value;
  }
}

/** Enough to recognise a key on screen without showing it. */
export function maskSecret(value: string | undefined): string | null {
  if (!value) return null;
  return value.length <= 8 ? '••••' : `••••${value.slice(-4)}`;
}
