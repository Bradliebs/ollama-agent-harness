// Independent verification of research answers.
//
// Runs when an answer was built from pages the agent read:
//   1. an in-process figure check (claimCheck.ts), always;
//   2. optionally a critic model from a different family judging each flagged
//      claim against the best-matching source excerpts.
// The result is a verification verdict plus, when something is unsupported,
// a short annotation for the answer and a revision prompt for gate mode.

import type { Message } from 'ollama';
import type { IChatClient } from '../core/chatClient';
import { bestExcerpts, checkClaims, type Claim } from './claimCheck';

/**
 * off: nothing. check (default): record a verdict, answer unchanged.
 * annotate: also append an unverified-claims note. critic: annotate, with a
 * different-family critic judging flagged claims. gate: critic, plus one
 * revision before an answer with unsupported claims is accepted.
 */
export type ResearchVerifyMode = 'off' | 'check' | 'annotate' | 'critic' | 'gate';

export interface CriticAccess {
  candidates: string[];
  createClient: (model: string) => IChatClient | Promise<IChatClient>;
}

export interface CriticJudgement {
  claim: string;
  verdict: 'supported' | 'contradicted' | 'not_found' | 'error';
  reason: string;
  critic?: string;
}

export interface ResearchVerdict {
  status: 'pass' | 'warn' | 'fail' | 'skip';
  checkedClaims: number;
  unsupported: Array<{ claim: string; missing: string[] }>;
  judgements: CriticJudgement[];
  critic?: string;
  summary: string;
}

const MAX_CRITIC_CLAIMS = 5;

export function resolveResearchVerifyMode(env = process.env.HARNESS_VERIFY_RESEARCH): ResearchVerifyMode {
  const value = env?.trim().toLowerCase();
  if (value === 'off' || value === '0' || value === 'false') return 'off';
  if (value === 'annotate' || value === 'critic' || value === 'gate') return value;
  return 'check';
}

