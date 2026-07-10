import {
  attachVerification,
  verifyCodeBranch,
  type BranchVerifier,
  type WorkstreamResult,
} from './orchestrator';

function result(over: Partial<WorkstreamResult> & Pick<WorkstreamResult, 'id'>): WorkstreamResult {
  return {
    role: 'coder',
    output: `output-${over.id}`,
    success: true,
    duration_ms: 1,
    ...over,
  };
}

describe('attachVerification', () => {
  it('attaches the verdict when a verifier proves a completed branch', async () => {
    const verify: BranchVerifier = async () => 'pass';
    const out = await attachVerification(result({ id: 'a' }), verify);
    expect(out.verification).toBe('pass');
  });

  it('attaches a failing verdict (earned, not assumed)', async () => {
    const verify: BranchVerifier = async () => 'fail';
    const out = await attachVerification(result({ id: 'a' }), verify);
    expect(out.verification).toBe('fail');
  });

  it('leaves the verdict absent when no verifier is supplied', async () => {
    const out = await attachVerification(result({ id: 'a' }), undefined);
    expect(out.verification).toBeUndefined();
  });

  it('does not verify a branch that did not complete', async () => {
    const verify: BranchVerifier = async () => 'pass';
    const out = await attachVerification(result({ id: 'a', success: false }), verify);
    expect(out.verification).toBeUndefined();
  });

  it('treats undefined from the verifier as "no proof", not a pass', async () => {
    const verify: BranchVerifier = async () => undefined;
    const out = await attachVerification(result({ id: 'a' }), verify);
    expect(out.verification).toBeUndefined();
  });

  it('never crashes a branch when the verifier throws', async () => {
    const verify: BranchVerifier = async () => {
      throw new Error('verifier blew up');
    };
    const out = await attachVerification(result({ id: 'a' }), verify);
    expect(out.verification).toBeUndefined();
    expect(out.success).toBe(true);
  });
});

describe('verifyCodeBranch (default verifier guards)', () => {
  it('returns no verdict for a non-code role even with a projectDir', async () => {
    const verdict = await verifyCodeBranch(result({ id: 'a', role: 'researcher' }), '/some/dir');
    expect(verdict).toBeUndefined();
  });

  it('returns no verdict when there is no projectDir to verify against', async () => {
    const verdict = await verifyCodeBranch(result({ id: 'a', role: 'coder' }), undefined);
    expect(verdict).toBeUndefined();
  });
});
