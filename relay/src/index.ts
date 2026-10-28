import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';

import { attachAgentSocket } from './agentSocket.js';
import { handleApi, type ApiContext } from './api.js';
import { Db } from './db.js';
import { DeviceHub } from './hub.js';
import { RateLimiter, sendJson } from './http.js';
import { handleMcp } from './mcp.js';
import { handleOAuth } from './oauth.js';
import type { exchangeCode } from './google.js';
import { handleWeb } from './web.js';

export interface RelayConfig {
  sessionSecret: string;
  databasePath: string;
  publicUrl?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  /** replaces the call to Google in tests */
  googleExchange?: typeof exchangeCode;
  /** replaces the fetch of an OAuth client's metadata document in tests */
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface Relay {
  server: Server;
  db: Db;
  hub: DeviceHub;
  listen(port: number, host: string): Promise<{ port: number }>;
  close(): Promise<void>;
}

export function createRelay(config: RelayConfig): Relay {
  const log = config.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const db = new Db(config.databasePath);
  const hub = new DeviceHub();
  const ctx: ApiContext = {
    db,
    hub,
    sessionSecret: config.sessionSecret,
    publicUrl: config.publicUrl,
    secureCookies: config.publicUrl?.startsWith('https://') ?? false,
    loginLimiter: new RateLimiter(10, 60_000),
    oauthLimiter: new RateLimiter(30, 60_000),
    totpUsed: new Map(),
    fetchImpl: config.fetchImpl ?? ((input, init) => fetch(input, init)),
    clientDocuments: new Map(),
    log,
  };
  const google = config.googleClientId && config.googleClientSecret
    ? {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        ...(config.googleExchange ? { exchange: config.googleExchange } : {}),
      }
    : undefined;

  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://relay').pathname;
      if (path === '/healthz') {
        sendJson(res, 200, { ok: true, devices: hub.size });
        return;
      }
      if (path === '/mcp') {
        await handleMcp(req, res, { db, hub, publicUrl: config.publicUrl });
        return;
      }
      if (await handleOAuth(req, res, ctx)) return;
      if (await handleApi(req, res, ctx)) return;
      await handleWeb(req, res, ctx, google);
    })().catch((error: unknown) => {
      log(`request failed: ${(error as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  attachAgentSocket(server, { db, hub, log });

  return {
    server,
    db,
    hub,
    listen: (port, host) =>
      new Promise((resolve) => {
        server.listen(port, host, () => resolve({ port: (server.address() as { port: number }).port }));
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
        // idle keep-alive connections would otherwise hold close() open
        server.closeAllConnections();
      }),
  };
}

async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 8080);
  const host = process.env['HOST'] ?? '0.0.0.0';
  const publicUrl = process.env['PUBLIC_URL'];
  let sessionSecret = process.env['SESSION_SECRET'];
  if (!sessionSecret) {
    if (process.env['NODE_ENV'] === 'production') {
      console.error('SESSION_SECRET is required in production (any long random string)');
      process.exit(1);
    }
    sessionSecret = randomBytes(32).toString('base64url');
    console.error('SESSION_SECRET not set: using a random one, so sessions end when this process does');
  }

  const relay = createRelay({
    sessionSecret,
    databasePath: process.env['DATABASE_PATH'] ?? './data/relay.sqlite',
    ...(publicUrl ? { publicUrl } : {}),
    ...(process.env['GOOGLE_CLIENT_ID'] ? { googleClientId: process.env['GOOGLE_CLIENT_ID'] } : {}),
    ...(process.env['GOOGLE_CLIENT_SECRET'] ? { googleClientSecret: process.env['GOOGLE_CLIENT_SECRET'] } : {}),
  });
  const bound = await relay.listen(port, host);
  console.error(`mcpbridge relay on http://${host}:${bound.port}${publicUrl ? ` (public: ${publicUrl})` : ''}`);

  const shutdown = () => void relay.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`relay failed to start: ${(error as Error).message}`);
    process.exit(1);
  });
}
