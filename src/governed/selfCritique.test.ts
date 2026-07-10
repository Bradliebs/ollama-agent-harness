import { selfCritique } from './selfCritique';

describe('selfCritique', () => {
  it('passes a well-cited, fresh, brain-grounded answer', () => {
    const r = selfCritique({ confidenceMode: 'from-brain', citations: 3, oldestSourceAgeMs: 1000 });
    expect(r.overall).toBe('ok');
    expect(r.findings.find((f) => f.check === 'cited')?.status).toBe('ok');
    expect(r.findings.find((f) => f.check === 'fact-vs-judgement')?.status).toBe('ok');
  });

  it('flags an uncited needs-review answer for review', () => {
    const r = selfCritique({ confidenceMode: 'needs-review', citations: 0 });
    expect(r.overall).toBe('review');
    expect(r.findings.find((f) => f.check === 'cited')?.status).toBe('flag');
  });

  it('only warns (not flags) when an inferred answer is uncited', () => {
    const r = selfCritique({ confidenceMode: 'inferred', citations: 0 });
    expect(r.findings.find((f) => f.check === 'cited')?.status).toBe('warn');
    expect(r.overall).toBe('ok');
  });

  it('warns when the oldest source is stale', () => {
    const r = selfCritique({ confidenceMode: 'from-brain', citations: 1, oldestSourceAgeMs: 400 * 86_400_000 });
    expect(r.findings.find((f) => f.check === 'fresh')?.status).toBe('warn');
  });

  it('flags conflicting sources under what-would-make-this-wrong', () => {
    const r = selfCritique({ confidenceMode: 'needs-review', citations: 2, conflict: true });
    expect(r.findings.find((f) => f.check === 'what-would-make-this-wrong')?.status).toBe('flag');
    expect(r.overall).toBe('review');
  });

  it('warns when an answer rests on assumptions', () => {
    const r = selfCritique({ confidenceMode: 'inferred', citations: 1, assumptions: ['a', 'b'] });
    expect(r.findings.find((f) => f.check === 'what-would-make-this-wrong')?.status).toBe('warn');
  });
});
