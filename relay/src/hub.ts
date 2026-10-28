import { randomUUID } from 'node:crypto';

import type { AgentStatus } from 'mcpbridge/protocol';
import type { WebSocket } from 'ws';

export interface Device {
  userId: string;
  name: string;
  agentVersion: string;
  agents: AgentStatus[];
  connectedAt: number;
  socket: WebSocket;
}

interface Pending {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class DeviceOfflineError extends Error {
  constructor() {
    super(
      'no device is connected for this account. On the machine where your AI CLIs are signed ' +
        'in, run: mcpbridge connect --relay <this relay> --token <your agent token>',
    );
    this.name = 'DeviceOfflineError';
  }
}

/**
 * The connected devices, one per account, and the calls in flight to each.
 *
 * <p>In memory on purpose: a device's connection lives exactly as long as this process
 * does, so there is nothing to persist. What is persisted — accounts and token hashes —
 * lives in the database.
 */
export class DeviceHub {
  private readonly devices = new Map<string, Device>();
  private readonly pending = new Map<string, Pending>();

  /** Registers a device, displacing any earlier one for the same account. */
  register(device: Device): Device | null {
    const displaced = this.devices.get(device.userId) ?? null;
    this.devices.set(device.userId, device);
    return displaced;
  }

  get(userId: string): Device | null {
    return this.devices.get(userId) ?? null;
  }

  updateAgents(userId: string, socket: WebSocket, agents: AgentStatus[]): void {
    const device = this.devices.get(userId);
    if (device && device.socket === socket) device.agents = agents;
  }

  /** Forgets a device, failing anything still waiting on it. Only if it is still current. */
  remove(userId: string, socket: WebSocket): void {
    const device = this.devices.get(userId);
    if (!device || device.socket !== socket) return;
    this.devices.delete(userId);
    for (const [id, waiting] of this.pending) {
      if (id.startsWith(`${userId}:`)) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error('the device disconnected while this call was running'));
        this.pending.delete(id);
      }
    }
  }

  /** Forwards one tool call and waits for its result, or for the timeout. */
  call(userId: string, tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const device = this.devices.get(userId);
    if (!device) return Promise.reject(new DeviceOfflineError());

    const id = `${userId}:${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the device did not answer within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      device.socket.send(JSON.stringify({ type: 'call', id, tool, args }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`could not reach the device: ${error.message}`));
        }
      });
    });
  }

  /** Delivers a result from a device; results for calls nobody is waiting on are dropped. */
  resolve(id: string, ok: boolean, payload: unknown): void {
    const waiting = this.pending.get(id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.pending.delete(id);
    if (ok) waiting.resolve(payload);
    else waiting.reject(new Error(typeof payload === 'string' ? payload : 'the device reported a failure'));
  }

  get size(): number {
    return this.devices.size;
  }
}
