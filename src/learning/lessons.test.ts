import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Message } from 'ollama';
import { queryLoop } from '../core/queryLoop';
import { RunLog, type RunEvent } from '../persistence/runLog';
import { getSkillUsage } from '../extensibility/skillUsage';
import type { LoopConfig, Tool } from '../types';
import { applyRunOutcome, deriveRunOutcome, learnFromRun, loadLessons, recallLessons, renderLessons, resolveLessonsMode, type LessonStore, type RunOutcome } from './lessons';

jest.mock('./engine', () => ({
  trackToolUsage: jest.fn().mockResolvedValue(undefined),
}));

const page = 'Fujifilm X100VI price comparison: best price £1,669.28, used from £1,636.';

function tools(): Tool[] {
  return [
    {
      name: 'web_read',
      description: 'read',
      parameters: { type: 'object', properties: { url: { type: 'string' } } },
      isReadOnly: true,
      execute: jest.fn(async (input: Record<string, unknown>) => (String(input.url).includes('trustpilot')
        ? { success: false, output: 'HTTP 403 Forbidden', error: 'HTTP 403' }
        : { success: true, output: page })),
    },
    {
      name: 'skill',
      description: 'skill',
      parameters: { type: 'object', properties: { name: { type: 'string' } } },
      isReadOnly: true,
      execute: jest.fn(async () => ({ success: true, output: '--- Skill: price-check ---' })),
    },
  ];
}

const call = (name: string, args: Record<string, unknown>) => ({ role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }) as Message;

async function recordRun(dir: string, runId: string, answer: string, config: Partial<LoopConfig> = {}): Promise<void> {
  const replies: Message[] = [
    call('skill', { name: 'price-check' }),
    call('web_read', { url: 'https://uk.trustpilot.com/review/cameras.example' }),
    call('web_read', { url: 'https://www.idealo.co.uk/x100vi' }),
    { role: 'assistant', content: answer } as Message,
  ];
  const runLog = new RunLog(dir, runId);
  for await (const _event of queryLoop(
    { model: 'glm-5.3:cloud', systemPrompt: 'You are Moss.', maxTurns: 6, context: { enabled: false }, supervisor: false, verifyResearch: 'check', ...config },
    { client: { chat: jest.fn(async () => ({ message: replies.shift() as Message })) } as never, tools: tools(), runLog },
    [{ role: 'user', content: 'Check reviews for cameras.example and the current UK price of the Fujifilm X100VI' }],
  )) { /* consume */ }
  await runLog.flush();
}

