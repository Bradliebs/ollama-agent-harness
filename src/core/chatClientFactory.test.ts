import { createChatClient, OPENAI_COMPATIBLE_PRESETS, REPLICATE_PRESET, readApiKey, resolveModelSelection, resolveProviderBaseUrl } from './chatClientFactory';
import { FallbackChatClient } from './fallbackChatClient';
import { OllamaClient } from './ollamaClient';
import { OpenAIClient } from './openaiClient';
import { ReplicateClient } from './replicateClient';

describe('createChatClient', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Wipe and restore so leaked env vars from earlier tests do not poison
    // subsequent presets that share env-var precedence (e.g. github).
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  it('returns an OllamaClient by default', () => {
    delete process.env.HARNESS_BACKEND;
    const client = createChatClient({ model: 'qwen2.5-coder:7b' });
    expect(client).toBeInstanceOf(OllamaClient);
  });

  it('honours HARNESS_BACKEND=ollama explicitly', () => {
    process.env.HARNESS_BACKEND = 'ollama';
    const client = createChatClient({ model: 'qwen2.5-coder:7b' });
    expect(client).toBeInstanceOf(OllamaClient);
  });

  it('returns an OpenAIClient for known presets when an API key is present', () => {
    process.env.CEREBRAS_API_KEY = 'test-key';
    const client = createChatClient({ backend: 'cerebras', model: 'gpt-oss-120b', autoFallback: false });
    expect(client).toBeInstanceOf(OpenAIClient);
    expect(client.getModel()).toBe('gpt-oss-120b');
  });

  it.each(Object.entries(OPENAI_COMPATIBLE_PRESETS))(
    'configures the %s preset with a valid base URL and at least one env-var name',
    (_name, preset) => {
      expect(preset.baseUrl).toMatch(/^https?:\/\//);
      expect(preset.apiKeyEnvVars.length).toBeGreaterThan(0);
      for (const envVar of preset.apiKeyEnvVars) {
        expect(envVar).toMatch(/^[A-Z][A-Z0-9_]+$/);
      }
    },
  );

  it('throws a helpful error when the API key env var is unset', () => {
    delete process.env.CEREBRAS_API_KEY;
    expect(() => createChatClient({ backend: 'cerebras', model: 'gpt-oss-120b' }))
      .toThrow(/CEREBRAS_API_KEY/);
  });

  it('throws when an unknown backend is requested', () => {
    expect(() => createChatClient({ backend: 'totally-fake-backend', model: 'x' }))
      .toThrow(/Unknown HARNESS_BACKEND/);
  });

  it('falls back to GITHUB_TOKEN for the github preset', () => {
    delete process.env.GITHUB_MODELS_TOKEN;
    process.env.GITHUB_TOKEN = 'gh-token';
    const client = createChatClient({ backend: 'github', model: 'gpt-4.1', autoFallback: false });
    expect(client).toBeInstanceOf(OpenAIClient);
  });

  it('prefers GITHUB_MODELS_TOKEN over GITHUB_TOKEN', () => {
    process.env.GITHUB_MODELS_TOKEN = 'preferred';
    process.env.GITHUB_TOKEN = 'fallback';
    const preset = OPENAI_COMPATIBLE_PRESETS.github;
    expect(readApiKey(preset)).toBe('preferred');
  });

  it('reads keys case-insensitively for the backend name', () => {
    process.env.GROQ_API_KEY = 'k';
    const client = createChatClient({ backend: 'GROQ', model: 'gpt-oss-120b', autoFallback: false });
    expect(client).toBeInstanceOf(OpenAIClient);
  });

  it('resolves Cloudflare account-scoped base URLs from env metadata', () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct_123';
    const url = resolveProviderBaseUrl(OPENAI_COMPATIBLE_PRESETS.cloudflare);
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct_123/ai/v1');
  });

  it('throws a helpful Cloudflare error when account metadata is missing', () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    expect(() => resolveProviderBaseUrl(OPENAI_COMPATIBLE_PRESETS.cloudflare)).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });

  it('does NOT create a fallback client by default (opt-in since v0.5.0)', () => {
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.MISTRAL_API_KEY = 'mistral-key';
    delete process.env.HARNESS_REMOTE_AUTO_FALLBACK;
    const client = createChatClient({ backend: 'groq', model: 'llama-3.1-8b-instant' });
    expect(client).toBeInstanceOf(OpenAIClient);
  });

  it('creates a fallback client when HARNESS_REMOTE_AUTO_FALLBACK=1 and multiple backends are configured', () => {
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.MISTRAL_API_KEY = 'mistral-key';
    process.env.HARNESS_REMOTE_AUTO_FALLBACK = '1';
    try {
      const client = createChatClient({ backend: 'groq', model: 'llama-3.1-8b-instant' });
      expect(client).toBeInstanceOf(FallbackChatClient);
    } finally {
      delete process.env.HARNESS_REMOTE_AUTO_FALLBACK;
    }
  });

  it('creates a fallback client when explicitly requested via autoFallback: true', () => {
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.MISTRAL_API_KEY = 'mistral-key';
    const client = createChatClient({ backend: 'groq', model: 'llama-3.1-8b-instant', autoFallback: true });
    expect(client).toBeInstanceOf(FallbackChatClient);
  });

  it('can disable remote provider fallback explicitly', () => {
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.MISTRAL_API_KEY = 'mistral-key';
    const client = createChatClient({ backend: 'groq', model: 'llama-3.1-8b-instant', autoFallback: false });
    expect(client).toBeInstanceOf(OpenAIClient);
  });

  it('returns a ReplicateClient for the replicate backend', () => {
    process.env.REPLICATE_API_TOKEN = 'r8_test';
    const client = createChatClient({ backend: 'replicate', model: 'meta/meta-llama-3-8b-instruct', autoFallback: false });
    expect(client).toBeInstanceOf(ReplicateClient);
    expect(client.getModel()).toBe('meta/meta-llama-3-8b-instruct');
  });

  it('throws when REPLICATE_API_TOKEN is missing', () => {
    delete process.env.REPLICATE_API_TOKEN;
    expect(() => createChatClient({ backend: 'replicate', model: 'meta/meta-llama-3-8b-instruct' }))
      .toThrow(/REPLICATE_API_TOKEN/);
  });

  it('includes replicate in the REPLICATE_PRESET export', () => {
    expect(REPLICATE_PRESET.supportsTools).toBe(false);
    expect(REPLICATE_PRESET.apiKeyEnvVars).toContain('REPLICATE_API_TOKEN');
  });
});

