import type { Message, Tool } from 'ollama';
import type { ChatResult, IChatClient } from '../core/chatClient';
import { PROBE_TOOL_NAME, probeToolCalling } from './toolCallProbe';

type ChatImpl = (messages: Message[], tools?: Tool[], abortSignal?: AbortSignal) => Promise<ChatResult>;

function makeClient(chatImpl: ChatImpl, model = 'test-model'): IChatClient {
  return {
    chat: jest.fn(chatImpl),
    chatOnce: jest.fn(),
    chatStream: jest.fn(),
    listModels: jest.fn(),
    getContextWindow: jest.fn(),
    healthCheck: jest.fn(),
    getModel: jest.fn(() => model),
  } as unknown as IChatClient;
}

function chatResult(toolCalls?: NonNullable<Message['tool_calls']>): ChatResult {
  return {
    message: { role: 'assistant', content: '', ...(toolCalls ? { tool_calls: toolCalls } : {}) },
    usage: { promptTokens: 0, completionTokens: 0, totalDurationNs: 0 },
  };
}

describe('probeToolCalling', () => {
  it('returns verified when the model emits a tool call', async () => {
    const client = makeClient(async () =>
      chatResult([{ function: { name: 'report_ready', arguments: { status: 'ok' } } }]),
    );

    const result = await probeToolCalling(client);

    expect(result.verdict).toBe('verified');
    expect(result.calledTool).toBe(true);
    expect(result.toolName).toBe('report_ready');
    expect(result.model).toBe('test-model');
  });

  it('returns failed when the model ignores the tool and replies with text', async () => {
    const client = makeClient(async () => chatResult());

    const result = await probeToolCalling(client);

    expect(result.verdict).toBe('failed');
    expect(result.calledTool).toBe(false);
    expect(result.message).toMatch(/ignored the provided tool/i);
  });

  it('returns inconclusive when the chat call throws', async () => {
    const client = makeClient(async () => {
      throw new Error('backend exploded');
    });

    const result = await probeToolCalling(client);

    expect(result.verdict).toBe('inconclusive');
    expect(result.message).toMatch(/backend exploded/);
  });

  it('returns inconclusive and reports a timeout when the model never responds', async () => {
    const client = makeClient(
      (_messages, _tools, signal) =>
        new Promise<ChatResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const result = await probeToolCalling(client, { timeoutMs: 10 });

    expect(result.verdict).toBe('inconclusive');
    expect(result.message).toMatch(/timed out/);
  });

  it('sends exactly the probe tool to the client', async () => {
    const chat = jest.fn<Promise<ChatResult>, [Message[], Tool[]?, AbortSignal?]>(async () =>
      chatResult([{ function: { name: PROBE_TOOL_NAME, arguments: {} } }]),
    );
    const client = makeClient(chat);

    await probeToolCalling(client);

    expect(chat).toHaveBeenCalledTimes(1);
    const tools = chat.mock.calls[0][1];
    expect(tools).toHaveLength(1);
    expect(tools?.[0].function.name).toBe(PROBE_TOOL_NAME);
  });
});
