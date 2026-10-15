import type { Message } from 'ollama';
import { runInteractive } from './index';
import type { SessionStorage } from '../persistence/sessionStorage';

jest.mock('../learning/engine', () => ({ trackToolUsage: jest.fn().mockResolvedValue(undefined) }));

/** A readline stand-in that answers each prompt with the next scripted line. */
function scriptedReadline(lines: string[]) {
  const queue = [...lines];
  return {
    question: (_query: string, answer: (line: string) => void) => { answer(queue.shift() ?? '/quit'); },
    close: jest.fn(),
  };
}

describe('CLI interactive mode', () => {
  let log: jest.SpyInstance;
  beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => log.mockRestore());

  it('remembers earlier turns and forgets them after /clear', async () => {
    const seen: Message[][] = [];
    let reply = 0;
    const chat = jest.fn(async (messages: Message[]) => {
      seen.push(messages.filter((m) => m.role !== 'system'));
      reply += 1;
      return { message: { role: 'assistant', content: `answer ${reply}` } as Message };
    });
    const rl = scriptedReadline(['first question', 'and the follow-up?', '/clear', 'fresh start', '/quit']);

    await runInteractive(
      { model: 'm', systemPrompt: 'system', maxTurns: 2, supervisor: false },
      { client: { chat } as never, tools: [] },
      {} as SessionStorage,
      rl as never,
    );

    expect(seen[0]).toEqual([{ role: 'user', content: 'first question' }]);
    expect(seen[1]).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'answer 1' },
      { role: 'user', content: 'and the follow-up?' },
    ]);
    expect(seen[2]).toEqual([{ role: 'user', content: 'fresh start' }]);
    expect(rl.close).toHaveBeenCalled();
  });

  it('keeps going after a turn throws', async () => {
    const chat = jest.fn(async () => ({ message: { role: 'assistant', content: 'recovered' } as Message }));
    const rl = scriptedReadline(['first', 'second', '/quit']);
    let reads = 0;
    const config = {
      model: 'm', maxTurns: 2, supervisor: false as const,
      get systemPrompt(): string { reads += 1; if (reads === 1) throw new Error('context assembly failed'); return 'system'; },
    };

    await runInteractive(
      config,
      { client: { chat } as never, tools: [] },
      {} as SessionStorage,
      rl as never,
    );

    const printed = log.mock.calls.map((args) => String(args[0])).join('\n');
    expect(printed).toContain('The request failed: context assembly failed');
    expect(printed).toContain('recovered');
    expect(printed).toContain('Goodbye!');
  });
});