describe('lessons from run history', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-lessons-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('derives blocked sources, unsupported figures and skills used from a recorded run', async () => {
    await recordRun(dir, 'chat-lesson-1', 'It is £1,669.28 new; the black edition is £1,999.');
    const result = await learnFromRun(dir, 'chat-lesson-1', new Date('2026-09-27T10:00:00Z'));
    expect(result?.outcome).toMatchObject({
      task: expect.stringContaining('X100VI'),
      doneReason: 'completed',
      success: false,
      blockedDomains: [{ domain: 'uk.trustpilot.com', status: 'HTTP 403' }],
      unsupportedFigures: ['1999'],
      skillsUsed: ['price-check'],
    });
    const store = await loadLessons(dir);
    expect(store.lessons.map((lesson) => lesson.kind).sort()).toEqual(['blocked_source', 'unsupported_claims']);
    expect(await getSkillUsage(dir, 'price-check')).toMatchObject({ successCount: 1, consecutiveFailures: 0 });
  });

  it('recalls relevant lessons for a similar task and labels them as run history', async () => {
    await recordRun(dir, 'chat-lesson-2', 'It is £1,669.28 new; the black edition is £1,999.');
    await learnFromRun(dir, 'chat-lesson-2', new Date('2026-09-27T10:00:00Z'));
    const store = await loadLessons(dir);
    const recalled = recallLessons(store, 'What is the UK price of the Fujifilm X100VI black edition?', new Date('2026-09-28T10:00:00Z'));
    expect(recalled.map((lesson) => lesson.kind)).toEqual(['blocked_source', 'unsupported_claims']);
    const block = renderLessons(recalled);
    expect(block).toContain('## Lessons from earlier runs');
    expect(block).toContain('not from the user');
    expect(block).toContain('uk.trustpilot.com (HTTP 403)');
    expect(block).toMatch(/stated figures no page supported \(1999\)/);
    expect(recallLessons(store, 'Tell me a joke about cats', new Date('2026-09-28T10:00:00Z'))).toEqual([]);
    expect(recallLessons(store, 'What is the UK price of the X100VI?', new Date('2026-12-30T10:00:00Z')).map((lesson) => lesson.kind)).toEqual(['unsupported_claims']);
  });

  it('records recalled lesson ids on the run and scores whether they helped', async () => {
    await recordRun(dir, 'chat-lesson-3', 'It is £1,669.28 new; the black edition is £1,999.');
    await learnFromRun(dir, 'chat-lesson-3');
    const ids = (await loadLessons(dir)).lessons.map((lesson) => lesson.id);
    await recordRun(dir, 'chat-lesson-4', 'It is £1,669.28 new and £1,636 used.', { recalledLessons: ids });
    await learnFromRun(dir, 'chat-lesson-4');
    const scored = await loadLessons(dir);
    expect(scored.lessons.find((lesson) => lesson.kind === 'unsupported_claims')).toMatchObject({ recalled: 1, helped: 1, failedAgain: 0 });
    // The same site blocked reading again, so that lesson did not prevent it.
    expect(scored.lessons.find((lesson) => lesson.kind === 'blocked_source')).toMatchObject({ recalled: 1, helped: 0, failedAgain: 1, occurrences: 2 });
  });

  it('retires a lesson that keeps failing to prevent its failure', () => {
    const outcome = (runId: string, recalledLessons: string[]): RunOutcome => ({
      runId, task: 'find the price of the nikon zr in the uk', doneReason: 'completed', success: false, budgetExceeded: false,
      unsupportedFigures: ['1999'], blockedDomains: [], skillsUsed: [], recalledLessons,
    });
    let store: LessonStore = applyRunOutcome({ version: 1, lessons: [] }, outcome('r1', [])).store;
    const id = store.lessons[0].id;
    store = applyRunOutcome(store, outcome('r2', [id])).store;
    expect(store.lessons[0].retired).toBeUndefined();
    store = applyRunOutcome(store, outcome('r3', [id])).store;
    expect(store.lessons[0]).toMatchObject({ failedAgain: 2, retired: expect.stringContaining('happened again 2 times') });
    expect(recallLessons(store, 'find the price of the nikon zr in the uk')).toEqual([]);
  });

  it('turns a stuck run into a lesson from the supervisor summary', () => {
    const events: RunEvent[] = [
      { v: 1, runId: 'r', seq: 1, ts: '2026-09-27T10:00:00Z', kind: 'run_start', data: { model: 'qwen3.5:4b' } },
      { v: 1, runId: 'r', seq: 2, ts: '2026-09-27T10:00:00Z', kind: 'messages', data: { from: 0, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'Find opening hours for the Leeds Apple store' }] } },
      { v: 1, runId: 'r', seq: 3, ts: '2026-09-27T10:00:01Z', kind: 'model_request', data: {} },
      { v: 1, runId: 'r', seq: 4, ts: '2026-09-27T10:00:09Z', kind: 'supervisor', data: { event: 'intervene', stage: 'ask_human', summary: 'Recent attempts without new results: web_search(apple leeds hours); web_read(apple.com/uk/retail/trinityleeds)' } },
      { v: 1, runId: 'r', seq: 5, ts: '2026-09-27T10:00:10Z', kind: 'run_end', data: { reason: 'stuck_needs_human' } },
    ] as unknown as RunEvent[];
    const outcome = deriveRunOutcome('r', events);
    expect(outcome).toMatchObject({ task: 'Find opening hours for the Leeds Apple store', success: false });
    const { added } = applyRunOutcome({ version: 1, lessons: [] }, outcome);
    expect(added[0]).toMatchObject({ kind: 'stuck', text: expect.stringContaining('got stuck repeating web_search(apple leeds hours)') });
  });

  it('skips replays and resolves the mode', async () => {
    expect(await learnFromRun(dir, 'replay-chat-x-model-1')).toBeNull();
    expect(resolveLessonsMode(undefined)).toBe('record');
    expect(resolveLessonsMode('recall')).toBe('recall');
    expect(resolveLessonsMode('off')).toBe('off');
  });
});
