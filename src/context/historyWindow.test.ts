import type { Message } from 'ollama';
import { historyTokenBudget, selectHistoryWindow } from './historyWindow';

const turn = (i: number, chars = 400): Message => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `${i} `.padEnd(chars, 'x') });
const conversation = (count: number, chars = 400): Message[] => Array.from({ length: count }, (_, i) => turn(i, chars));

const options = { contextMaxTokens: 32_000, systemPromptTokens: 4_000, toolSchemaTokens: 10_000, newMessageTokens: 50 };

describe('history window', () => {
  it('budgets for the system prompt and tool definitions, under the snip threshold', () => {
    // transcript limit 22k (32k - 10k tools) * 0.65 = 14.3k, minus 4k system and the new message
    expect(Math.abs(historyTokenBudget(options) - 10_250)).toBeLessThanOrEqual(1);
    // The whole first-turn transcript stays under the loop's 70% snip threshold.
    const transcript = historyTokenBudget(options) + options.systemPromptTokens + options.newMessageTokens;
    expect(transcript / (options.contextMaxTokens - options.toolSchemaTokens)).toBeLessThan(0.7);
  });

  it('never lets tool definitions take more than half the limit', () => {
    expect(historyTokenBudget({ ...options, contextMaxTokens: 8_192, systemPromptTokens: 1_000 })).toBe(1_612);
  });

  it('keeps everything when it fits', () => {
    const history = conversation(10);
    expect(selectHistoryWindow(history, options)).toMatchObject({ dropped: 0, messages: history });
  });

  it('cuts on block boundaries so the resent prefix stays the same across several messages', () => {
    // 100 tokens per message; the budget fits ~102 messages, so the 50-message cap decides.
    const starts: number[] = [];
    for (let length = 52; length <= 64; length += 2) {
      starts.push(selectHistoryWindow(conversation(length), { ...options, alignment: 8 }).dropped);
    }
    expect(starts).toEqual([8, 8, 8, 8, 16, 16, 16]);
    for (const start of starts) expect(start % 8).toBe(0);
  });

  it('cuts on block boundaries when the token budget decides', () => {
    // 1000 tokens per message, budget ~10.25k: at most 10 messages.
    const window = selectHistoryWindow(conversation(23, 4_000), { ...options, alignment: 8 });
    expect(window.dropped).toBe(16);
    expect(window.messages).toHaveLength(7);
  });

  it('falls back to the largest unaligned suffix that fits when no aligned cut does', () => {
    const history = [...conversation(3), turn(3, 200_000)];
    const window = selectHistoryWindow(history, { ...options, alignment: 8 });
    expect(window.messages).toEqual([]);
    expect(window.dropped).toBe(4);
    const fits = selectHistoryWindow([turn(0, 200_000), ...conversation(3)], { ...options, alignment: 8 });
    expect(fits.dropped).toBe(1);
  });
});
