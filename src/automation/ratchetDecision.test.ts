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

  it('keeps an external task that wrote files into the external target folder', () => {
    // External tasks may write all their output outside PROJECT_DIR (e.g.
    // H:\Model). The ratchet keeps them on evidence in the external folder
    // even when in-repo file count is zero.
    const d = decideRatchet({
      errored: false,
      validated: true,
      kind: 'external',
      changedFileCount: 0,
      externalChangedFileCount: 5,
      validateLabel: 'npm test',
    });
    expect(d.outcome).toBe('keep');
    expect(d.code).toBe('kept');
    expect(d.earnedBy).toBe('npm test passed with 5 external file change(s) (external task)');
  });

  it('keeps an external task that wrote in-repo files even with 0 external changes', () => {
    const d = decideRatchet({
      errored: false,
      validated: true,
      kind: 'external',
      changedFileCount: 2,
      externalChangedFileCount: 0,
      validateLabel: 'npm test',
    });
    expect(d.outcome).toBe('keep');
    expect(d.earnedBy).toBe('npm test passed with 2 in-repo file change(s) (external task)');
  });

  it('reverts an external task that wrote 0 files anywhere — no rubber-stamping silent agents', () => {
    // The bug this test guards against: a kind:external task whose agent
    // aborted after 15 unproductive turns used to be "kept" with zero
    // evidence of work, because external tasks were exempted from the
    // file-count check entirely. "Until complete" must not mean "until
    // every task has been attempted once".
    const d = decideRatchet({
      errored: false,
      validated: true,
      kind: 'external',
      changedFileCount: 0,
      externalChangedFileCount: 0,
      validateLabel: 'npm test',
    });
    expect(d.outcome).toBe('revert');
    expect(d.code).toBe('no-file-changes');
    expect(d.reason).toBe('npm test passed but the external task wrote 0 files (in-repo or external) — no work to keep');
    expect(d.earnedBy).toBeNull();
  });

  it('reverts a code-requiring external task that wrote only documents', () => {
    // The bug this guards against: "Create the model implementation file"
    // satisfied by writing MODEL_STATUS.md when the real .py write was
    // blocked. A build task must produce code, not just a markdown report.
    const d = decideRatchet({
      errored: false,
      validated: true,
      kind: 'external',
      changedFileCount: 0,
      externalChangedFileCount: 2,
      requiresCode: true,
      codeFileCount: 0,
      validateLabel: 'npm test',
    });
    expect(d.outcome).toBe('revert');
    expect(d.code).toBe('no-code-changes');
    expect(d.reason).toBe('npm test passed but this build task wrote 2 file(s), none of them code — a build task must produce code, not just documents');
    expect(d.earnedBy).toBeNull();
  });

  it('keeps a code-requiring external task once it writes an actual code file', () => {
    const d = decideRatchet({
      errored: false,
      validated: true,
      kind: 'external',
      changedFileCount: 0,
      externalChangedFileCount: 1,
      requiresCode: true,
      codeFileCount: 1,
      validateLabel: 'npm test',
    });
    expect(d.outcome).toBe('keep');
    expect(d.code).toBe('kept');
  });

  it('keeps a documentation external task with zero code files (code not required)', () => {
    const d = decideRatchet({
      errored: false,
      validated: true,
      kind: 'external',
      changedFileCount: 0,
      externalChangedFileCount: 1,
      requiresCode: false,
      codeFileCount: 0,
      validateLabel: 'npm test',
    });
    expect(d.outcome).toBe('keep');
    expect(d.code).toBe('kept');
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
