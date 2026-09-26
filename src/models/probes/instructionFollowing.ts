import type { IChatClient } from '../../core/chatClient';
import {
  addTokens,
  assertNotAborted,
  emptyTokens,
  makeResult,
  sampleLimit,
  tokenBudgetExceeded,
  type Probe,
  type ProbeRunOptions,
} from './types';

const CASES: Array<{ prompt: string; check: (text: string) => boolean }> = [
  {
    prompt: 'Reply with exactly three words.',
    check: (text) => text.trim().split(/\s+/).filter(Boolean).length === 3,
  },
  {
    prompt: 'Reply with the exact token BLUEBIRD in all caps and no other text.',
    check: (text) => text.trim() === 'BLUEBIRD',
  },
  {
    prompt: 'Reply in exactly two bullet lines. Each line must start with "- ".',
    check: (text) => text.trim().split(/\r?\n/).length === 2
      && text.trim().split(/\r?\n/).every((line) => line.startsWith('- ')),
  },
  {
    prompt: 'Reply with a sentence that includes apple and excludes banana.',
    check: (text) => /\bapple\b/i.test(text) && !/\bbanana\b/i.test(text),
  },
  {
    prompt: 'Reply with exactly five uppercase letters, no punctuation.',
    check: (text) => /^[A-Z]{5}$/.test(text.trim()),
  },
];

export const instructionFollowingProbe: Probe = {
  id: 'instructionFollowing',
  defaultSamples: 5,
  defaultTokenBudget: 2000,
  async run(client: IChatClient, opts?: ProbeRunOptions) {
    const started = performance.now();
    const tokens = emptyTokens();
    const samples = Math.min(sampleLimit(opts, this.defaultSamples), CASES.length);
    let passed = 0;
    let attempted = 0;

    for (const testCase of CASES.slice(0, samples)) {
      assertNotAborted(opts?.signal);
      if (tokenBudgetExceeded(tokens, opts)) break;
      const result = await client.chat([
        { role: 'system', content: 'Follow the user constraint exactly. Do not explain.' },
        { role: 'user', content: testCase.prompt },
      ], undefined, opts?.signal);
      addTokens(tokens, result.usage);
      attempted++;
      if (testCase.check(String(result.message.content ?? ''))) passed++;
    }

    return makeResult(this.id, attempted > 0 ? passed / attempted : 0, attempted, { passed }, tokens, started);
  },
};
