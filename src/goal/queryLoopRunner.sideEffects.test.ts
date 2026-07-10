import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { makeQueryLoopRunner } from './queryLoopRunner';
import { makeGoal } from './types';
import { listSideEffects } from '../persistence/sideEffectLedger';
import { revertRun } from '../persistence/runReverter';
import type { IChatClient, ChatResult, StreamChunk } from '../core/chatClient';
import type { Tool, ToolResult } from '../types';
import type { Message } from 'ollama';

// Stub client that issues one file_write tool call per iteration, then stops.
// Within a single queryLoop run the first turn has no prior tool message, so it
// emits the call; once the tool result is appended (role 'tool'), it stops.
// Each goal iteration starts a fresh queryLoop with fresh messages, so the
// pattern repeats per iteration.
function makeWriteThenStopClient(filePath: string): IChatClient {
  const reply = (msgs: Message[]): ChatResult => {
    const alreadyWrote = msgs.some((m) => m.role === 'tool');
    const usage = { promptTokens: 1, completionTokens: 1, totalDurationNs: 1_000 };
    if (alreadyWrote) return { message: { role: 'assistant', content: 'done' }, usage };
    return {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'file_write', arguments: { path: filePath, content: 'v' } } }],
      },
      usage,
    };
  };
  return {
    chat: async (m: Message[]) => reply(m),
    chatOnce: async (m: Message[]) => reply(m),
    chatStream: async function* () { yield { content: 'done', done: true } as StreamChunk; },
    listModels: async () => ['stub'],
    getContextWindow: async () => 8_000,
    healthCheck: async () => ({ ok: true }),
    getModel: () => 'stub',
  };
}

function writeTool(projectDir: string): Tool {
  return {
    name: 'file_write',
    description: 'file_write',
    parameters: { type: 'object', properties: {} },
    isReadOnly: false,
    execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
      const abs = path.join(projectDir, input.path as string);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, (input.content as string) ?? '', 'utf-8');
      return { success: true, output: 'written' };
    },
  };
}

describe('goal/queryLoopRunner side-effect recording', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-goal-serec-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('scopes writes from every iteration under goal.id and reverts the goal as a unit', async () => {
    const goal = makeGoal({ target: 'write a file each iteration' }, 'g-undo');
    const run = makeQueryLoopRunner({
      client: makeWriteThenStopClient('out.txt'),
      tools: [writeTool(tmpDir)],
      model: 'stub',
      systemPrompt: 'You are a tester.',
      projectDir: tmpDir,
    });

    await run(goal, 1); // creates out.txt
    await run(goal, 2); // modifies out.txt

    const effects = await listSideEffects(tmpDir, goal.id);
    expect(effects.map((e) => e.kind)).toEqual(['file_create', 'file_modify']);
    expect(await fs.readFile(path.join(tmpDir, 'out.txt'), 'utf-8')).toBe('v');

    const result = await revertRun(tmpDir, goal.id);
    expect(result.reverted).toHaveLength(2);
    expect(result.failed).toEqual([]);
    await expect(fs.access(path.join(tmpDir, 'out.txt'))).rejects.toThrow();
  });

  it('records nothing when projectDir is omitted (opt-in)', async () => {
    const goal = makeGoal({ target: 'write a file' }, 'g-noop');
    const run = makeQueryLoopRunner({
      client: makeWriteThenStopClient('out.txt'),
      tools: [writeTool(tmpDir)],
      model: 'stub',
      systemPrompt: 'You are a tester.',
    });

    await run(goal, 1);

    expect(await listSideEffects(tmpDir, goal.id)).toEqual([]);
  });
});
