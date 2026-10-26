import type { OpenAiAgentConfig } from '../config.js';
import { type Agent, type AgentResult, type RunOptions, failed, truncate } from './types.js';

interface ChatCompletion {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

/**
 * An agent reached over an OpenAI-compatible chat-completions API.
 *
 * <p>This is the only door some providers leave open — xAI publishes no CLI, so Grok is
 * reachable this way or not at all. One adapter serves all of them because the request
 * shape is the same; only the base URL, model and key change.
 *
 * <p>The key is never put in a result, a note or a log: errors quote the provider's
 * message, never the request.
 */
export class OpenAiAgent implements Agent {
  readonly requires: string;
  // an HTTP model sees only what the prompt carries
  readonly readsFiles = false;

  constructor(
    readonly name: string,
    private readonly config: OpenAiAgentConfig,
    private readonly maxOutputChars: number,
  ) {
    if (!config.baseUrl) throw new Error(`agent "${name}": baseUrl is required`);
    this.requires = this.endpoint;
  }

  private get endpoint(): string {
    return `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  }

  get description(): string {
    const model = this.config.model ?? 'no model set';
    return `${this.config.description ?? 'A model over an OpenAI-compatible API'} (${model})`;
  }

  /** Resolved at call time, so a key exported after startup is picked up. */
  private key(): string | undefined {
    if (this.config.apiKeyEnv) return process.env[this.config.apiKeyEnv] || undefined;
    return this.config.apiKey || undefined;
  }

  private missingKeyDetail(): string {
    return this.config.apiKeyEnv
      ? `no API key: set the ${this.config.apiKeyEnv} environment variable`
      : `no API key: add "apiKeyEnv" naming an environment variable that holds one`;
  }

  async probe(): Promise<{ available: boolean; detail: string }> {
    if (!this.key()) {
      return { available: false, detail: this.missingKeyDetail() };
    }
    // a key alone does not prove the endpoint answers, and /models is optional on some
    // providers, so a refusal there is not treated as a failure
    const models = await this.listModels();

    if (!this.config.model) {
      return {
        available: false,
        detail: models?.length
          ? `no model set. This endpoint offers: ${models.slice(0, 10).join(', ')}`
          : 'no model set — add "model" with an id from the provider\'s documentation',
      };
    }
    if (models === null) {
      return { available: true, detail: `key set for ${this.config.model}; endpoint not verified` };
    }
    if (models.length > 0 && !models.includes(this.config.model)) {
      return {
        available: false,
        detail: `the endpoint does not list "${this.config.model}". Available: ${models.slice(0, 8).join(', ')}`,
      };
    }
    return { available: true, detail: `${this.config.model} available at ${this.config.baseUrl}` };
  }

  async run(prompt: string, options: RunOptions): Promise<AgentResult> {
    const started = Date.now();
    const key = this.key();
    if (!key) return failed(this.name, this.missingKeyDetail(), Date.now() - started);
    if (!this.config.model) {
      return failed(this.name,
        `no model set for "${this.name}". Add "model" to its config; run \`mcpbridge --agents\` to ` +
        `see what this endpoint offers.`, Date.now() - started);
    }

    const note = options.cwd
      ? `workingDirectory (${options.cwd}) was ignored: ${this.name} is a model behind an HTTP ` +
        `API and cannot read files. Inline what it should see in the prompt, or delegate to an ` +
        `agent that list_agents reports with "readsFiles": true.`
      : '';

    const timeoutMs = this.config.timeoutMs ?? 300_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          ...(this.config.headers ?? {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          ...(this.config.maxOutputTokens ? { max_tokens: this.config.maxOutputTokens } : {}),
        }),
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => ({}))) as ChatCompletion;
      if (!response.ok) {
        const reason = payload.error?.message ?? `HTTP ${response.status}`;
        return failed(this.name,
          response.status === 401 || response.status === 403
            ? `the API key was rejected (${reason}). Check ${this.config.apiKeyEnv ?? 'the configured key'}.`
            : `${this.name} returned ${response.status}: ${truncate(reason, 500).text}`,
          Date.now() - started);
      }

      const body = truncate(payload.choices?.[0]?.message?.content ?? '', this.maxOutputChars);
      const usage = payload.usage;
      // these calls cost money, so what they spent is worth telling the caller
      const spend = usage?.total_tokens
        ? `used ${usage.total_tokens} tokens (${usage.prompt_tokens ?? '?'} in, ${usage.completion_tokens ?? '?'} out).`
        : '';
      const cut = payload.choices?.[0]?.finish_reason === 'length'
        ? 'The model stopped at its output limit, so the answer may be incomplete; raise maxOutputTokens.'
        : '';

      return {
        agent: this.name,
        succeeded: true,
        output: body.text,
        diagnostics: '',
        notes: [note, spend, cut].filter(Boolean).join(' '),
        durationMs: Date.now() - started,
        timedOut: false,
        outputTruncated: body.truncated,
      };
    } catch (error) {
      const aborted = controller.signal.aborted;
      return failed(this.name,
        aborted
          ? `${this.name} did not answer within ${timeoutMs}ms. Try a smaller task.`
          : `could not reach ${this.config.baseUrl}: ${(error as Error).message}`,
        Date.now() - started, aborted);
    } finally {
      clearTimeout(timer);
    }
  }

  /** null means the endpoint does not offer a usable /models listing. */
  private async listModels(): Promise<string[] | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${this.key() ?? ''}`, ...(this.config.headers ?? {}) },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { data?: { id?: string }[] };
      return (payload.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
