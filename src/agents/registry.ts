import type { AgentConfig, Config } from '../config.js';
import { BrokenAgent } from './broken.js';
import { CliAgent } from './cli.js';
import { OllamaAgent } from './ollama.js';
import { OpenAiAgent } from './openai.js';
import type { Agent } from './types.js';

export interface AgentStatus {
  name: string;
  description: string;
  requires: string;
  available: boolean;
  /** whether pointing it at a directory actually lets it read those files */
  readsFiles: boolean;
  detail: string;
}

export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();

  constructor(config: Config) {
    for (const [name, agentConfig] of Object.entries(config.agents)) {
      this.agents.set(name.toLowerCase(), build(name.toLowerCase(), agentConfig, config.maxOutputChars));
    }
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
        const { available, detail } = await agent.probe();
        return {
          name: agent.name,
          description: agent.description,
          requires: agent.requires,
          available,
          readsFiles: agent.readsFiles,
          detail,
        };
      }),
    );
    return probed.sort((a, b) => a.name.localeCompare(b.name));
  }
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
