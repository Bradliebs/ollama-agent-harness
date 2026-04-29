import { OllamaClient } from './ollamaClient';

const mockChat = jest.fn();
const mockShow = jest.fn();
const mockList = jest.fn();

jest.mock('ollama', () => ({
  Ollama: jest.fn().mockImplementation(() => ({ chat: mockChat, show: mockShow, list: mockList })),
}));

describe('OllamaClient context configuration', () => {
  beforeEach(() => {
    mockChat.mockReset();
    mockShow.mockReset();
    mockList.mockReset();
  });

  it('passes num_ctx to chat requests when configured', async () => {
    mockChat.mockResolvedValue({
      message: { role: 'assistant', content: 'ok' },
      prompt_eval_count: 1,
      eval_count: 1,
      total_duration: 1,
    });
    const client = new OllamaClient({ model: 'test-model', numCtx: 32768 });

    await client.chat([{ role: 'user', content: 'hello' }]);

    expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({
      model: 'test-model',
      options: { num_ctx: 32768 },
    }));
  });

  it('detects context window from model_info', async () => {
    mockShow.mockResolvedValue({ model_info: new Map([['llama.context_length', 131072]]), parameters: '' });
    const client = new OllamaClient({ model: 'large-context' });

    await expect(client.getContextWindow()).resolves.toBe(131072);
  });

  it('falls back to num_ctx parameters when model_info has no context length', async () => {
    mockShow.mockResolvedValue({ model_info: new Map(), parameters: 'num_ctx 65536\ntemperature 0.7' });
    const client = new OllamaClient({ model: 'parameter-context' });

    await expect(client.getContextWindow()).resolves.toBe(65536);
  });
});
