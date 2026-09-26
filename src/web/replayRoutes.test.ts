import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';
import express from 'express';
import type { Message } from 'ollama';
import { queryLoop } from '../core/queryLoop';
import type { IChatClient } from '../core/chatClient';
import { RunLog } from '../persistence/runLog';
import type { Tool } from '../types';
import { createReplayRouter } from './replayRoutes';

jest.mock('../learning/engine', () => ({
  trackToolUsage: jest.fn().mockResolvedValue(undefined),
}));

function call(name: string, args: Record<string, unknown>) {
  return { function: { name, arguments: args } };
}

function scriptedClient(model: string, responses: Message[]): IChatClient {
  return {
    chat: jest.fn(async () => ({ message: responses.shift() ?? { role: 'assistant', content: 'done' } as Message, usage: { promptTokens: 2, completionTokens: 1, totalDurationNs: 1_000_000 } })),
    chatOnce: jest.fn(),
    chatStream: jest.fn(),
    listModels: jest.fn(async () => [model]),
    getContextWindow: jest.fn(async () => null),
    healthCheck: jest.fn(async () => ({ ok: true })),
    getModel: () => model,
  } as unknown as IChatClient;
}

async function seedRun(dir: string): Promise<void> {
  const tool: Tool = {
    name: 'lookup',
    description: 'lookup',
    parameters: { type: 'object' },
    isReadOnly: true,
    execute: async (input) => ({ success: true, output: `recorded:${String(input.q)}` }),
  };
  const runLog = new RunLog(dir, 'chat-route-1');
  for await (const _event of queryLoop(
    { model: 'original', systemPrompt: 'system', maxTurns: 4, context: { enabled: false }, supervisor: false },
    { client: scriptedClient('original', [
      { role: 'assistant', content: '', tool_calls: [call('lookup', { q: 'alpha' })] } as Message,
      { role: 'assistant', content: 'original final' } as Message,
    ]), tools: [tool], runLog },
    [{ role: 'user', content: 'go' }],
  )) { /* consume */ }
  await runLog.flush();
}

describe('replay routes', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let authorised = true;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-replay-routes-'));
    await seedRun(dir);
    const app = express();
    app.use(express.json());
    app.use(createReplayRouter({
      projectDir: dir,
      requireAuth: (_req, res) => {
        if (!authorised) res.status(401).json({ error: 'auth required' });
        return authorised;
      },
      createClient: (model) => scriptedClient(model, [
        { role: 'assistant', content: '', tool_calls: [call('lookup', { q: 'alpha' })] } as Message,
        { role: 'assistant', content: `${model} replayed` } as Message,
      ]),
      logger: { info: () => {} },
    }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('requires auth for POST and completes a replay job', async () => {
    authorised = false;
    expect((await fetch(`${base}/api/replays`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: 'chat-route-1', models: ['m1'] }) })).status).toBe(401);
    authorised = true;

    const create = await (await fetch(`${base}/api/replays`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: 'chat-route-1', models: ['m1'] }) })).json() as { jobId: string; status: string };
    expect(create.status).toBe('running');

    let detail: { status: string; report?: { replays?: unknown[] }; error?: string } | undefined;
    for (let i = 0; i < 20; i += 1) {
      detail = await (await fetch(`${base}/api/replays/${create.jobId}`)).json() as typeof detail;
      if (detail?.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(detail).toMatchObject({ status: 'completed' });
    expect(detail?.report?.replays).toHaveLength(1);

    const list = await (await fetch(`${base}/api/replays`)).json() as { jobs: Array<{ id: string }> };
    expect(list.jobs.map((job) => job.id)).toContain(create.jobId);
  });
});
