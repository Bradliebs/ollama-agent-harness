// IChatClient-backed implementation of ModelJudgeFn.
//
// Lives in src/goal so callers can plug ANY IChatClient (Ollama, OpenAI,
// Cerebras, etc.) into a `model_judge` verification check. Stays at the
// boundary so src/goal/verification.ts itself remains client-agnostic.

import type { Message } from 'ollama';
import type { IChatClient } from '../core/chatClient';
import type { ModelJudgeFn } from './verification';

export interface MakeChatClientJudgeOptions {
  /** Override the prompt prefix; useful for tests or stricter rubrics. */
  systemPrompt?: string;
  /** Max characters of the model reply to keep as rationale. Defaults to 800. */
  maxRationaleChars?: number;
}

const DEFAULT_SYSTEM_PROMPT = [
  'You are an impartial verification judge.',
  'Given a goal target and a rubric, you decide how well the rubric is satisfied.',
  'You MUST reply with a single JSON object on one line and nothing else:',
  '{"score": <number between 0 and 1>, "rationale": "<one or two sentences>"}',
  'A score of 1.0 means the rubric is fully and convincingly satisfied.',
  'A score of 0.0 means it is not satisfied at all.',
  'If you are uncertain, score conservatively.',
].join(' ');

/**
 * Wrap an IChatClient as a ModelJudgeFn. The judge prompts the model with
 * the goal target + rubric and asks for a JSON {score, rationale}. Robust
 * against malformed output (returns score 0 with a parse-failure rationale).
 */
export function makeChatClientJudge(
  client: IChatClient,
  opts: MakeChatClientJudgeOptions = {},
): ModelJudgeFn {
  const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const maxRationaleChars = opts.maxRationaleChars ?? 800;

  return async (req) => {
    const userContent = [
      `GOAL TARGET: ${req.goalTarget}`,
      '',
      'RUBRIC:',
      req.rubric,
      '',
      'Reply with the JSON object now.',
    ].join('\n');

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ];

    let reply: string;
    try {
      const res = await client.chatOnce(messages);
      reply = (res.message.content ?? '').trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { score: 0, rationale: `judge call failed: ${msg.slice(0, maxRationaleChars)}` };
    }

    const parsed = parseJudgeReply(reply);
    if (!parsed) {
      const preview = reply.slice(0, maxRationaleChars);
      return { score: 0, rationale: `judge returned unparseable output: ${preview}` };
    }
    return {
      score: parsed.score,
      rationale: parsed.rationale.slice(0, maxRationaleChars),
    };
  };
}

interface ParsedJudgeReply {
  score: number;
  rationale: string;
}

/** Exported for tests. */
export function parseJudgeReply(raw: string): ParsedJudgeReply | null {
  if (!raw) return null;

  // Strip code fences if the model wrapped its JSON.
  const stripped = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();

  // Find the first balanced-ish JSON object.
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = stripped.slice(start, end + 1);

  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const score = typeof o.score === 'number' ? o.score : NaN;
  const rationale = typeof o.rationale === 'string' ? o.rationale : '';
  if (!Number.isFinite(score)) return null;
  // Clamp to [0, 1] — defensive, since some models drift.
  const clamped = Math.max(0, Math.min(1, score));
  return { score: clamped, rationale };
}
