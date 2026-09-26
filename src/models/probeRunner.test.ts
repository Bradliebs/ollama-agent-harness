import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Message, Tool } from 'ollama';
import type { ChatOptions, ChatResult, IChatClient, StreamChunk } from '../core/chatClient';
import { loadCapabilityProfile } from './capabilityProfile';
import { runProbeSuite } from './probeRunner';

class FakeProbeClient implements IChatClient {
  private planStep = 0;

  async chat(messages: Message[], tools?: Tool[], _signal?: AbortSignal, _options?: ChatOptions): Promise<ChatResult> {
    const prompt = String(messages[messages.length - 1]?.content ?? '');
    const toolNames = new Set((tools ?? []).map((tool) => tool.function?.name));
    let message: Message = { role: 'assistant', content: 'OK' };

    if (toolNames.has('add') && /add 2 and 3/i.test(prompt)) {
      message = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'add', arguments: { a: 2, b: 3 } } }] } as Message;
    } else if (toolNames.has('add') && /add 10 and -4/i.test(prompt)) {
      message = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'add', arguments: { a: 10, b: -4 } } }] } as Message;
    } else if (toolNames.has('get_weather')) {
      const city = /Tokyo/i.test(prompt) ? 'Tokyo' : 'Paris';
      message = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: { city } } }] } as Message;
    } else if (toolNames.has('set_kv')) {
      message = this.nextPlanMessage();
    } else if (/Return only JSON/i.test(prompt)) {
      message = { role: 'assistant', content: '{"name":"alpha","count":3,"ok":true}' };
    } else if (/exactly three words/i.test(prompt)) {
      message = { role: 'assistant', content: 'one two three' };
    } else if (/exact token BLUEBIRD/i.test(prompt)) {
      message = { role: 'assistant', content: 'BLUEBIRD' };
    } else if (/two bullet lines/i.test(prompt)) {
      message = { role: 'assistant', content: '- one\n- two' };
    } else if (/includes apple/i.test(prompt)) {
      message = { role: 'assistant', content: 'apple appears here.' };
    } else if (/five uppercase letters/i.test(prompt)) {
      message = { role: 'assistant', content: 'ABCDE' };
    } else {
      const needle = prompt.match(/NEEDLE_\d+_\d+_VALUE/)?.[0];
      if (needle) message = { role: 'assistant', content: needle };
    }

    return { message, usage: { promptTokens: 10, completionTokens: 2, totalDurationNs: 1_000_000 } };
  }

  chatOnce(messages: Message[], tools?: Tool[], options?: ChatOptions): Promise<ChatResult> {
    return this.chat(messages, tools, undefined, options);
  }

  async *chatStream(messages: Message[], tools?: Tool[], signal?: AbortSignal, options?: ChatOptions): AsyncGenerator<StreamChunk> {
    const result = await this.chat(messages, tools, signal, options);
    yield { content: String(result.message.content ?? ''), done: true, toolCalls: result.message.tool_calls };
  }

  listModels(): Promise<string[]> { return Promise.resolve(['fake']); }
  getContextWindow(): Promise<number | null> { return Promise.resolve(2048); }
  healthCheck(): Promise<{ ok: boolean; error?: string }> { return Promise.resolve({ ok: true }); }
  getModel(): string { return 'fake'; }

  private nextPlanMessage(): Message {
    const calls = [
      { function: { name: 'set_kv', arguments: { key: 'alpha', value: 'blue' } } },
      { function: { name: 'get_kv', arguments: { key: 'alpha' } } },
      { function: { name: 'set_kv', arguments: { key: 'beta', value: 'blue-done' } } },
      { function: { name: 'get_kv', arguments: { key: 'beta' } } },
    ];
    if (this.planStep < calls.length) {
      return { role: 'assistant', content: '', tool_calls: [calls[this.planStep++]] } as Message;
    }
    return { role: 'assistant', content: 'FINAL: blue-done' };
  }
}

describe('runProbeSuite', () => {
  it('runs probes with a fake client and persists a profile', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-probes-'));
    try {
      const profile = await runProbeSuite(new FakeProbeClient(), {
        model: 'fake:model',
        projectDir: dir,
        budget: { maxContextTokens: 1024 },
      });
      expect(profile.scores.toolCalling).toBe(1);
      expect(profile.scores.structuredConstrained).toBe(1);
      expect(profile.usableContextTokens).toBe(1024);
      await expect(loadCapabilityProfile('fake:model', dir)).resolves.toEqual(profile);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
