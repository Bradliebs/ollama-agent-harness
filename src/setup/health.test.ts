import * as fs from 'fs/promises';
import http from 'http';
import * as path from 'path';
import { checkSetupHealth } from './health';

describe('setup health', () => {
  // checkSetupHealth probes the optional ccmem service via fetch('/health')
  // with a 5s internal abort (REQUEST_TIMEOUT_MS in conceptMemoryClient). When
  // that service is offline, the probe can run right up to 5s, colliding with
  // Jest's 5s default under full-suite parallel load. Give these IO-bound tests
  // headroom above that probe so the suite is deterministic, not load-dependent.
  jest.setTimeout(20_000);

  let fixtureDir: string;

  beforeEach(async () => {
    fixtureDir = path.join(process.cwd(), '.harness', 'test-setup-health');
    await fs.rm(fixtureDir, { recursive: true, force: true });
    await fs.mkdir(fixtureDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it('reports Ollama, vision, and configured audio health', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ models: [{ name: 'llava:latest', size: 1, modified_at: new Date().toISOString(), details: {} }] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to bind fake Ollama server');

    try {
      const result = await checkSetupHealth({
        host: `http://127.0.0.1:${address.port}`,
        visionModel: 'llava',
        audioTranscribeCommand: 'whisper "{input}"',
        projectDir: process.cwd(),
      });

      expect(result).toMatchObject({
        ollama: { ok: true, modelCount: 1 },
        vision: { ok: true },
        audio: { ok: true },
        local: { tools: { ok: true }, automations: { ok: true }, mycelium: { ok: true } },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('auto-detects an installed vision model when none is configured', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b', size: 1, modified_at: new Date().toISOString(), details: {} }, { name: 'llava:latest', size: 1, modified_at: new Date().toISOString(), details: {} }] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to bind fake Ollama server');

    try {
      const result = await checkSetupHealth({
        host: `http://127.0.0.1:${address.port}`,
        visionModel: '',
        audioTranscribeCommand: '',
        projectDir: process.cwd(),
      });

      expect(result.vision).toMatchObject({ ok: true, message: "Auto-detected vision model 'llava:latest'." });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('runs an audio sample through the configured command', async () => {
    const audioPath = path.join(fixtureDir, 'voice.wav');
    const scriptPath = path.join(fixtureDir, 'transcribe.js');
    await fs.writeFile(audioPath, Buffer.from([1, 2, 3]));
    await fs.writeFile(scriptPath, "console.log('sample transcript for ' + process.argv[2].split(/[\\\\/]/).pop())", 'utf-8');

    const result = await checkSetupHealth({
      host: 'http://127.0.0.1:9',
      visionModel: '',
      audioTranscribeCommand: `node "${scriptPath}" "{input}"`,
      audioSamplePath: audioPath,
      projectDir: process.cwd(),
    });

    expect(result.audio).toMatchObject({ ok: true });
    expect(result.audio.message).toContain('sample transcript for voice.wav');
    expect(result.ollama.ok).toBe(false);
  });

  describe('backend auth checks', () => {
    const SAVED_VARS = [
      'CEREBRAS_API_KEY',
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
      'DEEPINFRA_API_KEY',
      'FIREWORKS_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GROQ_API_KEY',
      'GITHUB_TOKEN',
      'GITHUB_MODELS_TOKEN',
      'HF_TOKEN',
      'HUGGINGFACE_API_KEY',
      'MISTRAL_API_KEY',
      'OPENROUTER_API_KEY',
      'OPENAI_API_KEY',
      'REPLICATE_API_TOKEN',
      'SAMBANOVA_API_KEY',
      'TOGETHER_API_KEY',
    ];
    const originalValues: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const v of SAVED_VARS) {
        originalValues[v] = process.env[v];
        delete process.env[v];
      }
    });

    afterEach(() => {
      for (const v of SAVED_VARS) {
        if (originalValues[v] === undefined) delete process.env[v];
        else process.env[v] = originalValues[v];
      }
    });

    async function probe(): Promise<Awaited<ReturnType<typeof checkSetupHealth>>> {
      // Use an obviously bogus host so Ollama check fails fast; backends
      // are populated regardless of Ollama reachability.
      return checkSetupHealth({
        host: 'http://127.0.0.1:1',
        visionModel: '',
        audioTranscribeCommand: '',
        projectDir: process.cwd(),
      });
    }

    it('reports a backend entry per known preset', async () => {
      const result = await probe();
      const ids = result.backends.map((b) => b.id).sort();
      expect(ids).toEqual(expect.arrayContaining([
        'cerebras',
        'cloudflare',
        'deepinfra',
        'fireworks',
        'gemini',
        'groq',
        'github',
        'huggingface',
        'mistral',
        'openrouter',
        'openai',
        'replicate',
        'sambanova',
        'together',
      ]));
    });

    it('marks a backend OK when its env var is set', async () => {
      process.env.CEREBRAS_API_KEY = 'k';
      const result = await probe();
      const cerebras = result.backends.find((b) => b.id === 'cerebras')!;
      expect(cerebras.ok).toBe(true);
      expect(cerebras.apiKeyEnvVar).toBe('CEREBRAS_API_KEY');
    });

    it('marks a backend WARN with signup hint when env vars are unset', async () => {
      const result = await probe();
      const groq = result.backends.find((b) => b.id === 'groq')!;
      expect(groq.ok).toBe(false);
      expect(groq.message).toContain('GROQ_API_KEY');
      expect(groq.signupUrl).toBeDefined();
    });

    it('reports the actual env var name used when multiple are configured', async () => {
      process.env.GITHUB_TOKEN = 't';
      const result = await probe();
      const github = result.backends.find((b) => b.id === 'github')!;
      expect(github.ok).toBe(true);
      expect(github.apiKeyEnvVar).toBe('GITHUB_TOKEN');
    });

    it('counts comma-separated credential pools without exposing the keys', async () => {
      process.env.CEREBRAS_API_KEY = 'k1, k2 , k3';
      const result = await probe();
      const cerebras = result.backends.find((b) => b.id === 'cerebras')!;
      expect(cerebras.ok).toBe(true);
      expect(cerebras.keyCount).toBe(3);
      expect(cerebras.message).toContain('pool of 3 keys');
      expect(cerebras.message).not.toContain('k1');
      expect(cerebras.message).not.toContain('k2');
      expect(cerebras.message).not.toContain('k3');
    });

    it('reports keyCount=1 for a single key (no pool note)', async () => {
      process.env.CEREBRAS_API_KEY = 'just-one-key';
      const result = await probe();
      const cerebras = result.backends.find((b) => b.id === 'cerebras')!;
      expect(cerebras.keyCount).toBe(1);
      expect(cerebras.message).not.toContain('pool of');
      expect(cerebras.message).not.toContain('just-one-key');
    });

    it('reports fallback routing configuration', async () => {
      process.env.CEREBRAS_API_KEY = 'k';
      process.env.GROQ_API_KEY = 'k';
      // Opt-in default since v0.5.0; explicitly enable for this assertion.
      process.env.HARNESS_REMOTE_AUTO_FALLBACK = '1';
      try {
        const result = await probe();
        expect(result.fallback).toBeDefined();
        expect(result.fallback.enabled).toBe(true);
        expect(result.fallback.cooldownMs).toBeGreaterThan(0);
        expect(result.fallback.configuredCount).toBeGreaterThanOrEqual(2);
        expect(result.fallback.order).toBe('default');
      } finally {
        delete process.env.HARNESS_REMOTE_AUTO_FALLBACK;
      }
    });

    it('reports fallback as disabled by default (opt-in since v0.5.0)', async () => {
      process.env.CEREBRAS_API_KEY = 'k';
      process.env.GROQ_API_KEY = 'k';
      delete process.env.HARNESS_REMOTE_AUTO_FALLBACK;
      const result = await probe();
      expect(result.fallback.enabled).toBe(false);
    });

    it('reports custom fallback order from env', async () => {
      process.env.HARNESS_REMOTE_FALLBACK_ORDER = 'groq,mistral';
      const result = await probe();
      expect(result.fallback.order).toBe('groq,mistral');
      delete process.env.HARNESS_REMOTE_FALLBACK_ORDER;
    });
  });

  describe('validation scripts check', () => {
    async function packageCheck(): Promise<Awaited<ReturnType<typeof checkSetupHealth>>['local']['package']> {
      const result = await checkSetupHealth({
        host: 'http://127.0.0.1:1',
        visionModel: '',
        audioTranscribeCommand: '',
        projectDir: fixtureDir,
      });
      return result.local.package;
    }

    it('treats a workspace with no package.json as not applicable (not a failure)', async () => {
      const pkg = await packageCheck();
      expect(pkg.ok).toBe(true);
      expect(pkg.message).toContain('not a Node project');
    });

    it('treats a package.json with no scripts as not applicable', async () => {
      await fs.writeFile(path.join(fixtureDir, 'package.json'), JSON.stringify({ name: 'data-folder' }), 'utf-8');
      const pkg = await packageCheck();
      expect(pkg.ok).toBe(true);
      expect(pkg.message).toContain('no scripts');
    });

    it('warns when a Node project has scripts but lacks test/typecheck', async () => {
      await fs.writeFile(path.join(fixtureDir, 'package.json'), JSON.stringify({ name: 'app', scripts: { build: 'tsc' } }), 'utf-8');
      const pkg = await packageCheck();
      expect(pkg.ok).toBe(false);
      expect(pkg.message).toContain('missing a test');
    });

    it('passes when test and typecheck scripts are present', async () => {
      await fs.writeFile(path.join(fixtureDir, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'jest', typecheck: 'tsc --noEmit' } }), 'utf-8');
      const pkg = await packageCheck();
      expect(pkg.ok).toBe(true);
      expect(pkg.message).toContain('has test and typecheck scripts');
    });

    it('accepts lint as a substitute for typecheck', async () => {
      await fs.writeFile(path.join(fixtureDir, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'jest', lint: 'eslint .' } }), 'utf-8');
      const pkg = await packageCheck();
      expect(pkg.ok).toBe(true);
    });

    it('flags malformed package.json as a real error', async () => {
      await fs.writeFile(path.join(fixtureDir, 'package.json'), '{ not valid json', 'utf-8');
      const pkg = await packageCheck();
      expect(pkg.ok).toBe(false);
      expect(pkg.message).toContain('not valid JSON');
    });
  });
});
