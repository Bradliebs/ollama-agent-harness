import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Message } from 'ollama';
import { RunLog, listRuns, newRunId, pruneRuns, readRunEvents, reconstructMessages, reconstructModelRequests, runsDir, MAX_PAYLOAD_CHARS } from './runLog';

async function tmpProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harness-runlog-'));
}

describe('RunLog', () => {
  let dir: string;
  beforeEach(async () => { dir = await tmpProject(); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('appends ordered events with step ids and reads them back', async () => {
    const log = new RunLog(dir, 'run-a');
    const step = log.nextStep('t1');
    log.append('run_start', { model: 'm' });
    log.append('model_request', { messageCount: 1 }, step);
    await log.flush();
    const events = await readRunEvents(dir, 'run-a');
    expect(events.map((event) => [event.seq, event.kind, event.stepId, event.stepSeq])).toEqual([
      [1, 'run_start', undefined, undefined],
      [2, 'model_request', 't1', 1],
    ]);
  });

  it('rebuilds the message array from deltas and compaction snapshots', async () => {
    const log = new RunLog(dir, 'run-b');
    const messages: Message[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }];
    log.syncMessages(messages);
    log.append('model_request', { messageCount: messages.length });
    messages.push({ role: 'assistant', content: 'a1' }, { role: 'tool', content: 'r1' });
    log.syncMessages(messages);
    log.append('model_request', { messageCount: messages.length });
    const compacted: Message[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'summary' }];
    log.recordCompaction(compacted, 'summary');
    compacted.push({ role: 'assistant', content: 'a2' });
    log.syncMessages(compacted);
    log.append('model_request', { messageCount: compacted.length });
    await log.flush();

    const events = await readRunEvents(dir, 'run-b');
    expect(reconstructMessages(events)).toEqual(compacted);
    expect(reconstructModelRequests(events).map((request) => request.messages.map((m) => m.content))).toEqual([
      ['s', 'q'],
      ['s', 'q', 'a1', 'r1'],
      ['s', 'summary', 'a2'],
    ]);
  });

  it('resets the message baseline for each loop in a multi-loop run', async () => {
    const log = new RunLog(dir, 'run-multi');
    log.startLoop({ model: 'm' });
    log.syncMessages([{ role: 'system', content: 's' }, { role: 'user', content: 'step 1' }, { role: 'assistant', content: 'a' }]);
    log.append('model_request', { messageCount: 3 });
    log.startLoop({ model: 'm' });
    log.syncMessages([{ role: 'system', content: 's' }, { role: 'user', content: 'step 2' }]);
    log.append('model_request', { messageCount: 2 });
    await log.flush();
    expect(reconstructModelRequests(await readRunEvents(dir, 'run-multi')).map((request) => request.messages.map((m) => m.content)))
      .toEqual([['s', 'step 1', 'a'], ['s', 'step 2']]);
  });
  it('re-baselines when the array shrinks without an explicit compaction', async () => {
    const log = new RunLog(dir, 'run-c');
    log.syncMessages([{ role: 'user', content: '1' }, { role: 'user', content: '2' }]);
    log.syncMessages([{ role: 'user', content: 'only' }]);
    await log.flush();
    expect(reconstructMessages(await readRunEvents(dir, 'run-c'))).toEqual([{ role: 'user', content: 'only' }]);
  });

  it('truncates oversized tool output with a marker', async () => {
    const log = new RunLog(dir, 'run-d');
    log.recordToolResult(undefined, { name: 'web_read', success: true, output: 'x'.repeat(MAX_PAYLOAD_CHARS + 10) });
    await log.flush();
    const [event] = await readRunEvents(dir, 'run-d');
    expect(String(event.data.output)).toContain('[run log truncated 10 chars]');
  });

  it('ignores a torn trailing line and rejects unsafe run ids', async () => {
    const log = new RunLog(dir, 'run-e');
    log.append('run_start', {});
    await log.flush();
    await fs.appendFile(path.join(runsDir(dir), 'run-e.jsonl'), '{"seq":2,"kind":"mod', 'utf-8');
    expect(await readRunEvents(dir, 'run-e')).toHaveLength(1);
    expect(() => new RunLog(dir, '../escape')).toThrow(/Invalid run id/);
    expect(await readRunEvents(dir, 'never-existed')).toEqual([]);
  });

  it('lists runs newest first with a summary and prunes beyond the limits', async () => {
    for (const id of ['run-1', 'run-2', 'run-3']) {
      const log = new RunLog(dir, id);
      log.append('run_start', { model: `model-${id}`, sessionId: 's' });
      log.append('run_end', { reason: 'completed', turns: 2 });
      await log.flush();
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const runs = await listRuns(dir);
    expect(runs.map((run) => run.runId)).toEqual(['run-3', 'run-2', 'run-1']);
    expect(runs[0]).toMatchObject({ model: 'model-run-3', reason: 'completed', turns: 2, events: 2 });
    expect(await pruneRuns(dir, { maxRuns: 2 })).toEqual(['run-1']);
    expect((await listRuns(dir)).map((run) => run.runId)).toEqual(['run-3', 'run-2']);
    expect(await pruneRuns(dir, { maxBytes: 1 })).toEqual(['run-3', 'run-2']);
  });

  it('generates safe, unique run ids', () => {
    const a = newRunId('chat/../x');
    const b = newRunId('chat/../x');
    expect(a).toMatch(/^chatx-\d{17}-[a-z0-9]+$/);
    expect(a).not.toBe(b);
  });
});
