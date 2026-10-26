import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A Node stand-in for a real agent CLI, so these tests run on Windows too. */
export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'agent.mjs');

export const echoCommand = [process.execPath, FIXTURE, 'echo', '{prompt}'];
