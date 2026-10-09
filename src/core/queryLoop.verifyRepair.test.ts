import type { Message } from 'ollama';
import { queryLoop, verificationRepairPrompt } from './queryLoop';
import { verifyCode, type VerificationResult } from './doneStateVerifier';
import { getProjectRoot } from '../tools/pathResolution';
import type { LoopEvent, Tool } from '../types';

jest.mock('../learning/engine', () => ({ trackToolUsage: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./doneStateVerifier', () => ({ verifyCode: jest.fn() }));

const verifyMock = verifyCode as jest.MockedFunction<typeof verifyCode>;

const writeTool: Tool = {
  name: 'file_write',
  description: 'write',
  parameters: { type: 'object', properties: {} },
  isReadOnly: false,
  execute: async () => ({ success: true, output: 'Wrote 3 chars' }),
};

const failing: VerificationResult = {
  domain: 'code',
  overall: 'fail',
  checks: [
    { name: 'typecheck', domain: 'code', status: 'fail', detail: "src/a.ts(3,1): error TS2304: Cannot find name 'x'." },
    { name: 'lint', domain: 'code', status: 'skip', detail: 'No ESLint config found' },
  ],
  timestamp: '2026-10-08T00:00:00.000Z',
};
const passing: VerificationResult = { ...failing, overall: 'pass', checks: [{ name: 'typecheck', domain: 'code', status: 'pass' }] };

/** A model that writes a file, answers, then (when asked to repair) writes again and answers. */
function scriptedChat(): { chat: jest.Mock; seen: Message[][] } {
  const seen: Message[][] = [];
  const chat = jest.fn(async (messages: Message[]) => {
    seen.push(messages.map((m) => ({ ...m })));
    const last = messages[messages.length - 1];
    if (last.role === 'user') {
      return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'file_write', arguments: { path: 'a.ts', content: 'x' } } }] } as Message };
    }
    return { message: { role: 'assistant', content: 'Done: updated a.ts.' } as Message };
  });
  return { chat, seen };
}

async function run(repairAttempts?: number): Promise<{ events: LoopEvent[]; seen: Message[][] }> {
  const { chat, seen } = scriptedChat();
  const events: LoopEvent[] = [];
  for await (const event of queryLoop(
    { model: 'm', systemPrompt: 'system', maxTurns: 8, supervisor: false, verify: { enabled: true, ...(repairAttempts !== undefined ? { repairAttempts } : {}) } },
    { client: { chat } as never, tools: [writeTool] },
    [{ role: 'user', content: 'fix a.ts' }],
  )) events.push(event);
  return { events, seen };
}

describe('queryLoop verification repair', () => {
  beforeEach(() => verifyMock.mockReset());

  it('sends failing checks back once, then accepts the repaired run', async () => {
    verifyMock.mockResolvedValueOnce(failing).mockResolvedValueOnce(passing);
    const { events, seen } = await run();
    expect(verifyMock).toHaveBeenCalledTimes(2);
    expect(verifyMock.mock.calls[0][0].projectDir).toBe(getProjectRoot());
    const repairMessage = seen.flat().find((m) => m.role === 'user' && String(m.content).startsWith('Verification of your changes failed'));
    expect(repairMessage?.content).toContain("Cannot find name 'x'");
    expect(repairMessage?.content).not.toContain('No ESLint config found');
    expect(events.filter((e) => e.type === 'text')).toHaveLength(1);
    expect(events.find((e) => e.type === 'done')).toMatchObject({ reason: 'completed' });
  });

  it('stops after the repair budget and reports the failure', async () => {
    verifyMock.mockResolvedValue(failing);
    const { events } = await run();
    expect(verifyMock).toHaveBeenCalledTimes(2);
    expect(events.find((e) => e.type === 'done')).toMatchObject({ reason: 'completed_with_test_failures' });
  });

  it('does not start a repair the time budget cannot fit, and keeps the failure verdict', async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    verifyMock.mockImplementation(async () => { offset = 10 * 60_000; return failing; });
    try {
      const { chat } = scriptedChat();
      const events: LoopEvent[] = [];
      for await (const event of queryLoop(
        { model: 'm', systemPrompt: 'system', maxTurns: 8, maxTimeMs: 60_000, supervisor: false, verify: { enabled: true } },
        { client: { chat } as never, tools: [writeTool] },
        [{ role: 'user', content: 'fix a.ts' }],
      )) events.push(event);
      expect(verifyMock).toHaveBeenCalledTimes(1);
      expect(events.find((e) => e.type === 'done')).toMatchObject({ reason: 'completed_with_test_failures' });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reports without repairing when repairAttempts is 0', async () => {
    verifyMock.mockResolvedValue(failing);
    const { events } = await run(0);
    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.type === 'done')).toMatchObject({ reason: 'completed_with_test_failures' });
  });

  it('does not treat checks that could not run as failures', async () => {
    verifyMock.mockResolvedValue({ ...failing, overall: 'skip', checks: [{ name: 'tests', domain: 'code', status: 'skip' }] });
    const { events } = await run();
    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.type === 'done')).toMatchObject({ reason: 'completed' });
  });

  it.each([
    ['git apply fix.patch', 1],
    ['npx prettier --write src', 1],
    ['git status', 0],
  ])('counts bash "%s" as a file change: %i verification(s)', async (command, expected) => {
    verifyMock.mockResolvedValue(passing);
    const bash: Tool = { name: 'bash', description: 'bash', parameters: { type: 'object', properties: {} }, isReadOnly: false, execute: async () => ({ success: true, output: 'ok' }) };
    let call = 0;
    const chat = jest.fn(async () => (++call === 1
      ? { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'bash', arguments: { command } } }] } as Message }
      : { message: { role: 'assistant', content: 'done' } as Message }));
    for await (const event of queryLoop(
      { model: 'm', systemPrompt: 'system', maxTurns: 4, supervisor: false, verify: { enabled: true } },
      { client: { chat } as never, tools: [bash] },
      [{ role: 'user', content: 'apply the patch' }],
    )) void event;
    expect(verifyMock).toHaveBeenCalledTimes(expected);
  });
});

describe('verificationRepairPrompt', () => {
  it('lists only failing checks', () => {
    const prompt = verificationRepairPrompt(failing.checks);
    expect(prompt).toContain('(typecheck)');
    expect(prompt).toContain('do not delete or skip tests');
  });
});
