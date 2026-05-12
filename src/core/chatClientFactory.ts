import { OllamaClient } from './ollamaClient';
import { OpenAIClient } from './openaiClient';
import { FallbackChatClient } from './fallbackChatClient';
import { ReplicateClient } from './replicateClient';
import type { IChatClient } from './chatClient';

/**
 * Provider preset table for OpenAI Chat Completions-compatible backends.
 * Lookup is case-insensitive on the prefix before any `/`. Entries here
 * carry only public information — base URLs and which env var to read for
 * the API key. No secrets are baked in.
 */
export interface ProviderPreset {
  /** Display name used in errors/doctor output. */
  label: string;
  /** OpenAI-compatible base URL (without trailing slash). */
  baseUrl: string;
  /** Default model used when this backend is selected as a fallback. */
  defaultModel: string;
  /** Env vars checked in order for the API key. */
  apiKeyEnvVars: string[];
  /** Whether this provider/model path can participate in agent tool loops. */
  supportsTools?: boolean;
  /** Optional homepage for "where do I get a key?" hints. */
  signupUrl?: string;
}

export const OPENAI_COMPATIBLE_PRESETS: Record<string, ProviderPreset> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    apiKeyEnvVars: ['OPENAI_API_KEY'],
    supportsTools: true,
    signupUrl: 'https://platform.openai.com/api-keys',
  },
  cerebras: {
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'llama3.1-8b',
    apiKeyEnvVars: ['CEREBRAS_API_KEY'],
    supportsTools: false,
    signupUrl: 'https://cloud.cerebras.ai/',
  },
  cloudflare: {
    label: 'Cloudflare Workers AI',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1',
    defaultModel: '@cf/meta/llama-3.1-8b-instruct',
    apiKeyEnvVars: ['CLOUDFLARE_API_TOKEN'],
    supportsTools: false,
    signupUrl: 'https://dash.cloudflare.com/',
  },
  deepinfra: {
    label: 'DeepInfra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    apiKeyEnvVars: ['DEEPINFRA_API_KEY'],
    supportsTools: false,
    signupUrl: 'https://deepinfra.com/dash/api_keys',
  },
  fireworks: {
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
    apiKeyEnvVars: ['FIREWORKS_API_KEY'],
    supportsTools: true,
    signupUrl: 'https://fireworks.ai/account/api-keys',
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.0-flash-lite',
    apiKeyEnvVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    supportsTools: true,
    signupUrl: 'https://aistudio.google.com/app/apikey',
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.1-8b-instant',
    apiKeyEnvVars: ['GROQ_API_KEY'],
    supportsTools: true,
    signupUrl: 'https://console.groq.com/keys',
  },
  github: {
    label: 'GitHub Models',
    baseUrl: 'https://models.inference.ai.azure.com',
    defaultModel: 'gpt-4o-mini',
    apiKeyEnvVars: ['GITHUB_MODELS_TOKEN', 'GITHUB_TOKEN'],
    supportsTools: true,
    signupUrl: 'https://github.com/marketplace/models',
  },
  mistral: {
    label: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    apiKeyEnvVars: ['MISTRAL_API_KEY'],
    supportsTools: true,
    signupUrl: 'https://console.mistral.ai/api-keys',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    apiKeyEnvVars: ['OPENROUTER_API_KEY'],
    supportsTools: true,
    signupUrl: 'https://openrouter.ai/keys',
  },
  huggingface: {
    label: 'Hugging Face Inference Providers',
    baseUrl: 'https://router.huggingface.co/v1',
    defaultModel: 'meta-llama/Llama-3.1-8B-Instruct',
    apiKeyEnvVars: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'],
    supportsTools: false,
    signupUrl: 'https://huggingface.co/settings/tokens',
  },
  sambanova: {
    label: 'SambaNova Cloud',
    baseUrl: 'https://api.sambanova.ai/v1',
    defaultModel: 'Meta-Llama-3.1-8B-Instruct',
    apiKeyEnvVars: ['SAMBANOVA_API_KEY'],
    supportsTools: true,
    signupUrl: 'https://cloud.sambanova.ai/apis',
  },
  together: {
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    apiKeyEnvVars: ['TOGETHER_API_KEY'],
    supportsTools: true,
    signupUrl: 'https://api.together.ai/settings/api-keys',
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-20250514',
    apiKeyEnvVars: ['ANTHROPIC_API_KEY'],
    supportsTools: true,
    signupUrl: 'https://console.anthropic.com/settings/keys',
  },
};

export const REPLICATE_PRESET: ProviderPreset = {
  label: 'Replicate',
  baseUrl: 'https://api.replicate.com/v1',
  defaultModel: 'meta/meta-llama-3-8b-instruct',
  apiKeyEnvVars: ['REPLICATE_API_TOKEN'],
  supportsTools: false,
  signupUrl: 'https://replicate.com/account/api-tokens',
};

export interface CreateClientConfig {
  /** Backend identifier. `ollama` (default), `replicate`, or one of OPENAI_COMPATIBLE_PRESETS. */
  backend?: string;
  /** Model identifier passed to the backend. */
  model: string;
  /** Optional override for the Ollama host (ignored by OpenAI backends). */
  host?: string;
  /** Optional context-window override (used by OpenAI backends as a hint). */
  numCtx?: number;
  /** Cycle to other configured remote providers when the selected provider hits rate/quota/request limits. */
  autoFallback?: boolean;
}

