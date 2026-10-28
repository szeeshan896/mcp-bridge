import type { AgentConfig, Config } from '../config.js';
import { BrokenAgent } from './broken.js';
import { CliAgent } from './cli.js';
import { OllamaAgent } from './ollama.js';
import { OpenAiAgent } from './openai.js';
import { HealthStore, type AgentState } from './health.js';
import { classifyFailure, onlyAnnounced, selfReportedFailure } from './outcome.js';
import { type Agent, type AgentResult, failed } from './types.js';

export interface AgentStatus {
  name: string;
  description: string;
  requires: string;
  /**
   * Whether the agent can be started — its command resolves, or its endpoint has a key.
   * Not whether its account works: checking that would mean spending a call on every
   * listing, so a signed-out CLI lists as available and explains itself when asked.
   */
  available: boolean;
  /**
   * What to expect from a call, combining the probe with what earlier calls showed:
   * "ready", "unavailable" (not installed or not configured), or a remembered durable
   * failure -- "quota-exhausted", "sign-in-failed", "directory-not-trusted". Anything but
   * "ready" also makes `available` false.
   */
  status: AgentState;
  /** whether pointing it at a directory actually lets it read those files */
  readsFiles: boolean;
  /**
   * Whether, as configured, it may change files and run commands. Both are off unless the
   * owner allowed them for this agent; a task that needs either belongs with an agent
   * that has it, or should ask only for a reading and a report.
   */
  writesFiles: boolean;
  runsCommands: boolean;
  /** the longest one call may run before it is stopped */
  timeoutSeconds: number;
  detail: string;
  /** the most recent failed call, if any, and when; ISO timestamps */
  lastError?: string;
  lastErrorAt?: string;
  /** when the agent said, e.g., "try again at 4:22 AM" */
  retryAt?: string;
  lastSuccessAt?: string;
  calls: number;
}

export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();

  /**
   * The health store is passed in so it can outlive a registry: the control panel rebuilds
   * the registry whenever the config changes, and what was learned must survive that.
   */
  private readonly misconfigured = new Map<string, string>();

  constructor(config: Config, readonly health: HealthStore = new HealthStore()) {
    for (const [name, agentConfig] of Object.entries(config.agents)) {
      const agent = build(name.toLowerCase(), agentConfig, config.maxOutputChars);
      if (agent instanceof BrokenAgent) this.misconfigured.set(agent.name, agent.reason);
      this.agents.set(name.toLowerCase(), tracked(agent, health));
    }
  }

  /** Why an agent's configuration was rejected, or null if it was accepted. */
  configError(name: string): string | null {
    return this.misconfigured.get(name.trim().toLowerCase()) ?? null;
  }

  find(name: string): Agent | undefined {
    return this.agents.get(name.trim().toLowerCase());
  }

  names(): string[] {
    return [...this.agents.keys()].sort();
  }

  /** Probes every agent at once, since each probe is a filesystem or socket check. */
  async statuses(): Promise<AgentStatus[]> {
    const probed = await Promise.all(
      [...this.agents.values()].map(async (agent) => {
        const probe = await agent.probe();
        const status = this.health.state(agent.name, probe.available);
        const health = this.health.get(agent.name);
        const failure = health?.lastFailure;
        const remembered = status !== 'ready' && status !== 'unavailable' && failure
          ? `${STATE_TEXT[status]} on the last call (${new Date(failure.at).toISOString()}): ${failure.message}${failure.retryAt ? ` -- it said to try again ${failure.retryAt}` : ''}`
          : null;
        const result: AgentStatus = {
          name: agent.name,
          description: agent.description,
          requires: agent.requires,
          available: status === 'ready',
          status,
          readsFiles: agent.readsFiles,
          writesFiles: agent.writesFiles,
          runsCommands: agent.runsCommands,
          timeoutSeconds: Math.round(agent.timeoutMs / 1000),
          detail: remembered ?? probe.detail,
          calls: health?.calls ?? 0,
        };
        if (failure) {
          result.lastError = failure.message;
          result.lastErrorAt = new Date(failure.at).toISOString();
          if (failure.retryAt) result.retryAt = failure.retryAt;
        }
        if (health?.lastSuccessAt) result.lastSuccessAt = new Date(health.lastSuccessAt).toISOString();
        return result;
      }),
    );
    return probed.sort((a, b) => a.name.localeCompare(b.name));
  }
}

