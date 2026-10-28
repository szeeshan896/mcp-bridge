import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import WebSocket from 'ws';

import { PROTOCOL_VERSION, parseRelayMessage, type AgentToRelay } from './protocol.js';
import { executeTool, type ToolContext } from './tools.js';

export interface ConnectOptions {
  /** the relay, as http(s):// or ws(s)://; a bare origin gets /agent appended */
  relayUrl: string;
  /** the agent token from the dashboard — identifies which account this machine serves */
  token: string;
  device?: string;
  agentVersion: string;
  context: ToolContext;
  log?: (line: string) => void;
  /** stop instead of reconnecting once the socket closes; for tests */
  once?: boolean;
  signal?: AbortSignal;
  /** how often to push a fresh agent list while connected */
  refreshMs?: number;
}

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/** http -> ws, https -> wss; a URL with no path gets the relay's agent endpoint. */
export function toWebSocketUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/agent';
  return url.toString();
}

/**
 * Keeps this machine connected to a relay and answers the calls it forwards.
 *
 * <p>The connection is outbound, so nothing here listens on a port and no firewall rule is
 * needed. Each forwarded call runs the same executeTool as the local MCP server, so a
 * delegation behaves identically whether it arrived from a client on this machine or from
 * one on the other side of the relay.
 */
export async function connectToRelay(options: ConnectOptions): Promise<void> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const url = toWebSocketUrl(options.relayUrl);
  const device = (options.device ?? hostname()).slice(0, 80);
  let backoff = MIN_BACKOFF_MS;

  while (!options.signal?.aborted) {
    const outcome = await runSession({ ...options, device, url, log });
    if (outcome.stop || options.once) return;
    if (outcome.welcomed) backoff = MIN_BACKOFF_MS;

    const wait = backoff + Math.floor(Math.random() * 500);
    log(`relay: disconnected (${outcome.reason}); reconnecting in ${Math.round(wait / 1000)}s`);
    try {
      await sleep(wait, undefined, { signal: options.signal });
    } catch {
      return;
    }
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

interface SessionOutcome {
  reason: string;
  welcomed: boolean;
  /** the relay told us not to come back, or we were aborted */
  stop: boolean;
}

async function runSession(
  options: ConnectOptions & { device: string; url: string; log: (line: string) => void },
): Promise<SessionOutcome> {
  const { context, log, device, url } = options;
  const refreshMs = options.refreshMs ?? 60_000;

  return new Promise<SessionOutcome>((resolve) => {
    let welcomed = false;
    let settled = false;
    let refreshTimer: NodeJS.Timeout | undefined;
    const finish = (outcome: SessionOutcome) => {
      if (settled) return;
      settled = true;
      if (refreshTimer) clearInterval(refreshTimer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${options.token}` } });
    const send = (message: AgentToRelay) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const onAbort = () => {
      socket.close(1000, 'shutting down');
      finish({ reason: 'aborted', welcomed, stop: true });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    socket.on('open', async () => {
      const agents = await context.registry.statuses();
      send({ type: 'hello', protocol: PROTOCOL_VERSION, agentVersion: options.agentVersion, device, agents });
      refreshTimer = setInterval(async () => {
        send({ type: 'agents', agents: await context.registry.statuses() });
      }, refreshMs);
    });

    socket.on('message', async (data) => {
      const message = parseRelayMessage(data.toString());
      if (!message) {
        log('relay: ignoring a message it could not parse');
        return;
      }
      switch (message.type) {
        case 'welcome':
          welcomed = true;
          log(`relay: connected as device "${message.device}"`);
          return;
        case 'goodbye':
          log(`relay: ${message.reason}`);
          finish({ reason: message.reason, welcomed, stop: !message.retry });
          socket.close(1000);
          return;
        case 'call': {
          // each call is independent; the concurrency limit inside executeTool is what
          // keeps a burst of them from running every agent at once
          try {
            const payload = await executeTool(message.tool, message.args, context);
            send({ type: 'result', id: message.id, ok: true, payload });
          } catch (error) {
            send({ type: 'result', id: message.id, ok: false, payload: (error as Error).message });
          }
          return;
        }
      }
    });

    socket.on('error', (error) => {
      finish({ reason: error.message, welcomed, stop: false });
    });

    socket.on('close', (code, reasonBuffer) => {
      const reason = reasonBuffer.toString() || `socket closed (${code})`;
      // 4001 is the relay refusing the token: retrying with the same one is pointless
      finish({ reason, welcomed, stop: code === 4001 });
    });
  });
}
