import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Message } from 'ollama';
import { queryLoop } from './queryLoop';
import { RunLog, readRunEvents, reconstructModelRequests } from '../persistence/runLog';
import { listSideEffects } from '../persistence/sideEffectLedger';
import { revertRun, revertToStep } from '../persistence/runReverter';
import { FileWriteTool, FileEditTool, FileMoveTool } from '../tools/fileTools';
import { getProjectRoot, resolveToolMutationTarget, setProjectRoot } from '../tools/pathResolution';
import type { LoopEvent } from '../types';

jest.mock('../learning/engine', () => ({
  trackToolUsage: jest.fn().mockResolvedValue(undefined),
}));

function scriptedClient(responses: Message[]) {
  const sent: Message[][] = [];
  return {
    sent,
    chat: jest.fn(async (messages: Message[]) => {
      sent.push(JSON.parse(JSON.stringify(messages)) as Message[]);
      return { message: responses.shift() as Message, usage: { promptTokens: 10, completionTokens: 5 } };
    }),
  };
}

const call = (name: string, args: Record<string, unknown>) => ({ function: { name, arguments: args } });

describe('queryLoop with a run log', () => {
  let dir: string;
  let previousRoot: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-runlog-loop-'));
    previousRoot = getProjectRoot();
    setProjectRoot(dir);
    await fs.mkdir(path.join(dir, 'notes'), { recursive: true });
    await fs.writeFile(path.join(dir, 'notes', 'plan.md'), 'original plan\n');
  });

  afterEach(async () => {
    setProjectRoot(previousRoot);
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function run(client: ReturnType<typeof scriptedClient>, runLog: RunLog): Promise<LoopEvent[]> {
    const events: LoopEvent[] = [];
    for await (const event of queryLoop(
      { model: 'fixture-model', systemPrompt: 'system', maxTurns: 6, context: { enabled: false } },
      {
        client: client as never,
        tools: [FileWriteTool, FileEditTool, FileMoveTool],
        runLog,
        sideEffectRecorder: { projectDir: dir, runId: runLog.runId, resolveTarget: resolveToolMutationTarget },
      },
      [{ role: 'user', content: 'update the notes' }],
    )) events.push(event);
    return events;
  }

  it('records a reconstructable run and rolls file changes back to any step', async () => {
    const client = scriptedClient([
      { role: 'assistant', content: '', tool_calls: [call('file_edit', { path: 'notes/plan.md', old_string: 'original', new_string: 'revised' })] } as Message,
      { role: 'assistant', content: '', tool_calls: [call('file_write', { path: 'notes/extra.md', content: 'new file' }), call('file_write', { path: 'scratch.md', content: 'scratch' })] } as Message,
      { role: 'assistant', content: '', tool_calls: [call('file_move', { from: 'notes/extra.md', to: 'notes/moved.md' })] } as Message,
      { role: 'assistant', content: 'All done.' },
    ]);
    const runLog = new RunLog(dir, 'run-loop-1');

    const events = await run(client, runLog);
    expect(events.find((event) => event.type === 'done')).toMatchObject({ reason: 'completed' });

    const logged = await readRunEvents(dir, 'run-loop-1');
    expect(logged[0]).toMatchObject({ kind: 'run_start', data: { model: 'fixture-model', tools: ['file_write', 'file_edit', 'file_move'] } });
    expect(logged[logged.length - 1]).toMatchObject({ kind: 'run_end', data: { reason: 'completed', turns: 4 } });

    // Every prompt the model received can be rebuilt exactly from the log.
    expect(reconstructModelRequests(logged).map((request) => request.messages)).toEqual(client.sent);

    const responses = logged.filter((event) => event.kind === 'model_response');
    expect(responses.map((event) => event.stepId)).toEqual(['t1', 't2', 't3', 't4']);
    expect(logged.filter((event) => event.kind === 'tool_result').map((event) => [event.stepId, event.data.name, event.data.success]))
      .toEqual([['t1.1', 'file_edit', true], ['t2.1', 'file_write', true], ['t2.2', 'file_write', true], ['t3.1', 'file_move', true]]);

    // Side effects share the run log's step numbers, and the bare-filename
    // redirect is captured at the path the tool actually wrote.
    const effects = await listSideEffects(dir, 'run-loop-1');
    const scratch = effects.find((effect) => effect.description.includes('scratch.md'));
    expect(scratch?.description).toContain(path.join('agent-outputs', 'scratch.md'));
    const stepOf = (id: string) => logged.find((event) => event.stepId === id)?.stepSeq;
    expect(effects.map((effect) => effect.stepId)).toEqual(['t1.1', 't2.1', 't2.2', 't3.1', 't3.1']);
    expect(effects.every((effect) => typeof effect.stepSeq === 'number')).toBe(true);

    // Roll back to the end of step t2.1: the move and the scratch write are undone.
    const partial = await revertToStep(dir, 'run-loop-1', stepOf('t2.1') as number);
    expect(partial.failed).toEqual([]);
    expect(await fs.readFile(path.join(dir, 'notes', 'extra.md'), 'utf-8')).toBe('new file');
    await expect(fs.access(path.join(dir, 'notes', 'moved.md'))).rejects.toThrow();
    await expect(fs.access(scratch?.reversal.kind === 'delete_file' ? scratch.reversal.path : 'missing')).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, 'notes', 'plan.md'), 'utf-8')).toBe('revised plan\n');

    // Undo the rest of the run: the original file content comes back.
    const full = await revertRun(dir, 'run-loop-1');
    expect(full.failed).toEqual([]);
    expect(await fs.readFile(path.join(dir, 'notes', 'plan.md'), 'utf-8')).toBe('original plan\n');
    await expect(fs.access(path.join(dir, 'notes', 'extra.md'))).rejects.toThrow();
  });

  it('closes the log with run_end when the model call fails', async () => {
    const client = { chat: jest.fn().mockRejectedValue(new Error('provider down')) };
    const runLog = new RunLog(dir, 'run-loop-2');
    await run(client as never, runLog);
    const logged = await readRunEvents(dir, 'run-loop-2');
    expect(logged.map((event) => event.kind)).toEqual(['run_start', 'messages', 'model_request', 'model_error', 'run_end']);
    expect(logged[logged.length - 1].data).toMatchObject({ reason: 'error' });
  });

  it('closes the log when the consumer stops reading early', async () => {
    const client = scriptedClient([
      { role: 'assistant', content: '', tool_calls: [call('file_write', { path: 'notes/a.md', content: 'a' })] } as Message,
      { role: 'assistant', content: 'done' },
    ]);
    const runLog = new RunLog(dir, 'run-loop-3');
    const stream = queryLoop(
      { model: 'fixture-model', systemPrompt: 'system', maxTurns: 4, context: { enabled: false } },
      { client: client as never, tools: [FileWriteTool], runLog },
      [{ role: 'user', content: 'go' }],
    );
    await stream.next();
    await stream.return(undefined);
    const logged = await readRunEvents(dir, 'run-loop-3');
    expect(logged[logged.length - 1]).toMatchObject({ kind: 'run_end', data: { reason: 'incomplete' } });
  });
});