const STATE_TEXT: Record<AgentState, string> = {
  ready: 'ready',
  unavailable: 'unavailable',
  'quota-exhausted': 'usage limit reached',
  'sign-in-failed': 'sign-in failed',
  'directory-not-trusted': 'refused the working directory',
};

/**
 * Every run goes through here, so whichever front door a call came in by, the result is
 * read the same way: an agent that exited 0 but says it could not do the work is a
 * failure, and every outcome is remembered for list_agents.
 */
function tracked(agent: Agent, health: HealthStore): Agent {
  return {
    get name() { return agent.name; },
    get description() { return agent.description; },
    get requires() { return agent.requires; },
    get readsFiles() { return agent.readsFiles; },
    get writesFiles() { return agent.writesFiles; },
    get runsCommands() { return agent.runsCommands; },
    get timeoutMs() { return agent.timeoutMs; },
    probe: () => agent.probe(),
    run: async (prompt, options) => {
      // a used-up quota or a failed sign-in fails the same way next time: four tasks
      // started together on one exhausted account should cost one failure, not four
      const known = health.get(agent.name)?.lastFailure;
      const state = health.state(agent.name, true);
      if (!options.force && known && state !== 'ready') {
        return failed(agent.name,
          `not started: ${agent.name} hit "${STATE_TEXT[state]}" on a call at ${new Date(known.at).toISOString()} ` +
          `(${known.message})${known.retryAt ? `, and said to try again ${known.retryAt}` : ''}. ` +
          'Choose another agent; this one is tried again once that clears, or when its owner retests it.');
      }
      const result = await agent.run(prompt, options);
      const judged = judge(agent, result);
      health.record(agent.name, judged);
      return judged;
    },
  };
}

function judge(agent: Agent, result: AgentResult): AgentResult {
  const name = agent.name;
  if (result.succeeded) {
    const admitted = selfReportedFailure(result.output);
    if (admitted) {
      return {
        ...result,
        succeeded: false,
        diagnostics:
          `${name} exited normally, but its answer says it could not do the task: "${admitted}" ` +
          'Treat "output" as its explanation, not as a result.',
      };
    }
    if (onlyAnnounced(result.output)) {
      const limited = !agent.writesFiles || !agent.runsCommands;
      return {
        ...result,
        succeeded: false,
        diagnostics:
          `${name} exited normally, but its whole answer only says what it was about to do. ` +
          (limited
            ? 'It probably stopped at a step it was not allowed to take -- it is not allowed to ' +
              `${[!agent.writesFiles ? 'change files' : '', !agent.runsCommands ? 'run commands' : ''].filter(Boolean).join(' or ')} ` +
              'here. Ask it only to read and report, or have its owner allow that step for this agent.'
            : 'Ask again, or give it a smaller task.'),
      };
    }
  }
  if (classifyFailure(result.diagnostics).kind === 'trust') {
    return {
      ...result,
      diagnostics:
        `${result.diagnostics}\n\nThis CLI refuses directories it has not been told to trust when it runs ` +
        'unattended. mcpbridge does not trust them on its behalf, because the directory is chosen by ' +
        'whichever client made the call. If you trust the projects your clients send it to, set the ' +
        'variable the CLI names under this agent\'s "env" in config.json, e.g. ' +
        '"env": { "GEMINI_CLI_TRUST_WORKSPACE": "true" } for gemini.',
    };
  }
  return result;
}

/**
 * A rejected config becomes a BrokenAgent rather than an exception: one typo should cost
 * that agent, not the whole bridge and every other agent with it.
 */
function build(name: string, config: AgentConfig, maxOutputChars: number): Agent {
  try {
    switch (config.type) {
      case 'ollama':
        return new OllamaAgent(name, config, maxOutputChars);
      case 'openai':
        return new OpenAiAgent(name, config, maxOutputChars);
      default:
        return new CliAgent(name, config, maxOutputChars);
    }
  } catch (error) {
    return new BrokenAgent(name, (error as Error).message);
  }
}
