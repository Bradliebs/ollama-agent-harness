import type { ToolCall } from '../types';
import {
  stableArgsKey,
  createConsecutiveCallTracker,
  trackConsecutiveCall,
  resetConsecutiveCallTracker,
  createDuplicateResultTracker,
  trackResult,
  buildConsecutiveCallNudge,
  buildDuplicateResultNudge,
  DEFAULT_CONSECUTIVE_CALL_LIMIT,
  DEFAULT_DUPLICATE_RESULT_LIMIT,
} from './toolLoopGuards';

const call = (name: string, input: Record<string, unknown>): ToolCall => ({
  name,
  input,
});

describe('stableArgsKey', () => {
  it('produces identical keys for objects with reordered keys', () => {
    expect(stableArgsKey({ a: 1, b: 2 })).toBe(stableArgsKey({ b: 2, a: 1 }));
  });

  it('handles nested objects', () => {
    const a = { outer: { x: 1, y: 2 }, n: 3 };
    const b = { n: 3, outer: { y: 2, x: 1 } };
    expect(stableArgsKey(a)).toBe(stableArgsKey(b));
  });

  it('preserves array order', () => {
    expect(stableArgsKey({ xs: [1, 2, 3] })).not.toBe(stableArgsKey({ xs: [3, 2, 1] }));
  });

  it('handles undefined input', () => {
    expect(stableArgsKey(undefined)).toBe('{}');
  });

  it('distinguishes different values', () => {
    expect(stableArgsKey({ a: 1 })).not.toBe(stableArgsKey({ a: 2 }));
  });
});

describe('trackConsecutiveCall', () => {
  it('counts consecutive identical calls', () => {
    const t = createConsecutiveCallTracker();
    expect(trackConsecutiveCall(t, call('read_file', { path: 'a.ts' }))).toBe(1);
    expect(trackConsecutiveCall(t, call('read_file', { path: 'a.ts' }))).toBe(2);
    expect(trackConsecutiveCall(t, call('read_file', { path: 'a.ts' }))).toBe(3);
  });

  it('resets count when args change', () => {
    const t = createConsecutiveCallTracker();
    trackConsecutiveCall(t, call('read_file', { path: 'a.ts' }));
    trackConsecutiveCall(t, call('read_file', { path: 'a.ts' }));
    expect(trackConsecutiveCall(t, call('read_file', { path: 'b.ts' }))).toBe(1);
  });

  it('resets count when tool changes', () => {
    const t = createConsecutiveCallTracker();
    trackConsecutiveCall(t, call('read_file', { path: 'a.ts' }));
    expect(trackConsecutiveCall(t, call('grep', { path: 'a.ts' }))).toBe(1);
  });

  it('treats key-reordered args as identical', () => {
    const t = createConsecutiveCallTracker();
    trackConsecutiveCall(t, call('grep', { pattern: 'x', path: 'a.ts' }));
    expect(trackConsecutiveCall(t, call('grep', { path: 'a.ts', pattern: 'x' }))).toBe(2);
  });

  it('resets explicitly via resetConsecutiveCallTracker', () => {
    const t = createConsecutiveCallTracker();
    trackConsecutiveCall(t, call('read_file', { path: 'a.ts' }));
    trackConsecutiveCall(t, call('read_file', { path: 'a.ts' }));
    resetConsecutiveCallTracker(t);
    expect(trackConsecutiveCall(t, call('read_file', { path: 'a.ts' }))).toBe(1);
  });
});

describe('trackResult', () => {
  it('returns 1 for the first observation', () => {
    const t = createDuplicateResultTracker();
    expect(trackResult(t, call('read_file', { path: 'a.ts' }), 'contents')).toBe(1);
  });

  it('returns 2 when same args produce same output twice', () => {
    const t = createDuplicateResultTracker();
    trackResult(t, call('read_file', { path: 'a.ts' }), 'contents');
    expect(trackResult(t, call('read_file', { path: 'a.ts' }), 'contents')).toBe(2);
  });

  it('resets when output changes for same args', () => {
    const t = createDuplicateResultTracker();
    trackResult(t, call('read_file', { path: 'a.ts' }), 'contents');
    trackResult(t, call('read_file', { path: 'a.ts' }), 'contents');
    expect(trackResult(t, call('read_file', { path: 'a.ts' }), 'different')).toBe(1);
  });

  it('tracks distinct (name, args) pairs independently', () => {
    const t = createDuplicateResultTracker();
    trackResult(t, call('read_file', { path: 'a.ts' }), 'contents');
    expect(trackResult(t, call('read_file', { path: 'b.ts' }), 'contents')).toBe(1);
    expect(trackResult(t, call('read_file', { path: 'a.ts' }), 'contents')).toBe(2);
  });
});

describe('nudge builders', () => {
  it('builds a non-empty consecutive-call nudge that names the tool and count', () => {
    const text = buildConsecutiveCallNudge(call('read_file', { path: 'a.ts' }), 3);
    expect(text).toContain('read_file');
    expect(text).toContain('3');
  });

  it('builds a non-empty duplicate-result nudge that names the tool and count', () => {
    const text = buildDuplicateResultNudge(call('grep', { pattern: 'x' }), 2);
    expect(text).toContain('grep');
    expect(text).toContain('2');
  });
});

describe('default thresholds', () => {
  it('exports sane defaults', () => {
    expect(DEFAULT_CONSECUTIVE_CALL_LIMIT).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_DUPLICATE_RESULT_LIMIT).toBeGreaterThanOrEqual(2);
  });
});