function parseJudgement(text: string): { verdict: CriticJudgement['verdict']; reason: string } {
  const upper = text.toUpperCase();
  const verdict = upper.includes('CONTRADICTED') ? 'contradicted' : upper.includes('NOT_FOUND') || upper.includes('NOT FOUND') ? 'not_found' : upper.includes('SUPPORTED') ? 'supported' : 'not_found';
  const reason = text.replace(/^\s*(SUPPORTED|CONTRADICTED|NOT_FOUND|NOT FOUND)\s*[:\-–]?\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return { verdict, reason };
}

async function judgeWithCritic(claims: Claim[], sources: string[], critic: CriticAccess, signal?: AbortSignal): Promise<{ judgements: CriticJudgement[]; critic?: string }> {
  for (const model of critic.candidates) {
    let client: IChatClient;
    try {
      client = await critic.createClient(model);
    } catch {
      continue;
    }
    const judgements: CriticJudgement[] = [];
    let failedModel = false;
    for (const claim of claims.slice(0, MAX_CRITIC_CLAIMS)) {
      const excerpts = bestExcerpts(claim.text, sources);
      const messages: Message[] = [
        { role: 'system', content: 'You are a strict fact checker. Judge ONLY against the excerpts given. Reply with one word, SUPPORTED, CONTRADICTED or NOT_FOUND, then a colon and a reason of at most 20 words.' },
        { role: 'user', content: `Claim: ${claim.text}\n\nExcerpts:\n${excerpts.map((excerpt, i) => `[${i + 1}] ${excerpt}`).join('\n\n') || '(no relevant excerpt found)'}` },
      ];
      try {
        const result = await client.chat(messages, undefined, signal);
        const text = typeof result.message.content === 'string' ? result.message.content : '';
        judgements.push({ claim: claim.text, ...parseJudgement(text), critic: model });
      } catch {
        if (judgements.length === 0) { failedModel = true; break; }
        judgements.push({ claim: claim.text, verdict: 'error', reason: 'critic call failed', critic: model });
      }
    }
    if (!failedModel) return { judgements, critic: model };
  }
  return { judgements: [] };
}

/** Verify a research answer against the source texts the agent read. */
export async function verifyResearchAnswer(input: {
  answer: string;
  sources: string[];
  trusted?: string[];
  mode: ResearchVerifyMode;
  critic?: CriticAccess;
  signal?: AbortSignal;
}): Promise<ResearchVerdict> {
  if (input.mode === 'off' || input.sources.length === 0 || !input.answer.trim()) {
    return { status: 'skip', checkedClaims: 0, unsupported: [], judgements: [], summary: 'No sources to verify against.' };
  }
  const report = checkClaims(input.answer, input.sources, input.trusted);
  const unsupported = report.unsupported.map((entry) => ({ claim: entry.claim.text, missing: entry.missing }));
  let judgements: CriticJudgement[] = [];
  let criticModel: string | undefined;
  if ((input.mode === 'critic' || input.mode === 'gate') && input.critic && input.critic.candidates.length > 0) {
    // The critic looks at flagged figures first, then claims the figure check could not cover.
    const toJudge = [...report.unsupported.map((entry) => entry.claim), ...report.unchecked];
    if (toJudge.length > 0) {
      const judged = await judgeWithCritic(toJudge, input.sources, input.critic, input.signal);
      judgements = judged.judgements;
      criticModel = judged.critic;
    }
  }
  const contradicted = judgements.filter((judgement) => judgement.verdict === 'contradicted');
  // A figure the critic finds supported (e.g. phrased differently) is cleared.
  const clearedByCritic = new Set(judgements.filter((judgement) => judgement.verdict === 'supported').map((judgement) => judgement.claim));
  const stillUnsupported = unsupported.filter((entry) => !clearedByCritic.has(entry.claim));
  const checkedClaims = report.checked.length + judgements.filter((judgement) => !report.checked.some((entry) => entry.claim.text === judgement.claim)).length;
  const status: ResearchVerdict['status'] = contradicted.length > 0 ? 'fail' : stillUnsupported.length > 0 ? 'warn' : checkedClaims > 0 ? 'pass' : 'skip';
  const summary = status === 'pass'
    ? `All ${checkedClaims} checked claim(s) are supported by the pages read.`
    : status === 'skip'
      ? 'No checkable claims.'
      : `${contradicted.length} contradicted, ${stillUnsupported.length} unsupported of ${checkedClaims} checked claim(s).`;
  return { status, checkedClaims, unsupported: stillUnsupported, judgements, ...(criticModel ? { critic: criticModel } : {}), summary };
}

/** Short note appended to the answer listing what could not be verified. */
export function annotateAnswer(answer: string, verdict: ResearchVerdict): string {
  if (verdict.status !== 'warn' && verdict.status !== 'fail') return answer;
  const contradicted = verdict.judgements.filter((judgement) => judgement.verdict === 'contradicted');
  const lines = [
    ...contradicted.slice(0, 3).map((judgement) => `- Contradicted by the sources: "${truncate(judgement.claim)}"${judgement.reason ? ` (${judgement.reason})` : ''}`),
    ...verdict.unsupported.slice(0, 4).map((entry) => `- Not found in the pages read: ${entry.missing.join(', ')} in "${truncate(entry.claim)}"`),
  ];
  if (lines.length === 0) return answer;
  const who = verdict.critic ? ` (checked by ${verdict.critic})` : '';
  return `${answer.trimEnd()}\n\n> ⚠️ **Verification${who}:** some details could not be confirmed against the sources.\n${lines.map((line) => `> ${line}`).join('\n')}`;
}

/** Instruction for one bounded revision in gate mode. */
export function revisionPrompt(verdict: ResearchVerdict): string {
  const items = [
    ...verdict.judgements.filter((judgement) => judgement.verdict === 'contradicted').map((judgement) => `- "${truncate(judgement.claim)}" is contradicted: ${judgement.reason}`),
    ...verdict.unsupported.map((entry) => `- ${entry.missing.join(', ')} in "${truncate(entry.claim)}" does not appear in any page you read`),
  ].slice(0, 6);
  return `Before answering, fix these claims that the sources you read do not support:\n${items.join('\n')}\nCorrect or remove them, or read a source that supports them. Then write the final answer.`;
}

function truncate(text: string, max = 140): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
