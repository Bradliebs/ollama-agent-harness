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

export const DEFAULT_MAX_CONTEXT_TOKENS = 32_000;
const POSITIONS = [0.1, 0.5, 0.9];

/**
 * The context window (num_ctx) to run the probe with: enough for the longest
 * haystack plus headroom, never more than the model supports. Smaller than
 * that and the backend truncates the prompt, which reads as a false limit;
 * the model's full native window (often 128k+) would allocate a huge KV cache
 * on local backends for nothing.
 */
export function probeContextWindow(detected: number | null | undefined, maxContextTokens?: number): number {
  const needed = Math.ceil(Math.max(512, maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS) * 1.25) + 512;
  return detected && detected > 0 ? Math.min(detected, needed) : needed;
}

// Common words that are one token each in the usual tokenizers, so the
// haystack's word count is close to its real token count.
const FILLER_WORDS = ('time year people way day man thing woman life child world school state family student group country '
  + 'problem hand part place case week company system program question work government number night point home water room '
  + 'mother area money story fact month lot right study book eye job word business issue side kind head house service friend '
  + 'father power hour game line end member law car city community name president team minute idea kid body information back '
  + 'parent face others level office door health person art war history party result change morning reason research girl guy '
  + 'moment air teacher force education').split(' ');

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
    // Real prompt tokens the model handled at `largest`, when the backend
    // reports them: the filler haystack is sized in words, and a word is
    // usually more than one token.
    let largestPromptTokens = 0;
    let attempted = 0;
    // Only a length where retrieval actually failed is a measured limit. If the
    // probe ran out of lengths or token budget first, `largest` is a lower bound.
    let failedAt: number | null = null;
    const perLength: Array<{ length: number; successes: number }> = [];

    for (const length of lengths) {
      let successes = 0;
      let attemptsAtLength = 0;
      let promptTokensAtLength = 0;
      for (const position of POSITIONS) {
        assertNotAborted(opts?.signal);
        if (tokenBudgetExceeded(tokens, opts)) break;
        attemptsAtLength++;
        const needle = `NEEDLE_${length}_${Math.round(position * 100)}_VALUE`;
        const haystack = makeHaystack(length, needle, position);
        const result = await client.chat([
          { role: 'system', content: 'Return only the exact needle value requested. No explanation.' },
          { role: 'user', content: `${haystack}\n\nWhat is the exact NEEDLE value in the text above?` },
        ], undefined, opts?.signal);
        addTokens(tokens, result.usage);
        attempted++;
        const promptTokens = Number(result.usage?.promptTokens ?? 0);
        if (Number.isFinite(promptTokens)) promptTokensAtLength = Math.max(promptTokensAtLength, promptTokens);
        if (String(result.message.content ?? '').includes(needle)) successes++;
      }
      perLength.push({ length, successes });
      if (successes >= 2) {
        largest = length;
        largestPromptTokens = promptTokensAtLength;
        continue;
      }
      // Fewer than 2 of 3 positions retrieved is a failure only when all three
      // were attempted; a budget stop mid-length says nothing about the model.
      if (attemptsAtLength === POSITIONS.length) failedAt = length;
      break;
    }

    return makeResult(this.id, cap > 0 ? largest / cap : 0, attempted, {
      usableContextTokens: Math.max(largest, largestPromptTokens),
      detectedContextTokens: detected,
      cap,
      perLength,
      measuredLimit: failedAt !== null,
      failedAtTokens: failedAt,
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
  const words = Array.from({ length: Math.max(16, approxTokens - 24) }, (_, i) => FILLER_WORDS[i % FILLER_WORDS.length]);
  const index = Math.max(0, Math.min(words.length, Math.floor(words.length * position)));
  words.splice(index, 0, `The exact NEEDLE value is ${needle}.`);
  return words.join(' ');
}
