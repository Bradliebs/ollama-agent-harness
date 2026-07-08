import * as fs from 'fs/promises';
import * as path from 'path';
import { AudioTranscribeTool, ImageAnalyzeTool, resolveDefaultAudioCommand } from './multimodalTools';

const mockChat = jest.fn();
const mockList = jest.fn();

jest.mock('ollama', () => ({
  Ollama: jest.fn().mockImplementation(() => ({ chat: mockChat, list: mockList })),
}));

describe('multimodal tools', () => {
  let fixtureDir: string;
  const originalVisionModel = process.env.HARNESS_VISION_MODEL;
  const originalAudioCommand = process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND;
  const originalOllamaModel = process.env.OLLAMA_MODEL;
  const originalWhisperBin = process.env.HARNESS_WHISPER_BIN;

  beforeEach(async () => {
    fixtureDir = path.join(process.cwd(), '.harness', 'test-multimodal');
    await fs.rm(fixtureDir, { recursive: true, force: true });
    await fs.mkdir(fixtureDir, { recursive: true });
    mockChat.mockReset();
    mockList.mockReset();
    delete process.env.HARNESS_VISION_MODEL;
    delete process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND;
    delete process.env.OLLAMA_MODEL;
    delete process.env.HARNESS_WHISPER_BIN;
  });

  afterEach(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
    if (originalVisionModel === undefined) delete process.env.HARNESS_VISION_MODEL;
    else process.env.HARNESS_VISION_MODEL = originalVisionModel;
    if (originalAudioCommand === undefined) delete process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND;
    else process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND = originalAudioCommand;
    if (originalOllamaModel === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = originalOllamaModel;
    if (originalWhisperBin === undefined) delete process.env.HARNESS_WHISPER_BIN;
    else process.env.HARNESS_WHISPER_BIN = originalWhisperBin;
  });

  it('passes local image bytes to an Ollama vision model', async () => {
    const imagePath = path.join(fixtureDir, 'sample.png');
    await fs.writeFile(imagePath, Buffer.from([1, 2, 3, 4]));
    mockChat.mockResolvedValue({ message: { content: 'A small test image.' } });

    const result = await ImageAnalyzeTool.execute({ path: imagePath, model: 'llava', prompt: 'Describe it.' });

    expect(result).toMatchObject({ success: true, output: 'A small test image.' });
    expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({
      model: 'llava',
      messages: [expect.objectContaining({ content: 'Describe it.', images: [Buffer.from([1, 2, 3, 4]).toString('base64')] })],
    }));
  });

  it('requires a vision model for image analysis', async () => {
    const imagePath = path.join(fixtureDir, 'sample.png');
    await fs.writeFile(imagePath, Buffer.from([1]));
    mockList.mockResolvedValue({ models: [{ name: 'qwen2.5-coder:7b' }] });

    const result = await ImageAnalyzeTool.execute({ path: imagePath });

    expect(result).toMatchObject({ success: false, error: 'missing vision model' });
  });

  it('auto-detects an installed Ollama vision model when none is configured', async () => {
    const imagePath = path.join(fixtureDir, 'sample.png');
    await fs.writeFile(imagePath, Buffer.from([5, 6, 7]));
    mockList.mockResolvedValue({ models: [{ name: 'qwen2.5-coder:7b' }, { name: 'llava:latest' }] });
    mockChat.mockResolvedValue({ message: { content: 'A car listing screenshot.' } });

    const result = await ImageAnalyzeTool.execute({ path: imagePath, prompt: 'Read the listing.' });

    expect(result).toMatchObject({ success: true, output: 'A car listing screenshot.' });
    expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({ model: 'llava:latest' }));
  });

  it('auto-detects Minimax M3 as an installed vision model', async () => {
    const imagePath = path.join(fixtureDir, 'sample.png');
    await fs.writeFile(imagePath, Buffer.from([8, 9, 10]));
    mockList.mockResolvedValue({ models: [{ name: 'qwen2.5-coder:7b' }, { name: 'minimax-m3:cloud' }] });
    mockChat.mockResolvedValue({ message: { content: 'A license document photo.' } });

    const result = await ImageAnalyzeTool.execute({ path: imagePath, prompt: 'Read this.' });

    expect(result).toMatchObject({ success: true, output: 'A license document photo.' });
    expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({ model: 'minimax-m3:cloud' }));
  });

  it('uses a configured cloud vision model even when ollama list omits it', async () => {
    // Real user scenario: minimax-m3:cloud is a cloud model that never shows
    // up in the local `ollama list`, yet is set as HARNESS_VISION_MODEL. The
    // old local-install gate rejected it with "missing vision model".
    const imagePath = path.join(fixtureDir, 'sample.png');
    await fs.writeFile(imagePath, Buffer.from([11, 12]));
    process.env.HARNESS_VISION_MODEL = 'minimax-m3:cloud';
    mockList.mockResolvedValue({ models: [{ name: 'glm-5.2:cloud' }, { name: 'qwen2.5-coder:7b' }] });
    mockChat.mockResolvedValue({ message: { content: 'A dragonfly photo.' } });

    const result = await ImageAnalyzeTool.execute({ path: imagePath, prompt: 'What is this?' });

    expect(result).toMatchObject({ success: true, output: 'A dragonfly photo.' });
    expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({ model: 'minimax-m3:cloud' }));
  });

  it('uses the selected chat model for vision when it is a cloud vision model', async () => {
    // Zero-config path: the user picks minimax-m3:cloud as their main model.
    // Even though it is absent from the local list, it should handle images.
    const imagePath = path.join(fixtureDir, 'sample.png');
    await fs.writeFile(imagePath, Buffer.from([13, 14]));
    process.env.OLLAMA_MODEL = 'minimax-m3:cloud';
    mockList.mockResolvedValue({ models: [{ name: 'qwen2.5-coder:7b' }] });
    mockChat.mockResolvedValue({ message: { content: 'Some UI screenshot.' } });

    const result = await ImageAnalyzeTool.execute({ path: imagePath, prompt: 'Describe.' });

    expect(result).toMatchObject({ success: true, output: 'Some UI screenshot.' });
    expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({ model: 'minimax-m3:cloud' }));
  });

  it('does not use a text-only cloud chat model for vision', async () => {
    // glm-5.2:cloud is text-only; it must not be sent an image. With no other
    // vision model available, the tool reports the missing-model error.
    const imagePath = path.join(fixtureDir, 'sample.png');
    await fs.writeFile(imagePath, Buffer.from([15]));
    process.env.OLLAMA_MODEL = 'glm-5.2:cloud';
    mockList.mockResolvedValue({ models: [{ name: 'glm-5.2:cloud' }, { name: 'qwen2.5-coder:7b' }] });

    const result = await ImageAnalyzeTool.execute({ path: imagePath, prompt: 'Describe.' });

    expect(result).toMatchObject({ success: false, error: 'missing vision model' });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('reports a clear audio transcription setup error when no command is configured', async () => {
    const audioPath = path.join(fixtureDir, 'voice.wav');
    await fs.writeFile(audioPath, Buffer.from([1, 2, 3]));
    // Force PATH to a directory without a whisper binary so auto-detect
    // deterministically falls through to the setup guidance, regardless of
    // whether the host machine running the tests has whisper installed.
    const prevPath = process.env.PATH;
    process.env.PATH = fixtureDir;
    try {
      const result = await AudioTranscribeTool.execute({ path: audioPath });
      expect(result).toMatchObject({ success: false, error: 'missing transcription command' });
      expect(result.output).toContain('HARNESS_AUDIO_TRANSCRIBE_COMMAND');
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });

  it('auto-detects an OpenAI Whisper executable on PATH as a default command', async () => {
    const binDir = path.join(fixtureDir, 'bin');
    await fs.mkdir(binDir, { recursive: true });
    const whisperName = process.platform === 'win32' ? 'whisper.exe' : 'whisper';
    await fs.writeFile(path.join(binDir, whisperName), '');
    const prevPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      const command = resolveDefaultAudioCommand();
      expect(command).not.toBeNull();
      expect(command).toContain('{input}');
      expect(command).toContain('--model base');
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });

  it('returns no default audio command when no whisper is on PATH', () => {
    const prevPath = process.env.PATH;
    process.env.PATH = fixtureDir;
    try {
      expect(resolveDefaultAudioCommand()).toBeNull();
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });

  it('runs the configured audio transcription command with the input path', async () => {
    const audioPath = path.join(fixtureDir, 'voice.wav');
    const scriptPath = path.join(fixtureDir, 'transcribe.js');
    await fs.writeFile(audioPath, Buffer.from([1, 2, 3]));
    await fs.writeFile(scriptPath, "console.log('transcript for ' + process.argv[2].split(/[\\\\/]/).pop())", 'utf-8');
    process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND = `node "${scriptPath}" "{input}"`;

    const result = await AudioTranscribeTool.execute({ path: audioPath });

    expect(result).toMatchObject({ success: true, output: 'transcript for voice.wav' });
  });
});
