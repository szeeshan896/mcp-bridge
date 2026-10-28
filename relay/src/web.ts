import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ApiContext } from './api.js';
import { sendHtml } from './http.js';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

export async function handleWeb(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: ApiContext,
  _google: GoogleConfig | undefined,
): Promise<void> {
  sendHtml(res, 404, '<!doctype html><title>mcpbridge</title><p>not found');
}
