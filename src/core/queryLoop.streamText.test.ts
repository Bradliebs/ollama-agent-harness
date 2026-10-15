import type { Message } from 'ollama';
import { queryLoop } from './queryLoop';
import { createTextPreview } from './textPreview';
import type { LoopConfig, LoopEvent } from '../types';
import type { ChatOptions } from './chatClient';

jest.mock('../learning/engine', () => ({ trackToolUsage: jest.fn().mockResolvedValue(undefined) }));

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('text preview', () => {
  it('turns content snapshots into deltas and starts over on a retry', async () => {
    const preview = createTextPreview();
    let finish: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => { finish = resolve; });
    const seen: Array<{ content: string; reset: boolean }> = [];
    const reading = (async () => { for await (const delta of preview.until(settled)) seen.push(delta); })();
    preview.onContent('Hel');
    await tick();
    preview.onContent('Hello');
    await tick();
    preview.onContent('Hi');
    await tick();
    finish();
    await reading;
    expect(seen).toEqual([
      { content: 'Hel', reset: false },
      { content: 'lo', reset: false },
      { content: 'Hi', reset: true },
    ]);
  });

  it('holds back text that looks like an inline tool call', async () => {
    const preview = createTextPreview();
    let finish: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => { finish = resolve; });
    const seen: string[] = [];
    const reading = (async () => { for await (const delta of preview.until(settled)) seen.push(delta.content); })();
    preview.onContent('{"name": "file_read"');
    await tick();
    finish();
    await reading;
    expect(seen).toEqual([]);
  });

  it('ends quietly when the call fails', async () => {
    const preview = createTextPreview();
    const settled = Promise.reject(new Error('boom'));
    const seen: string[] = [];
    for await (const delta of preview.until(settled)) seen.push(delta.content);
    expect(seen).toEqual([]);
    await expect(settled).rejects.toThrow('boom');
  });
});

describe('queryLoop streamText', () => {
  const config = (overrides: Partial<LoopConfig> = {}): LoopConfig => ({ model: 'm', systemPrompt: 'system', maxTurns: 2, context: { enabled: false }, ...overrides });

  function streamingClient(reply: string) {
    return {
      chat: jest.fn(async (_messages: Message[], _tools: unknown, _signal: unknown, options?: ChatOptions) => {
        for (let i = 1; i <= reply.length; i += 4) {
          options?.onContent?.(reply.slice(0, i));
          await tick();
        }
        options?.onContent?.(reply);
        return { message: { role: 'assistant', content: reply } as Message, usage: { promptTokens: 1, completionTokens: 1, totalDurationNs: 0 } };
      }),
    };
  }

  async function run(client: ReturnType<typeof streamingClient>, overrides: Partial<LoopConfig>): Promise<LoopEvent[]> {
    const events: LoopEvent[] = [];
    for await (const event of queryLoop(config(overrides), { client: client as never, tools: [] }, [{ role: 'user', content: 'hi' }])) events.push(event);
    return events;
  }

  it('previews the reply before the final text when enabled', async () => {
    const reply = 'The answer is forty-two, as computed.';
    const events = await run(streamingClient(reply), { streamText: true });
    const deltas = events.filter((e): e is Extract<LoopEvent, { type: 'text_delta' }> => e.type === 'text_delta');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((d) => d.content).join('')).toBe(reply);
    const lastDelta = events.lastIndexOf(deltas[deltas.length - 1]);
    const text = events.findIndex((e) => e.type === 'text');
    expect(text).toBeGreaterThan(lastDelta);
    expect(events[text]).toEqual({ type: 'text', content: reply });
  });

  it('emits no previews when off, and passes no options to the client', async () => {
    const client = streamingClient('plain reply');
    const events = await run(client, {});
    expect(events.some((e) => e.type === 'text_delta')).toBe(false);
    expect(client.chat.mock.calls[0][3]).toBeUndefined();
  });
});
