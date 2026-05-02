import { createChatClient, OPENAI_COMPATIBLE_PRESETS, readApiKey } from './chatClientFactory';
import { OllamaClient } from './ollamaClient';
import { OpenAIClient } from './openaiClient';

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
    const client = createChatClient({ backend: 'cerebras', model: 'gpt-oss-120b' });
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
    const client = createChatClient({ backend: 'github', model: 'gpt-4.1' });
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
    const client = createChatClient({ backend: 'GROQ', model: 'gpt-oss-120b' });
    expect(client).toBeInstanceOf(OpenAIClient);
  });
});
