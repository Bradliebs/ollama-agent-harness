import { aggregateReplicates } from './benchmark';
import type { BenchmarkTaskResult } from './benchmark';

// ─── aggregateReplicates ─────────────────────────────────────────────
//
// Replicate aggregation must keep ONE verdict per task (so the McNemar test
// downstream sees the same number of cells regardless of replicate count — no
// pseudoreplication). These tests pin the majority-vote semantics and the
// honest cost/transparency bookkeeping.

const base = (overrides: Partial<BenchmarkTaskResult>): BenchmarkTaskResult => ({
  taskId: 'ext.example',
  tier: 'adversarial',
  description: 'example task',
  status: 'pass',
  reason: 'ok',
  responsePreview: 'preview',
  toolCalls: [],
  durationMs: 100,
  tags: ['holdout'],
  ...overrides,
});

describe('aggregateReplicates', () => {
  it('throws on an empty replicate set', () => {
    expect(() => aggregateReplicates([])).toThrow(/at least one replicate/);
  });

  it('passes when a strict majority of replicates pass', () => {
    const result = aggregateReplicates([
      base({ status: 'pass' }),
      base({ status: 'pass' }),
      base({ status: 'fail', failureCategory: 'WRONG_ANSWER', reason: 'bad' }),
    ]);
    expect(result.status).toBe('pass');
    expect(result.passReplicates).toBe(2);
    expect(result.replicateCount).toBe(3);
    expect(result.failureCategory).toBeUndefined();
    expect(result.reason).toContain('2/3 replicates passed');
  });

  it('fails when fewer than half pass', () => {
    const result = aggregateReplicates([
      base({ status: 'pass' }),
      base({ status: 'fail', failureCategory: 'WRONG_ANSWER', reason: 'bad' }),
      base({ status: 'fail', failureCategory: 'WRONG_ANSWER', reason: 'bad' }),
    ]);
    expect(result.status).toBe('fail');
    expect(result.passReplicates).toBe(1);
    expect(result.failureCategory).toBe('WRONG_ANSWER');
  });

  it('treats an exact tie as a fail (requires STRICT majority to pass)', () => {
    const result = aggregateReplicates([
      base({ status: 'pass' }),
      base({ status: 'fail', failureCategory: 'NO_EVIDENCE', reason: 'bad' }),
    ]);
    expect(result.status).toBe('fail');
    expect(result.passReplicates).toBe(1);
  });

  it('reports error only when every replicate errored', () => {
    const allError = aggregateReplicates([
      base({ status: 'error', failureCategory: 'ERROR', reason: 'boom' }),
      base({ status: 'error', failureCategory: 'ERROR', reason: 'boom' }),
    ]);
    expect(allError.status).toBe('error');

    const someError = aggregateReplicates([
      base({ status: 'pass' }),
      base({ status: 'pass' }),
      base({ status: 'error', failureCategory: 'ERROR', reason: 'boom' }),
    ]);
    expect(someError.status).toBe('pass');
  });

  it('picks the modal failure category among non-passing replicates', () => {
    const result = aggregateReplicates([
      base({ status: 'fail', failureCategory: 'HALLUCINATED_API', reason: 'a' }),
      base({ status: 'fail', failureCategory: 'HALLUCINATED_API', reason: 'b' }),
      base({ status: 'fail', failureCategory: 'WRONG_ANSWER', reason: 'c' }),
    ]);
    expect(result.status).toBe('fail');
    expect(result.failureCategory).toBe('HALLUCINATED_API');
  });

  it('sums tool calls and duration so budget gates see the honest total cost', () => {
    const result = aggregateReplicates([
      base({ toolCalls: ['search'], durationMs: 100 }),
      base({ toolCalls: ['search', 'read'], durationMs: 250 }),
    ]);
    expect(result.toolCalls).toHaveLength(3);
    expect(result.durationMs).toBe(350);
  });
});
