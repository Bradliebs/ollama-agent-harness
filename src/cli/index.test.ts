import { formatSetupHealth, parseArgs } from './index';

describe('cli setup doctor', () => {
  it('parses output validation profile options', () => {
    const options = parseArgs(['--validate-output', 'tool-result-summary']);

    expect(options.outputValidation).toBe('tool-result-summary');
  });

  it('parses doctor options', () => {
    const options = parseArgs([
      'doctor',
      '--host', 'http://127.0.0.1:11434',
      '--vision-model', 'llava',
      '--audio-command', 'whisper "{input}"',
      '--audio-sample', '.harness/uploads/sample.wav',
    ]);

    expect(options).toMatchObject({
      command: 'doctor',
      host: 'http://127.0.0.1:11434',
      visionModel: 'llava',
      audioTranscribeCommand: 'whisper "{input}"',
      audioSamplePath: '.harness/uploads/sample.wav',
    });
  });

  it('formats setup health for terminal output', () => {
    const output = formatSetupHealth({
      ollama: { ok: true, message: 'Connected to Ollama with 2 model(s).', modelCount: 2 },
      vision: { ok: false, message: 'No vision model configured.' },
      audio: { ok: true, message: 'Audio transcription command is configured.' },
      local: {
        node: { ok: true, message: 'Node 20.0.0' },
        package: { ok: true, message: 'package has scripts.' },
        sessions: { ok: true, message: 'Session storage is writable.' },
        tools: { ok: true, message: '27 built-in tool(s).' },
        automations: { ok: true, message: 'Automation storage is writable.' },
        mycelium: { ok: true, message: 'Mycelium graph is empty.' },
      },
      backends: [],
    });

    expect(output).toContain('Setup doctor');
    expect(output).toContain('OK Ollama: Connected to Ollama with 2 model(s).');
    expect(output).toContain('WARN Vision: No vision model configured.');
    expect(output).toContain('OK Audio: Audio transcription command is configured.');
    expect(output).toContain('OK Automations: Automation storage is writable.');
  });

  it('renders the Backends section when at least one preset is reported', () => {
    const output = formatSetupHealth({
      ollama: { ok: true, message: 'ok', modelCount: 1 },
      vision: { ok: false, message: 'no' },
      audio: { ok: true, message: 'ok' },
      local: {
        node: { ok: true, message: 'ok' },
        package: { ok: true, message: 'ok' },
        sessions: { ok: true, message: 'ok' },
        tools: { ok: true, message: 'ok' },
        automations: { ok: true, message: 'ok' },
        mycelium: { ok: true, message: 'ok' },
      },
      backends: [
        { id: 'cerebras', label: 'Cerebras', ok: true, message: 'API key configured (via CEREBRAS_API_KEY).' },
        { id: 'github', label: 'GitHub Models', ok: false, message: 'No API key. Set GITHUB_MODELS_TOKEN or GITHUB_TOKEN.' },
      ],
    });

    expect(output).toContain('Backends (OpenAI-compatible):');
    expect(output).toContain('OK Cerebras: API key configured');
    expect(output).toContain('WARN GitHub Models: No API key.');
  });

  it('renders multi-key credential pools without leaking the keys themselves', () => {
    // The credential pool feature lets users set CEREBRAS_API_KEY="k1,k2,k3"
    // for round-robin on 429s. The doctor must report the COUNT but never
    // the values — leaking keys via doctor output would be a credential
    // exposure incident.
    const sensitiveKeys = ['ck-secret-1', 'ck-secret-2', 'ck-secret-3'];
    const output = formatSetupHealth({
      ollama: { ok: true, message: 'ok', modelCount: 1 },
      vision: { ok: false, message: 'no' },
      audio: { ok: true, message: 'ok' },
      local: {
        node: { ok: true, message: 'ok' },
        package: { ok: true, message: 'ok' },
        sessions: { ok: true, message: 'ok' },
        tools: { ok: true, message: 'ok' },
        automations: { ok: true, message: 'ok' },
        mycelium: { ok: true, message: 'ok' },
      },
      backends: [
        {
          id: 'cerebras',
          label: 'Cerebras',
          ok: true,
          message: 'API key configured (via CEREBRAS_API_KEY) (pool of 3 keys).',
          apiKeyEnvVar: 'CEREBRAS_API_KEY',
          keyCount: 3,
        },
      ],
    });

    expect(output).toContain('CEREBRAS_API_KEY');
    expect(output).toContain('pool of 3 keys');
    for (const key of sensitiveKeys) {
      expect(output).not.toContain(key);
    }
  });
});
