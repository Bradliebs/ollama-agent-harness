import type { Message } from 'ollama';
import type { IChatClient } from '../core/chatClient';
import { checkClaims, extractClaims, normalizeFigure } from './claimCheck';
import { modelFamily, selectCriticCandidates } from './criticModel';
import { annotateAnswer, resolveResearchVerifyMode, revisionPrompt, verifyResearchAnswer } from './researchVerifier';

const source = 'Fujifilm X100VI price comparison. Best price £1,669.28 from 10 UK retailers. Black edition £1,749. Released February 2024. Used from £1,636.';
const answer = [
  'The Fujifilm X100VI currently sells new in the UK for **£1,669.28** (silver), up to £1,749 for black.',
  '| Model | Price |',
  '| --- | --- |',
  '| X100VI used | £1,636 |',
  '| Nikon ZR | £1,999 |',
  'It launched in 2024 and has held its value well.',
  '',
  '**Sources**',
  '1. [idealo](https://www.idealo.co.uk/compare/203879995/fujifilm-x100vi.html)',
].join('\n');

describe('claim checks', () => {
  it('normalises figures', () => {
    expect(normalizeFigure('£1,669.28')).toEqual(['1669.28', '1669']);
    expect(normalizeFigure('24%')).toEqual(['24%']);
    expect(normalizeFigure('abc')).toEqual([]);
  });

  it('extracts figure-bearing claims, including table rows, and ignores the Sources footer and URLs', () => {
    const { withFigures } = extractClaims(answer);
    expect(withFigures.map((claim) => claim.figures)).toEqual([['1669.28', '1749'], ['1636'], ['1999'], ['2024']]);
    expect(withFigures.some((claim) => claim.text.includes('203879995'))).toBe(false);
  });

  it('flags figures that appear in none of the sources, and trusts the user question', () => {
    const report = checkClaims(answer, [source]);
    expect(report.unsupported.map((entry) => entry.missing)).toEqual([['1999']]);
    expect(checkClaims(answer, [source], ['Is the Nikon ZR still £1,999?']).unsupported).toEqual([]);
  });

  it('matches a rounded figure against a decimal in the source', () => {
    expect(checkClaims('It costs about £1,669 new today.', [source]).unsupported).toEqual([]);
  });

  it('treats savings and percentages computed from sourced figures as derived, but not years or unrelated numbers', () => {
    const report = checkClaims('New is £1,749 and used is £1,636. Buying used saves you £113, about 6.5% less than new. It was founded in 1969.', [source]);
    expect(report.checked.flatMap((entry) => entry.derived)).toEqual(['113', '6.5%']);
    expect(report.unsupported.map((entry) => entry.missing)).toEqual([['1969']]);
    expect(checkClaims('Buying used saves you £400.', [source]).unsupported.map((entry) => entry.missing)).toEqual([['400']]);
  });

  it('compares phone numbers by digits and ignores HTTP status codes', () => {
    const page = 'Call us on 020 8611 8967 any time.';
    expect(checkClaims('Phone them on +44 208 611 8967, open 24/7.', [page]).unsupported).toEqual([]);
    expect(checkClaims('Phone them on +44 208 611 9999 today.', [page]).unsupported.map((entry) => entry.missing)).toEqual([['tel:086119999']]);
    expect(checkClaims('Trustpilot could not be read (403 blocked).', [page]).checked).toEqual([]);
  });
});

describe('critic selection', () => {
  it('derives model families', () => {
    expect(modelFamily('glm-5.3:cloud')).toBe('glm');
    expect(modelFamily('openrouter/anthropic/claude-sonnet-4.5')).toBe('claude');
    expect(modelFamily('qwen3.6:27b')).toBe('qwen');
    expect(modelFamily('ministral-3:8b')).toBe('mistral');
  });

  it('never picks the worker family, honours availability, and rejects a same-family override', () => {
    const selection = selectCriticCandidates('glm-5.3:cloud', { override: 'glm-5.1:cloud', available: ['glm-5.3-flash:cloud', 'kimi-k3:cloud', 'minimax-m2.7:cloud'] });
    expect(selection.candidates).toEqual(['minimax-m2.7:cloud', 'kimi-k3:cloud']);
    expect(selection.rejected).toMatch(/same family \(glm\)/);
    expect(selectCriticCandidates('kimi-k3:cloud', { override: 'qwen3.6:27b' }).candidates[0]).toBe('qwen3.6:27b');
  });
});

function critic(replies: Record<string, string | Error>) {
  const created: string[] = [];
  return {
    created,
    access: {
      candidates: Object.keys(replies),
      createClient: (model: string) => {
        created.push(model);
        return {
          chat: jest.fn(async (messages: Message[]) => {
            const reply = replies[model];
            if (reply instanceof Error) throw reply;
            const claim = String(messages[1].content);
            return { message: { role: 'assistant', content: claim.includes('Nikon ZR') ? 'CONTRADICTED: the excerpts list no £1,999 price' : reply } as Message };
          }),
        } as unknown as IChatClient;
      },
    },
  };
}

describe('verifyResearchAnswer', () => {
  it('annotate mode: warns about unsupported figures without calling a critic', async () => {
    const verdict = await verifyResearchAnswer({ answer, sources: [source], mode: 'annotate' });
    expect(verdict).toMatchObject({ status: 'warn', checkedClaims: 4, unsupported: [{ missing: ['1999'] }], judgements: [] });
    const annotated = annotateAnswer(answer, verdict);
    expect(annotated).toContain('> ⚠️ **Verification:** some details could not be confirmed');
    expect(annotated).toContain('Not found in the pages read: 1999');
  });

  it('critic mode: skips a failing critic, uses the next family, and reports contradictions', async () => {
    const c = critic({ 'retired:cloud': new Error('model was retired'), 'kimi-k3:cloud': 'SUPPORTED: matches the excerpt' });
    const verdict = await verifyResearchAnswer({ answer, sources: [source], mode: 'critic', critic: c.access });
    expect(c.created).toEqual(['retired:cloud', 'kimi-k3:cloud']);
    expect(verdict.critic).toBe('kimi-k3:cloud');
    expect(verdict.status).toBe('fail');
    expect(verdict.judgements.find((judgement) => judgement.claim.includes('Nikon ZR'))).toMatchObject({ verdict: 'contradicted' });
    expect(annotateAnswer(answer, verdict)).toContain('checked by kimi-k3:cloud');
    expect(revisionPrompt(verdict)).toMatch(/is contradicted/);
  });

  it('passes a fully supported answer and skips when there are no sources or it is off', async () => {
    const supported = await verifyResearchAnswer({ answer: 'The X100VI is £1,669.28 new and £1,636 used.', sources: [source], mode: 'annotate' });
    expect(supported.status).toBe('pass');
    expect(annotateAnswer('x', supported)).toBe('x');
    expect((await verifyResearchAnswer({ answer, sources: [], mode: 'annotate' })).status).toBe('skip');
    expect((await verifyResearchAnswer({ answer, sources: [source], mode: 'off' })).status).toBe('skip');
  });

  it('resolves the mode from the environment value', () => {
    expect(resolveResearchVerifyMode(undefined)).toBe('check');
    expect(resolveResearchVerifyMode('annotate')).toBe('annotate');
    expect(resolveResearchVerifyMode('gate')).toBe('gate');
    expect(resolveResearchVerifyMode('off')).toBe('off');
  });
});
