import type { IChatClient } from '../../core/chatClient';
import {
  addTokens,
  assertNotAborted,
  emptyTokens,
  makeResult,
  tokenBudgetExceeded,
  type Probe,
  type ProbeRunOptions,
} from './types';

const DEFAULT_MAX_CONTEXT_TOKENS = 32_000;
const POSITIONS = [0.1, 0.5, 0.9];

export const usableContextProbe: Probe = {
  id: 'usableContext',
  defaultSamples: 15,
  defaultTokenBudget: 120_000,
  async run(client: IChatClient, opts?: ProbeRunOptions) {
    const started = performance.now();
    const tokens = emptyTokens();
    const detected = opts?.detectedContextTokens ?? await client.getContextWindow().catch(() => null);
    const cap = Math.max(512, Math.min(opts?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS, detected ?? DEFAULT_MAX_CONTEXT_TOKENS));
    const lengths = contextLengths(cap);
    let largest = 0;
    let attempted = 0;
    const perLength: Array<{ length: number; successes: number }> = [];

    for (const length of lengths) {
      let successes = 0;
      for (const position of POSITIONS) {
        assertNotAborted(opts?.signal);
        if (tokenBudgetExceeded(tokens, opts)) break;
        const needle = `NEEDLE_${length}_${Math.round(position * 100)}_VALUE`;
        const haystack = makeHaystack(length, needle, position);
        const result = await client.chat([
          { role: 'system', content: 'Return only the exact needle value requested. No explanation.' },
          { role: 'user', content: `${haystack}\n\nWhat is the exact NEEDLE value in the text above?` },
        ], undefined, opts?.signal);
        addTokens(tokens, result.usage);
        attempted++;
        if (String(result.message.content ?? '').includes(needle)) successes++;
      }
      perLength.push({ length, successes });
      if (successes >= 2) largest = length;
      else if (length > 1024) break;
    }

    return makeResult(this.id, cap > 0 ? largest / cap : 0, attempted, {
      usableContextTokens: largest,
      detectedContextTokens: detected,
      cap,
      perLength,
    }, tokens, started);
  },
};

function contextLengths(cap: number): number[] {
  const lengths: number[] = [];
  for (let value = 1024; value < cap; value *= 2) lengths.push(value);
  if (!lengths.includes(cap)) lengths.push(cap);
  return lengths;
}

function makeHaystack(approxTokens: number, needle: string, position: number): string {
  const words = Array.from({ length: Math.max(16, approxTokens - 24) }, (_, i) => `filler${i % 97}`);
  const index = Math.max(0, Math.min(words.length, Math.floor(words.length * position)));
  words.splice(index, 0, `The exact NEEDLE value is ${needle}.`);
  return words.join(' ');
}
