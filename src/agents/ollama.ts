import type { OllamaAgentConfig } from '../config.js';
import { type Agent, type AgentResult, type RunOptions, failed, truncate } from './types.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

interface TagsResponse {
  models?: { name?: string }[];
}

/**
 * A model served locally by Ollama. The only agent that needs neither an account nor a
 * network, so it is the one that is always awake — useful as a fallback when no vendor CLI
 * is installed, and for work that should not leave the machine.
 */
export class OllamaAgent implements Agent {
  readonly requires: string;

  constructor(
    readonly name: string,
    private readonly config: OllamaAgentConfig,
    private readonly maxOutputChars: number,
  ) {
    this.requires = `${this.baseUrl}`;
  }

  private get baseUrl(): string {
    return (this.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  get description(): string {
    const model = this.config.model ? ` (${this.config.model})` : ' (first installed model)';
    return (this.config.description ?? 'A model running locally in Ollama') + model;
  }

  async probe(): Promise<{ available: boolean; detail: string }> {
    const models = await this.installedModels();
    if (models === null) {
      return { available: false, detail: `no Ollama responding at ${this.baseUrl} — start it with "ollama serve"` };
    }
    if (models.length === 0) {
      return { available: false, detail: `Ollama is running but has no models — pull one, e.g. "ollama pull qwen3"` };
    }
    if (this.config.model && !models.includes(this.config.model)) {
      return {
        available: false,
        detail: `model "${this.config.model}" is not installed. Available: ${models.join(', ')}`,
      };
    }
    return { available: true, detail: `Ollama at ${this.baseUrl}, using ${this.config.model ?? models[0]}` };
  }

  async run(prompt: string, _options: RunOptions): Promise<AgentResult> {
    const started = Date.now();
    const timeoutMs = this.config.timeoutMs ?? 300_000;

    let model = this.config.model;
    if (!model) {
      const models = await this.installedModels();
      if (models === null) {
        return failed(this.name, `no Ollama responding at ${this.baseUrl} — start it with "ollama serve"`,
          Date.now() - started);
      }
      if (models.length === 0) {
        return failed(this.name, 'Ollama has no models installed — pull one, e.g. "ollama pull qwen3"',
          Date.now() - started);
      }
      model = models[0]!;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return failed(this.name, `Ollama returned HTTP ${response.status}: ${truncate(await response.text(), 1_000).text}`,
          Date.now() - started);
      }
      const payload = (await response.json()) as { response?: string };
      const body = truncate(payload.response ?? '', this.maxOutputChars);
      return {
        agent: this.name, succeeded: true, output: body.text, diagnostics: '',
        durationMs: Date.now() - started, timedOut: false, outputTruncated: body.truncated,
      };
    } catch (error) {
      const aborted = controller.signal.aborted;
      return failed(this.name,
        aborted
          ? `${this.name} did not answer within ${timeoutMs}ms. Try a smaller task or a smaller model.`
          : `could not reach Ollama at ${this.baseUrl}: ${(error as Error).message}`,
        Date.now() - started, aborted);
    } finally {
      clearTimeout(timer);
    }
  }

  /** null means Ollama is not reachable, as opposed to reachable with nothing installed. */
  private async installedModels(): Promise<string[] | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { signal: controller.signal });
      if (!response.ok) return null;
      const payload = (await response.json()) as TagsResponse;
      return (payload.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n));
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
