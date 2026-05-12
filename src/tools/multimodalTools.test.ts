import * as fs from 'fs/promises';
import * as path from 'path';
import { AudioTranscribeTool, ImageAnalyzeTool } from './multimodalTools';

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

  beforeEach(async () => {
    fixtureDir = path.join(process.cwd(), '.harness', 'test-multimodal');
    await fs.rm(fixtureDir, { recursive: true, force: true });
    await fs.mkdir(fixtureDir, { recursive: true });
    mockChat.mockReset();
    mockList.mockReset();
    delete process.env.HARNESS_VISION_MODEL;
    delete process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND;
    delete process.env.OLLAMA_MODEL;
  });

  afterEach(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
    if (originalVisionModel === undefined) delete process.env.HARNESS_VISION_MODEL;
    else process.env.HARNESS_VISION_MODEL = originalVisionModel;
    if (originalAudioCommand === undefined) delete process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND;
    else process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND = originalAudioCommand;
    if (originalOllamaModel === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = originalOllamaModel;
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

  it('reports a clear audio transcription setup error when no command is configured', async () => {
    const audioPath = path.join(fixtureDir, 'voice.wav');
    await fs.writeFile(audioPath, Buffer.from([1, 2, 3]));

    const result = await AudioTranscribeTool.execute({ path: audioPath });

    expect(result).toMatchObject({ success: false, error: 'missing transcription command' });
    expect(result.output).toContain('HARNESS_AUDIO_TRANSCRIBE_COMMAND');
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
