import type { FailureKind } from './outcome.js';
import { classifyFailure } from './outcome.js';
import type { AgentResult } from './types.js';

/**
 * What the bridge has learned about each agent by using it.
 *
 * <p>Probing can only say a command exists; whether its account works shows up when it is
 * asked to do something. In the field report, three of four agents listed as available
 * failed at call time -- an exhausted quota, an ineligible account tier, a broken hook --
 * and each was found by spending a call. Quota and sign-in failures are durable: they fail
 * the same way on the next call. So the last one is remembered and shown by list_agents,
 * which lets a caller route around it before spending anything.
 */
export interface AgentHealth {
  calls: number;
  failures: number;
  lastSuccessAt?: number;
  lastFailure?: { kind: FailureKind; message: string; at: number; retryAt?: string };
}

/** How long a failure keeps an agent marked unusable when no success has cleared it. */
const REMEMBER_MS: Record<FailureKind, number> = {
  quota: 60 * 60 * 1000,
  auth: 6 * 60 * 60 * 1000,
  trust: 6 * 60 * 60 * 1000,
  other: 0,
};

export type AgentState = 'ready' | 'unavailable' | 'quota-exhausted' | 'sign-in-failed' | 'directory-not-trusted';

export class HealthStore {
  private readonly byAgent = new Map<string, AgentHealth>();

  record(name: string, result: AgentResult, now = Date.now()): void {
    const health = this.byAgent.get(name) ?? { calls: 0, failures: 0 };
    health.calls += 1;
    if (result.succeeded) {
      health.lastSuccessAt = now;
    } else if (!result.timedOut) {
      // a timeout says the task was big, not that the agent is broken
      health.failures += 1;
      const { kind, retryAt } = classifyFailure(result.diagnostics);
      const firstLine = result.diagnostics.split('\n').find((l) => l.trim()) ?? result.diagnostics;
      health.lastFailure = { kind, message: firstLine.slice(0, 300), at: now, ...(retryAt ? { retryAt } : {}) };
    }
    this.byAgent.set(name, health);
  }

  get(name: string): AgentHealth | undefined {
    return this.byAgent.get(name);
  }

  /** The state a caller should act on: a durable failure newer than the last success wins. */
  state(name: string, probedAvailable: boolean, now = Date.now()): AgentState {
    if (!probedAvailable) return 'unavailable';
    const failure = this.byAgent.get(name)?.lastFailure;
    const success = this.byAgent.get(name)?.lastSuccessAt ?? 0;
    if (!failure || failure.at < success) return 'ready';
    if (now - failure.at > REMEMBER_MS[failure.kind]) return 'ready';
    switch (failure.kind) {
      case 'quota': return 'quota-exhausted';
      case 'auth': return 'sign-in-failed';
      case 'trust': return 'directory-not-trusted';
      default: return 'ready';
    }
  }
}
