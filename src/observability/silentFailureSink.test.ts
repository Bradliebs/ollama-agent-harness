import {
  recordSwallowed,
  getSwallowedFailures,
  getSwallowedFailureCount,
  _resetSwallowedFailuresForTest,
} from './silentFailureSink';

describe('silentFailureSink', () => {
  beforeEach(() => {
    _resetSwallowedFailuresForTest();
  });

  it('records a swallowed Error with message + label + timestamp', () => {
    recordSwallowed('emitEvent', new Error('disk full'));
    const failures = getSwallowedFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].label).toBe('emitEvent');
    expect(failures[0].message).toBe('disk full');
    expect(failures[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('stringifies non-Error rejection values', () => {
    recordSwallowed('saveSettings', 'EACCES');
    recordSwallowed('saveSettings', { code: 42 });
    const failures = getSwallowedFailures();
    expect(failures[0].message).toBe('EACCES');
    expect(failures[1].message).toBe('[object Object]');
  });

  it('preserves caller-supplied meta', () => {
    recordSwallowed('saveRuntimeRegistry', new Error('boom'), { path: '/x/y', attempt: 3 });
    expect(getSwallowedFailures()[0].meta).toEqual({ path: '/x/y', attempt: 3 });
  });

  it('caps the buffer at 200 entries (oldest evicted first)', () => {
    for (let i = 0; i < 250; i += 1) {
      recordSwallowed('test', new Error(`err-${i}`));
    }
    const failures = getSwallowedFailures();
    expect(failures).toHaveLength(200);
    // Oldest 50 should have been evicted.
    expect(failures[0].message).toBe('err-50');
    expect(failures[199].message).toBe('err-249');
    expect(getSwallowedFailureCount()).toBe(200);
  });

  it('never throws even with a hostile error object', () => {
    const hostile = {
      get message() { throw new Error('booby trap'); },
      toString() { throw new Error('also booby trap'); },
    };
    // Must not propagate. The sink protects callers absolutely.
    expect(() => recordSwallowed('hostile', hostile)).not.toThrow();
  });
});
