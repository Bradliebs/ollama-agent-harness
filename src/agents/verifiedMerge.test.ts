import { planVerifiedMerge, type BranchVerification } from './verifiedMerge';

describe('planVerifiedMerge', () => {
  it('merges only branches that completed and verified pass; atomic gate true when all pass', () => {
    const branches: BranchVerification[] = [
      { id: 'a', completed: true, verification: 'pass' },
      { id: 'b', completed: true, verification: 'pass' },
    ];
    const plan = planVerifiedMerge(branches);
    expect(plan.mergeable.map((d) => d.id)).toEqual(['a', 'b']);
    expect(plan.rejected).toHaveLength(0);
    expect(plan.allVerified).toBe(true);
  });

  it('rejects a failed branch, keeps the passing one, and drops the atomic gate', () => {
    const plan = planVerifiedMerge([
      { id: 'a', completed: true, verification: 'pass' },
      { id: 'b', completed: true, verification: 'fail' },
    ]);
    expect(plan.mergeable.map((d) => d.id)).toEqual(['a']);
    expect(plan.rejected.map((d) => d.id)).toEqual(['b']);
    expect(plan.rejected[0].reason).toMatch(/verification failed/);
    expect(plan.allVerified).toBe(false);
  });

  it('does not merge a completed-but-unverified branch (no verdict = no proof)', () => {
    const plan = planVerifiedMerge([{ id: 'a', completed: true }]);
    expect(plan.mergeable).toHaveLength(0);
    expect(plan.rejected[0].reason).toMatch(/unverified/);
    expect(plan.allVerified).toBe(false);
  });

  it('does not merge an incomplete branch', () => {
    const plan = planVerifiedMerge([{ id: 'a', completed: false, verification: 'pass' }]);
    expect(plan.mergeable).toHaveLength(0);
    expect(plan.rejected[0].reason).toMatch(/did not complete/);
    expect(plan.allVerified).toBe(false);
  });

  it('treats warn and skip as not-proven and rejects both', () => {
    const plan = planVerifiedMerge([
      { id: 'w', completed: true, verification: 'warn' },
      { id: 's', completed: true, verification: 'skip' },
    ]);
    expect(plan.mergeable).toHaveLength(0);
    expect(plan.rejected.map((d) => d.id)).toEqual(['w', 's']);
    expect(plan.rejected[0].reason).toMatch(/warned/);
    expect(plan.rejected[1].reason).toMatch(/skipped/);
    expect(plan.allVerified).toBe(false);
  });

  it('returns a safe default for an empty branch set (nothing to merge)', () => {
    const plan = planVerifiedMerge([]);
    expect(plan.mergeable).toHaveLength(0);
    expect(plan.rejected).toHaveLength(0);
    expect(plan.allVerified).toBe(false);
  });
});
