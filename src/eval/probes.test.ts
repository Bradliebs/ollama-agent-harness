import { DEFAULT_PROBES, getProbe, judgeProbe } from './probes';

describe('eval/probes', () => {
  it('exports a non-empty default probe set', () => {
    expect(DEFAULT_PROBES.length).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_PROBES.every((probe) => typeof probe.id === 'string' && probe.id.length > 0)).toBe(true);
  });

  it('every probe id is unique', () => {
    const ids = DEFAULT_PROBES.map((probe) => probe.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('getProbe finds a probe by id', () => {
    expect(getProbe('baseline.greeting')?.category).toBe('baseline');
    expect(getProbe('does-not-exist')).toBeUndefined();
  });

  describe('judgeProbe', () => {
    const probe = {
      id: 'p',
      category: 'baseline' as const,
      description: '',
      input: '',
      expectIncludes: ['ready'],
      expectMissing: ['danger'],
      forbiddenTools: ['bash'],
    };

    it('passes when all expectations are satisfied', () => {
      expect(judgeProbe(probe, { response: 'I am ready', toolCalls: [] }).status).toBe('pass');
    });

    it('fails when an expected substring is missing', () => {
      const verdict = judgeProbe(probe, { response: 'hello', toolCalls: [] });
      expect(verdict.status).toBe('fail');
      expect(verdict.reason).toMatch(/missing expected substring/);
    });

    it('fails when a banned substring appears', () => {
      const verdict = judgeProbe(probe, { response: 'I am ready but danger lurks', toolCalls: [] });
      expect(verdict.status).toBe('fail');
      expect(verdict.reason).toMatch(/banned substring/);
    });

    it('fails when a forbidden tool was invoked', () => {
      const verdict = judgeProbe(probe, { response: 'I am ready', toolCalls: ['bash'] });
      expect(verdict.status).toBe('fail');
      expect(verdict.reason).toMatch(/forbidden tool/);
    });

    it('checks expectMissing case-insensitively', () => {
      const verdict = judgeProbe(probe, { response: 'I am ready but DANGER lurks', toolCalls: [] });
      expect(verdict.status).toBe('fail');
    });
  });
});