/**
 * Construct the appropriate chat client based on `backend`.
 *
 * Backend resolution order:
 *   1. Explicit `config.backend` argument.
 *   2. `HARNESS_BACKEND` environment variable.
 *   3. `ollama` (default — preserves prior behaviour).
 *
 * For OpenAI-compatible backends, the API key is read from the first env
 * var listed in the preset that has a non-empty value.
 */
export function createChatClient(config: CreateClientConfig): IChatClient {
  const backend = (config.backend ?? process.env.HARNESS_BACKEND ?? 'ollama').toLowerCase();
  if (backend === 'ollama') {
    return new OllamaClient({ model: config.model, host: config.host, numCtx: config.numCtx });
  }
  if (backend === 'replicate') {
    const primary = createReplicateClient(config.model);
    const autoFallback = config.autoFallback ?? process.env.HARNESS_REMOTE_AUTO_FALLBACK !== '0';
    if (!autoFallback) return primary;
    const fallbackEntries = buildFallbackEntries(backend, config.model, config.numCtx);
    return fallbackEntries.length > 1 ? new FallbackChatClient(fallbackEntries) : primary;
  }
  const preset = OPENAI_COMPATIBLE_PRESETS[backend];
  if (!preset) {
    const known = ['ollama', ...Object.keys(OPENAI_COMPATIBLE_PRESETS), 'replicate'].join(', ');
    throw new Error(`Unknown HARNESS_BACKEND="${backend}". Known backends: ${known}.`);
  }
  const apiKey = readApiKey(preset);
  if (!apiKey) {
    const envVarList = preset.apiKeyEnvVars.join(' or ');
    const signup = preset.signupUrl ? ` Get a key at ${preset.signupUrl}.` : '';
    throw new Error(`${preset.label} backend selected but no API key found. Set ${envVarList}.${signup}`);
  }
  const primary = createOpenAIClient(preset, config.model, apiKey, config.numCtx);
  const autoFallback = config.autoFallback ?? process.env.HARNESS_REMOTE_AUTO_FALLBACK !== '0';
  if (!autoFallback) return primary;
  const fallbackEntries = buildFallbackEntries(backend, config.model, config.numCtx);
  return fallbackEntries.length > 1 ? new FallbackChatClient(fallbackEntries) : primary;
}

/** First non-empty value among the preset's listed env var names, or undefined. */
export function readApiKey(preset: ProviderPreset): string | undefined {
  for (const name of preset.apiKeyEnvVars) {
    const value = process.env[name];
    if (value && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export function resolveProviderBaseUrl(preset: ProviderPreset): string {
  return preset.baseUrl.replace(/\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${preset.label} backend selected but ${name} is not set.`);
    return encodeURIComponent(value);
  });
}

function createOpenAIClient(
  preset: ProviderPreset,
  model: string,
  apiKey: string,
  numCtx?: number,
): OpenAIClient {
  const apiKeys = apiKey.split(',').map((k) => k.trim()).filter(Boolean);
  return new OpenAIClient({
    baseUrl: resolveProviderBaseUrl(preset),
    apiKey: apiKeys.length > 1 ? apiKeys : apiKeys[0],
    model,
    contextWindow: numCtx,
    providerLabel: preset.label,
  });
}

function buildFallbackEntries(primaryBackend: string, primaryModel: string, numCtx?: number): Array<{ backend: string; client: IChatClient; supportsTools: boolean }> {
  const order = resolveFallbackOrder(primaryBackend);
  const entries: Array<{ backend: string; client: IChatClient; supportsTools: boolean }> = [];
  for (const backend of order) {
    if (backend === 'replicate') {
      const apiKey = readApiKey(REPLICATE_PRESET);
      if (!apiKey) continue;
      const model = backend === primaryBackend ? primaryModel : REPLICATE_PRESET.defaultModel;
      entries.push({
        backend,
        client: new ReplicateClient({ apiKey, model, baseUrl: REPLICATE_PRESET.baseUrl }),
        supportsTools: false,
      });
      continue;
    }
    const preset = OPENAI_COMPATIBLE_PRESETS[backend];
    if (!preset) continue;
    const apiKey = readApiKey(preset);
    if (!apiKey) continue;
    try {
      const model = backend === primaryBackend ? primaryModel : preset.defaultModel;
      entries.push({
        backend,
        client: createOpenAIClient(preset, model, apiKey, numCtx),
        supportsTools: preset.supportsTools !== false,
      });
    } catch {
      // Account-scoped providers such as Cloudflare can have a key but miss
      // required account metadata. Skip them during fallback construction.
    }
  }
  return entries;
}

function resolveFallbackOrder(primaryBackend: string): string[] {
  const configured = (process.env.HARNESS_REMOTE_FALLBACK_ORDER || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const base = configured.length > 0 ? configured : [...Object.keys(OPENAI_COMPATIBLE_PRESETS), 'replicate'];
  return [primaryBackend, ...base.filter((backend) => backend !== primaryBackend)];
}

function createReplicateClient(model: string): ReplicateClient {
  const apiKey = readApiKey(REPLICATE_PRESET);
  if (!apiKey) {
    throw new Error(`${REPLICATE_PRESET.label} backend selected but no API key found. Set ${REPLICATE_PRESET.apiKeyEnvVars.join(' or ')}. Get a key at ${REPLICATE_PRESET.signupUrl}.`);
  }
  return new ReplicateClient({ apiKey, model, baseUrl: REPLICATE_PRESET.baseUrl });
}
