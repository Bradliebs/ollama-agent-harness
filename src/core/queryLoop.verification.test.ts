import type { Message } from 'ollama';
import { queryLoop, type QueryLoopDeps } from './queryLoop';
import type { LoopConfig, LoopEvent, Tool } from '../types';

jest.mock('../learning/engine', () => ({
  trackToolUsage: jest.fn().mockResolvedValue(undefined),
}));

const page = 'Fujifilm X100VI price comparison. Best price £1,669.28 from 10 UK retailers. Used from £1,636.';
const supported = 'The X100VI is £1,669.28 new and £1,636 used.';
const unsupported = 'The X100VI is £1,669.28 new, and the Nikon ZR is £1,999.';

function webRead(): Tool {
  return {
    name: 'web_read',
    description: 'read',
    parameters: { type: 'object', properties: { url: { type: 'string' } } },
    isReadOnly: true,
    execute: jest.fn(async () => ({ success: true, output: `Content from https://prices.example/x100vi:\n\n${page}` })),
  };
}

async function run(answers: string[], config: Partial<LoopConfig> = {}, deps: Partial<QueryLoopDeps> = {}, readFirst = true) {
  const replies: Message[] = [
    ...(readFirst ? [{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_read', arguments: { url: 'https://prices.example/x100vi' } } }] } as Message] : []),
    ...answers.map((content) => ({ role: 'assistant', content }) as Message),
  ];
  const seen: Message[][] = [];
  const client = { chat: jest.fn(async (messages: Message[]) => { seen.push(messages.map((message) => ({ ...message }))); return { message: replies.shift() as Message }; }) };
  const events: LoopEvent[] = [];
  for await (const event of queryLoop(
    { model: 'glm-5.3:cloud', systemPrompt: 'You are Moss.', maxTurns: 6, context: { enabled: false }, supervisor: false, verifyResearch: 'annotate', ...config },
    { client: client as never, tools: [webRead()], permissionCheck: async () => ({ allowed: true }), ...deps },
    [{ role: 'user', content: 'What does the Fujifilm X100VI cost in the UK?' }],
  )) events.push(event);
  const verifications = events.filter((event): event is Extract<LoopEvent, { type: 'verification' }> => event.type === 'verification');
  const texts = events.filter((event): event is Extract<LoopEvent, { type: 'text' }> => event.type === 'text');
  return { client, seen, verifications, finalText: String(texts[texts.length - 1]?.content ?? '') };
}

describe('queryLoop research verification', () => {
  it('annotates an answer whose figures are not in any page read', async () => {
    const { verifications, finalText } = await run([unsupported]);
    expect(verifications).toEqual([expect.objectContaining({ kind: 'research', overall: 'warn' })]);
    expect(finalText).toContain('Not found in the pages read: 1999');
    expect(finalText.indexOf('Verification')).toBeLessThan(finalText.indexOf('**Sources**'));
  });

  it('check mode (the default) records the verdict without changing the answer', async () => {
    const { verifications, finalText } = await run([unsupported], { verifyResearch: 'check' });
    expect(verifications).toEqual([expect.objectContaining({ kind: 'research', overall: 'warn' })]);
    expect(finalText).not.toContain('Verification');
    expect(finalText.startsWith(unsupported)).toBe(true);
  });

  it('leaves a supported answer unchanged and reports a pass', async () => {
    const { verifications, finalText } = await run([supported]);
    expect(verifications[0]).toMatchObject({ overall: 'pass' });
    expect(finalText).not.toContain('Verification');
    expect(finalText.startsWith(supported)).toBe(true);
  });

  it('does nothing when no pages were read or verification is off', async () => {
    expect((await run([unsupported], {}, {}, false)).verifications).toEqual([]);
    const off = await run([unsupported], { verifyResearch: 'off' });
    expect(off.verifications).toEqual([]);
    expect(off.finalText).not.toContain('Verification');
  });

  it('gate mode: asks for one revision, then accepts the corrected answer', async () => {
    const { client, seen, verifications, finalText } = await run([unsupported, supported], { verifyResearch: 'gate' });
    expect(client.chat).toHaveBeenCalledTimes(3);
    expect(String(seen[2][seen[2].length - 1].content)).toMatch(/1999 in .* does not appear in any page you read/);
    expect(verifications.map((event) => event.overall)).toEqual(['warn', 'pass']);
    expect(finalText.startsWith(supported)).toBe(true);
  });

  it('gate mode: revises at most once, then annotates', async () => {
    const { client, finalText } = await run([unsupported, unsupported], { verifyResearch: 'gate' });
    expect(client.chat).toHaveBeenCalledTimes(3);
    expect(finalText).toContain('Not found in the pages read: 1999');
  });

  it('critic mode: a different-family critic judges the flagged claim', async () => {
    const criticChat = jest.fn(async () => ({ message: { role: 'assistant', content: 'CONTRADICTED: no Nikon ZR price in the excerpts' } as Message }));
    const createClient = jest.fn(() => ({ chat: criticChat }) as never);
    const { verifications, finalText } = await run([unsupported], { verifyResearch: 'critic' }, { critic: { candidates: ['kimi-k3:cloud'], createClient } });
    expect(createClient).toHaveBeenCalledWith('kimi-k3:cloud');
    expect(verifications[0]).toMatchObject({ overall: 'fail', checks: [expect.objectContaining({ name: 'claims vs sources (critic kimi-k3:cloud)' })] });
    expect(finalText).toContain('Contradicted by the sources');
  });
});
