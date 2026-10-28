/**
 * Starting points for the "add an agent" form. Each fills in what is fixed for that
 * provider -- the endpoint, the variable the key lives in, where to get a key -- and leaves
 * the model to the person, who can list what their key can reach with one click.
 */
export interface Preset {
  id: string;
  label: string;
  kind: 'openai' | 'cli' | 'ollama';
  name: string;
  description: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  /** where a key comes from, shown as a link next to the key field */
  keyUrl?: string;
  /** a model id to start from; the endpoint's own listing is the authority */
  model?: string;
  command?: string[];
  promptVia?: 'argv' | 'stdin';
  note?: string;
}

export const PRESETS: Preset[] = [
  {
    id: 'nvidia', label: 'NVIDIA (build.nvidia.com, free tier)', kind: 'openai', name: 'nvidia',
    description: 'Open models hosted by NVIDIA',
    baseUrl: 'https://integrate.api.nvidia.com/v1', apiKeyEnv: 'NVIDIA_API_KEY',
    keyUrl: 'https://build.nvidia.com', model: 'meta/llama-3.3-70b-instruct',
    note: 'Sign in at build.nvidia.com, open any model, and use "Get API Key"; the key starts with nvapi-. Free with an NVIDIA Developer account, rate-limited.',
  },
  {
    id: 'deepseek', label: 'DeepSeek', kind: 'openai', name: 'deepseek',
    description: 'DeepSeek via its API',
    baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: 'Prepaid: top up the balance on the platform, or calls fail with "Insufficient Balance".',
  },
  {
    id: 'grok-cli', label: 'Grok (Grok Build CLI, your grok.com sign-in)', kind: 'cli', name: 'grok',
    description: 'Grok via the official Grok Build CLI',
    command: ['grok', '-p', '{prompt}', '--no-auto-update'],
    note: 'Install with: irm https://x.ai/cli/install.ps1 | iex, then run grok login once. Grok Build needs usage balance on the account.',
  },
  {
    id: 'xai', label: 'Grok (xAI API key)', kind: 'openai', name: 'grok-api',
    description: 'Grok via the xAI API',
    baseUrl: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY', keyUrl: 'https://console.x.ai',
  },
  {
    id: 'openrouter', label: 'OpenRouter (one key, many providers)', kind: 'openai', name: 'openrouter',
    description: 'Many providers through OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'groq', label: 'Groq', kind: 'openai', name: 'groq',
    description: 'Fast open models on Groq',
    baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', keyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'mistral', label: 'Mistral', kind: 'openai', name: 'mistral',
    description: 'Mistral models via its API',
    baseUrl: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY', keyUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'ollama', label: 'Ollama (local, no key)', kind: 'ollama', name: 'local',
    description: 'A model running locally in Ollama',
    note: 'Leave the model empty to use the first one Ollama has installed.',
  },
  {
    id: 'custom-openai', label: 'Any OpenAI-compatible API', kind: 'openai', name: '',
    description: 'A model over an OpenAI-compatible API', baseUrl: '', apiKeyEnv: '',
  },
  {
    id: 'custom-cli', label: 'Any command-line agent', kind: 'cli', name: '',
    description: 'A command-line agent', command: [],
    note: 'Put {prompt} where the prompt goes, or choose "stdin" for CLIs that read it from a pipe.',
  },
];
