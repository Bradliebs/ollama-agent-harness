import { mergeVerified, type WorkstreamResult } from './orchestrator';

function result(over: Partial<WorkstreamResult> & Pick<WorkstreamResult, 'id'>): WorkstreamResult {
  return {
    role: 'coder',
    output: `output-${over.id}`,
    success: true,
    duration_ms: 1,
    ...over,
  };
}

describe('mergeVerified', () => {
  it('merges only branches that completed and verified pass', () => {
    const merged = mergeVerified([
      result({ id: 'a', verification: 'pass' }),
      result({ id: 'b', verification: 'pass' }),
    ]);
    expect(merged).toContain('output-a');
    expect(merged).toContain('output-b');
    expect(merged).not.toContain('Excluded');
  });

  it('excludes an unverified branch and lists the reason', () => {
    const merged = mergeVerified([
      result({ id: 'a', verification: 'pass' }),
      result({ id: 'b', verification: 'fail', output: 'broken-b' }),
    ]);
    expect(merged).toContain('output-a');
    expect(merged).not.toContain('broken-b');
    expect(merged).toContain('Excluded (unverified)');
    expect(merged).toMatch(/b: verification failed/);
  });

  it('does not merge a completed-but-unverified branch (no verdict = no proof)', () => {
    const merged = mergeVerified([result({ id: 'a' })]);
    expect(merged).toContain('(no verified workstreams to merge)');
    expect(merged).toMatch(/a: completed but unverified/);
  });

  it('returns a safe message when there is nothing to merge', () => {
    expect(mergeVerified([])).toBe('(no verified workstreams to merge)');
  });
});
