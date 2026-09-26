import type { IChatClient } from '../../core/chatClient';
import {
  addTokens,
  assertNotAborted,
  clampScore,
  emptyTokens,
  makeResult,
  objectSchema,
  sampleLimit,
  tokenBudgetExceeded,
  type Probe,
  type ProbeRunOptions,
} from './types';

const RESPONSE_SCHEMA = objectSchema({
  name: { type: 'string' },
  count: { type: 'number' },
  ok: { type: 'boolean' },
}, ['name', 'count', 'ok']);

const PROMPTS = [
  'Return only JSON for name "alpha", count 3, ok true.',
  'Return only JSON for name "bravo", count 7, ok false.',
  'Return only JSON for name "charlie", count 0, ok true.',
];

export const structuredOutputProbe: Probe = {
  id: 'structuredOutput',
  defaultSamples: 3,
  defaultTokenBudget: 2000,
  async run(client: IChatClient, opts?: ProbeRunOptions) {
    const started = performance.now();
    const tokens = emptyTokens();
    const samples = Math.min(sampleLimit(opts, this.defaultSamples), PROMPTS.length);
    let plain = 0;
    let constrained = 0;
    let attemptedPlain = 0;
    let attemptedConstrained = 0;

    for (const prompt of PROMPTS.slice(0, samples)) {
      assertNotAborted(opts?.signal);
      if (tokenBudgetExceeded(tokens, opts)) break;
      const result = await client.chat([{ role: 'user', content: `${prompt} Required keys: name:string, count:number, ok:boolean.` }], undefined, opts?.signal);
      addTokens(tokens, result.usage);
      attemptedPlain++;
      if (isValidStructuredJson(result.message.content)) plain++;
    }

    for (const prompt of PROMPTS.slice(0, samples)) {
      assertNotAborted(opts?.signal);
      if (tokenBudgetExceeded(tokens, opts)) break;
      const result = await client.chat(
        [{ role: 'user', content: `${prompt} Required keys: name:string, count:number, ok:boolean.` }],
        undefined,
        opts?.signal,
        { format: RESPONSE_SCHEMA, responseSchema: RESPONSE_SCHEMA },
      );
      addTokens(tokens, result.usage);
      attemptedConstrained++;
      if (isValidStructuredJson(result.message.content)) constrained++;
    }

    const structuredPlain = attemptedPlain > 0 ? plain / attemptedPlain : 0;
    const structuredConstrained = attemptedConstrained > 0 ? constrained / attemptedConstrained : 0;
    return makeResult(this.id, clampScore((structuredPlain + structuredConstrained) / 2), attemptedPlain + attemptedConstrained, {
      structuredPlain,
      structuredConstrained,
      schema: RESPONSE_SCHEMA,
    }, tokens, started);
  },
};

function isValidStructuredJson(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  const text = stripCodeFence(content.trim());
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return typeof parsed.name === 'string'
      && typeof parsed.count === 'number'
      && typeof parsed.ok === 'boolean';
  } catch {
    return false;
  }
}

function stripCodeFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : text;
}
