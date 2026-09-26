import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';
import express from 'express';
import type { Message, Tool } from 'ollama';
import type { ChatOptions, ChatResult, IChatClient, StreamChunk } from '../core/chatClient';
import { createModelProfileRouter } from './modelProfileRoutes';

class TinyClient implements IChatClient {
  async chat(messages: Message[], tools?: Tool[], _signal?: AbortSignal, _options?: ChatOptions): Promise<ChatResult> {
    const prompt = String(messages[messages.length - 1]?.content ?? '');
    const names = new Set((tools ?? []).map((tool) => tool.function?.name));
    let message: Message = { role: 'assistant', content: '{"name":"x","count":1,"ok":true}' };
    if (names.has('add')) message = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'add', arguments: { a: /10/.test(prompt) ? 10 : 2, b: /-4/.test(prompt) ? -4 : 3 } } }] } as Message;
    else if (names.has('get_weather')) message = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: { city: /Tokyo/.test(prompt) ? 'Tokyo' : 'Paris' } } }] } as Message;
    else if (/NEEDLE_\d+_\d+_VALUE/.test(prompt)) message = { role: 'assistant', content: prompt.match(/NEEDLE_\d+_\d+_VALUE/)![0] };
    else if (/three words/.test(prompt)) message = { role: 'assistant', content: 'one two three' };
    else if (/BLUEBIRD/.test(prompt)) message = { role: 'assistant', content: 'BLUEBIRD' };
    else if (/bullet/.test(prompt)) message = { role: 'assistant', content: '- a\n- b' };
    else if (/apple/.test(prompt)) message = { role: 'assistant', content: 'apple only' };
    else if (/uppercase/.test(prompt)) message = { role: 'assistant', content: 'ABCDE' };
    return { message, usage: { promptTokens: 1, completionTokens: 1, totalDurationNs: 1 } };
  }
  chatOnce(messages: Message[], tools?: Tool[], options?: ChatOptions): Promise<ChatResult> { return this.chat(messages, tools, undefined, options); }
  async *chatStream(): AsyncGenerator<StreamChunk> { yield { content: '', done: true }; }
  listModels(): Promise<string[]> { return Promise.resolve(['fake']); }
  getContextWindow(): Promise<number | null> { return Promise.resolve(1024); }
  healthCheck(): Promise<{ ok: boolean; error?: string }> { return Promise.resolve({ ok: true }); }
  getModel(): string { return 'fake'; }
}

describe('model profile routes', () => {
  let dir: string;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-model-profile-routes-'));
    const app = express();
    app.use(express.json());
    app.use(createModelProfileRouter({
      projectDir: dir,
      createClient: () => new TinyClient(),
      requireAuth: () => true,
      logger: {},
    }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('starts a probe job, reports status, and lists saved profiles', async () => {
    const started = await (await fetch(`${base}/api/model-profiles/fake/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ budget: { maxContextTokens: 1024, samples: 1 } }),
    })).json() as { jobId: string };
    expect(started.jobId).toMatch(/^probe_/);

    let job: { status: string; profile?: unknown } | undefined;
    for (let i = 0; i < 20; i++) {
      job = (await (await fetch(`${base}/api/model-profiles/probe-jobs/${started.jobId}`)).json() as { job: typeof job }).job;
      if (job?.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(job?.status).toBe('completed');
    expect(job?.profile).toBeTruthy();

    const list = await (await fetch(`${base}/api/model-profiles`)).json() as { profiles: Array<{ model: string }> };
    expect(list.profiles.map((profile) => profile.model)).toContain('fake');
    const one = await (await fetch(`${base}/api/model-profiles/fake`)).json() as { profile: { model: string } };
    expect(one.profile.model).toBe('fake');
  });
});