describe('resolveModelSelection', () => {
  it('splits off a known backend prefix and leaves other ids alone', () => {
    expect(resolveModelSelection('groq/llama-3.1-8b-instant')).toEqual({ backend: 'groq', model: 'llama-3.1-8b-instant' });
    expect(resolveModelSelection('local/qwen3', 'ollama')).toEqual({ backend: 'local', model: 'qwen3' });
    expect(resolveModelSelection('replicate/meta/meta-llama-3-8b-instruct')).toEqual({ backend: 'replicate', model: 'meta/meta-llama-3-8b-instruct' });
    expect(resolveModelSelection('qwen3:8b', 'ollama')).toEqual({ backend: 'ollama', model: 'qwen3:8b' });
    expect(resolveModelSelection('hf.co/org/model:Q4', 'ollama')).toEqual({ backend: 'ollama', model: 'hf.co/org/model:Q4' });
  });

  it('keeps a chosen backend own slashed model ids intact', () => {
    expect(resolveModelSelection('openai/gpt-oss-20b', 'groq')).toEqual({ backend: 'groq', model: 'openai/gpt-oss-20b' });
    expect(resolveModelSelection('anthropic/claude-sonnet-4.5', 'openrouter')).toEqual({ backend: 'openrouter', model: 'anthropic/claude-sonnet-4.5' });
    const previous = process.env.HARNESS_BACKEND;
    process.env.HARNESS_BACKEND = 'groq';
    try {
      expect(resolveModelSelection('openai/gpt-oss-20b')).toEqual({ backend: undefined, model: 'openai/gpt-oss-20b' });
    } finally {
      if (previous === undefined) delete process.env.HARNESS_BACKEND;
      else process.env.HARNESS_BACKEND = previous;
    }
  });
});
