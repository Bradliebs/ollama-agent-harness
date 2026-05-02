import * as fs from 'fs/promises';
import http from 'http';
import * as path from 'path';
import { checkSetupHealth } from './health';

describe('setup health', () => {
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
    const SAVED_VARS = ['CEREBRAS_API_KEY', 'GROQ_API_KEY', 'GITHUB_TOKEN', 'GITHUB_MODELS_TOKEN', 'MISTRAL_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'];
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
      expect(ids).toEqual(expect.arrayContaining(['cerebras', 'groq', 'github', 'mistral', 'openrouter', 'openai']));
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
  });
});
