import type { Server } from 'node:http';

import { parseAgentMessage, type RelayToAgent } from 'mcpbridge/protocol';
import { WebSocketServer, type WebSocket } from 'ws';

import { bearerFrom, hashToken, tokenKind } from './auth.js';
import type { Db } from './db.js';
import type { DeviceHub } from './hub.js';

const HELLO_DEADLINE_MS = 10_000;
const HEARTBEAT_MS = 30_000;

export interface AgentSocketDeps {
  db: Db;
  hub: DeviceHub;
  log: (line: string) => void;
}

export function sendToAgent(socket: WebSocket, message: RelayToAgent): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

/**
 * The WebSocket endpoint a user's machine connects to. The token on the upgrade decides
 * which account the machine serves; a bad token is accepted and then closed with 4001, a
 * code the agent knows not to retry, rather than refused at the HTTP layer where the agent
 * would only see a generic error and keep trying.
 */
export function attachAgentSocket(server: Server, deps: AgentSocketDeps): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://relay');
    if (url.pathname !== '/agent') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const token = bearerFrom(request.headers.authorization);
      const record = token && tokenKind(token) === 'agent' ? deps.db.findToken(hashToken(token), 'agent') : null;
      if (!record) {
        ws.close(4001, 'unauthorized');
        return;
      }
      deps.db.touchToken(record.hash);
      serve(ws, record.userId, deps);
    });
  });

  // a device that vanished without a close frame would otherwise look connected forever
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const alive = ws as WebSocket & { isAlive?: boolean };
      if (alive.isAlive === false) {
        ws.terminate();
        continue;
      }
      alive.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  server.on('close', () => clearInterval(heartbeat));
}

function serve(ws: WebSocket, userId: string, { hub, log }: AgentSocketDeps): void {
  const alive = ws as WebSocket & { isAlive?: boolean };
  alive.isAlive = true;
  ws.on('pong', () => { alive.isAlive = true; });

  let registered = false;
  const helloTimer = setTimeout(() => {
    if (!registered) ws.close(4002, 'no hello within the deadline');
  }, HELLO_DEADLINE_MS);

  ws.on('message', (data) => {
    const message = parseAgentMessage(data.toString());
    if (!message) return;

    switch (message.type) {
      case 'hello': {
        clearTimeout(helloTimer);
        registered = true;
        const displaced = hub.register({
          userId,
          name: message.device,
          agentVersion: message.agentVersion,
          agents: message.agents,
          connectedAt: Date.now(),
          socket: ws,
        });
        if (displaced && displaced.socket !== ws) {
          sendToAgent(displaced.socket, {
            type: 'goodbye',
            reason: `replaced by a newer connection from "${message.device}"`,
            retry: false,
          });
          displaced.socket.close(1000, 'replaced');
        }
        sendToAgent(ws, { type: 'welcome', device: message.device });
        log(`device "${message.device}" connected for user ${userId} (${message.agents.length} agents)`);
        return;
      }
      case 'agents':
        hub.updateAgents(userId, ws, message.agents);
        return;
      case 'result':
        hub.resolve(message.id, message.ok, message.payload);
        return;
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    hub.remove(userId, ws);
  });
  ws.on('error', (error) => log(`agent socket error for user ${userId}: ${error.message}`));
}
