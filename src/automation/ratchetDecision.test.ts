/**
 * Coverage for cookbook/task-loop.ts decideRatchet — the AutoResearch-style
 * keep/revert gate for one autonomy iteration.
 *
 * The harness honesty rule: no "done" without proof a check actually ran.
 * A task ratchets forward ONLY when the implement step did not throw,
 * validation passed, and — for code tasks — the work changed files. Every
 * other path reverts with an honest reason and a null `earnedBy` (nothing
 * earned the keep). On a keep, `earnedBy` names the check that proved it.
 */
import { decideRatchet } from '../../cookbook/task-loop';

describe('cookbook/task-loop decideRatchet', () => {
  it('keeps a code task that validated and changed files, naming the check', () => {
    const d = decideRatchet({
      errored: false,
      validated: true,
      kind: 'code',
      changedFileCount: 3,
      validateLabel: 'npm run typecheck',
    });
    expect(d.outcome).toBe('keep');
    expect(d.code).toBe('kept');
    expect(d.earnedBy).toBe('npm run typecheck passed with 3 file change(s)');
    expect(d.reason).toBe('npm run typecheck passed with 3 file change(s)');
  });

  it('defaults missing kind to the code contract (requires file changes)', () => {
    const kept = decideRatchet({ errored: false, validated: true, changedFileCount: 1 });
    expect(kept.outcome).toBe('keep');

    const reverted = decideRatchet({ errored: false, validated: true, changedFileCount: 0 });
    expect(reverted.outcome).toBe('revert');
    expect(reverted.code).toBe('no-file-changes');
  });

  it('keeps a research task that validated even with 0 file changes', () => {
    const d = decideRatchet({
      errored: false,
      validated: true,
      kind: 'research',
      changedFileCount: 0,
      validateLabel: 'npm test',
    });
    expect(d.outcome).toBe('keep');
    expect(d.earnedBy).toBe('npm test passed (research task — no file changes required)');
  });

  it('keeps an external task that validated even with 0 in-repo file changes', () => {
    // External tasks routinely write outside PROJECT_DIR (e.g. into H:\Model),
    // so requiring an in-repo file change would silently revert genuine work.
    const d = decideRatchet({
      errored: false,
      validated: true,
      kind: 'external',
      changedFileCount: 0,
      validateLabel: 'npm test',
    });
    expect(d.outcome).toBe('keep');
    expect(d.earnedBy).toBe('npm test passed (external task — no file changes required)');
  });

  it('reverts when the implement step threw — nothing earned the keep', () => {
    const d = decideRatchet({ errored: true, validated: false, kind: 'code', changedFileCount: 5 });
    expect(d.outcome).toBe('revert');
    expect(d.code).toBe('errored');
    expect(d.earnedBy).toBeNull();
  });

  it('reverts when validation failed', () => {
    const d = decideRatchet({
      errored: false,
      validated: false,
      kind: 'code',
      changedFileCount: 4,
      validateLabel: 'npm run typecheck',
    });
    expect(d.outcome).toBe('revert');
    expect(d.code).toBe('validation-failed');
    expect(d.reason).toBe('npm run typecheck failed — not keeping unproven work');
    expect(d.earnedBy).toBeNull();
  });

  it('reverts a code task that validated clean but changed 0 files', () => {
    const d = decideRatchet({ errored: false, validated: true, kind: 'code', changedFileCount: 0 });
    expect(d.outcome).toBe('revert');
    expect(d.code).toBe('no-file-changes');
    expect(d.reason).toBe('validation passed but the task changed 0 files — no work to keep');
    expect(d.earnedBy).toBeNull();
  });

  it('falls back to a generic check label when none is supplied', () => {
    const d = decideRatchet({ errored: false, validated: true, kind: 'code', changedFileCount: 2 });
    expect(d.earnedBy).toBe('validation passed with 2 file change(s)');
  });
});
