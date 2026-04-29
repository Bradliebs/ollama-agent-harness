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
      });

      expect(result).toMatchObject({
        ollama: { ok: true, modelCount: 1 },
        vision: { ok: true },
        audio: { ok: true },
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
    });

    expect(result.audio).toMatchObject({ ok: true });
    expect(result.audio.message).toContain('sample transcript for voice.wav');
    expect(result.ollama.ok).toBe(false);
  });
});
