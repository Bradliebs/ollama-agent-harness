import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runSubagent, type SubagentConfig } from './subagent';
import { listSideEffects } from '../persistence/sideEffectLedger';
import type { IChatClient, ChatResult, StreamChunk } from '../core/chatClient';
import type { Tool, ToolResult } from '../types';
import type { Message } from 'ollama';

// Stub client that issues one file_write tool call, then on the next turn
// (once a tool result is present) does the thing the test needs: either throw
// (error path) or return a final text answer (success path).
function makeClient(filePath: string, afterWrite: 'throw' | 'finish'): IChatClient {
  const usage = { promptTokens: 1, completionTokens: 1, totalDurationNs: 1_000 };
  const reply = (msgs: Message[]): ChatResult => {
    const wrote = msgs.some((m) => m.role === 'tool');
    if (wrote) {
      if (afterWrite === 'throw') throw new Error('subagent boom');
      return { message: { role: 'assistant', content: 'done' }, usage };
    }
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

function baseConfig(tmpDir: string, runId: string, extra: Partial<SubagentConfig> = {}): SubagentConfig {
  return {
    name: 'general',
    systemPrompt: 'You are a tester.',
    runId,
    tools: [writeTool(tmpDir)],
    metricsProjectDir: tmpDir,
    maxTurns: 4,
    ...extra,
  };
}

describe('agents/subagent opt-in side-effect recovery', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-subagent-serec-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('records under the run id and reverts file changes when the run errors', async () => {
    const config = baseConfig(tmpDir, 'sub-err', { undoOnError: { projectDir: tmpDir } });
    await runSubagent(config, 'write then fail', makeClient('out.txt', 'throw'), []);

    // The errored run's file mutation was recorded under runId, then reverted.
    expect(await fs.access(path.join(tmpDir, 'out.txt')).then(() => true, () => false)).toBe(false);
    const effects = await listSideEffects(tmpDir, 'sub-err');
    expect(effects.map((e) => e.reversed)).toEqual([true]);
  });

  it('does not record or revert when undoOnError is omitted (opt-in)', async () => {
    const config = baseConfig(tmpDir, 'sub-noop');
    await runSubagent(config, 'write then fail', makeClient('out.txt', 'throw'), []);

    // No recorder was attached: the file the (failed) run wrote is left as-is.
    expect(await fs.readFile(path.join(tmpDir, 'out.txt'), 'utf-8')).toBe('v');
    expect(await listSideEffects(tmpDir, 'sub-noop')).toEqual([]);
  });

  it('records but does not revert on a successful run', async () => {
    const config = baseConfig(tmpDir, 'sub-ok', { undoOnError: { projectDir: tmpDir } });
    const summary = await runSubagent(config, 'write then finish', makeClient('out.txt', 'finish'), []);

    expect(summary).toBe('done');
    expect(await fs.readFile(path.join(tmpDir, 'out.txt'), 'utf-8')).toBe('v');
    const effects = await listSideEffects(tmpDir, 'sub-ok');
    expect(effects.map((e) => e.reversed)).toEqual([false]);
  });
});
