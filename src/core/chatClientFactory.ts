import { OllamaClient } from './ollamaClient';
import { OpenAIClient } from './openaiClient';
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
  /** Env vars checked in order for the API key. */
  apiKeyEnvVars: string[];
  /** Optional homepage for "where do I get a key?" hints. */
  signupUrl?: string;
}

export const OPENAI_COMPATIBLE_PRESETS: Record<string, ProviderPreset> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnvVars: ['OPENAI_API_KEY'],
    signupUrl: 'https://platform.openai.com/api-keys',
  },
  cerebras: {
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnvVars: ['CEREBRAS_API_KEY'],
    signupUrl: 'https://cloud.cerebras.ai/',
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnvVars: ['GROQ_API_KEY'],
    signupUrl: 'https://console.groq.com/keys',
  },
  github: {
    label: 'GitHub Models',
    baseUrl: 'https://models.inference.ai.azure.com',
    apiKeyEnvVars: ['GITHUB_MODELS_TOKEN', 'GITHUB_TOKEN'],
    signupUrl: 'https://github.com/marketplace/models',
  },
  mistral: {
    label: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnvVars: ['MISTRAL_API_KEY'],
    signupUrl: 'https://console.mistral.ai/api-keys',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvVars: ['OPENROUTER_API_KEY'],
    signupUrl: 'https://openrouter.ai/keys',
  },
};

export interface CreateClientConfig {
  /** Backend identifier. `ollama` (default) or one of OPENAI_COMPATIBLE_PRESETS. */
  backend?: string;
  /** Model identifier passed to the backend. */
  model: string;
  /** Optional override for the Ollama host (ignored by OpenAI backends). */
  host?: string;
  /** Optional context-window override (used by OpenAI backends as a hint). */
  numCtx?: number;
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
  const preset = OPENAI_COMPATIBLE_PRESETS[backend];
  if (!preset) {
    const known = ['ollama', ...Object.keys(OPENAI_COMPATIBLE_PRESETS)].join(', ');
    throw new Error(`Unknown HARNESS_BACKEND="${backend}". Known backends: ${known}.`);
  }
  const apiKey = readApiKey(preset);
  if (!apiKey) {
    const envVarList = preset.apiKeyEnvVars.join(' or ');
    const signup = preset.signupUrl ? ` Get a key at ${preset.signupUrl}.` : '';
    throw new Error(`${preset.label} backend selected but no API key found. Set ${envVarList}.${signup}`);
  }
  return new OpenAIClient({
    baseUrl: preset.baseUrl,
    apiKey,
    model: config.model,
    contextWindow: config.numCtx,
    providerLabel: preset.label,
  });
}

/** First non-empty value among the preset's listed env var names, or undefined. */
export function readApiKey(preset: ProviderPreset): string | undefined {
  for (const name of preset.apiKeyEnvVars) {
    const value = process.env[name];
    if (value && value.trim().length > 0) return value.trim();
  }
  return undefined;
}
