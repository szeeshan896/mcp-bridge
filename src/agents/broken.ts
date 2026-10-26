import { type Agent, type AgentResult, failed } from './types.js';

/**
 * Stands in for an agent whose configuration could not be used.
 *
 * <p>Without this, one bad entry in the config file threw during startup and took the
 * whole bridge with it — every other agent included — and over stdio the client saw only
 * a process that died, with the reason going nowhere a person would look.
 */
export class BrokenAgent implements Agent {
  readonly readsFiles = false;
  readonly requires = 'a valid configuration';

  constructor(
    readonly name: string,
    private readonly reason: string,
  ) {}

  get description(): string {
    return `misconfigured: ${this.reason}`;
  }

  async probe(): Promise<{ available: boolean; detail: string }> {
    return { available: false, detail: `misconfigured: ${this.reason}` };
  }

  async run(): Promise<AgentResult> {
    return failed(this.name, `agent "${this.name}" is misconfigured: ${this.reason}`);
  }
}
