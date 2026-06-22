import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getApprovedAutonomyPrompt } from './autonomyPrompt';
import { hashPrompt, writeApprovalMarker, type PromptApprovalMarker } from './promptApproval';

function marker(hash: string): PromptApprovalMarker {
  return {
    approvedPromptHash: hash,
    approvedAt: '2026-01-01T00:00:00.000Z',
    experimentId: 'exprun-test',
    passRateDelta: 0.1,
    netCandidateWins: 2,
    reasons: ['confirmed'],
  };
}

describe('getApprovedAutonomyPrompt', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-'));
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns the baseline unchanged when the flag is off (default behaviour)', async () => {
    let evolvedCalled = false;
    const result = await getApprovedAutonomyPrompt({
      projectDir,
      basePrompt: 'BASE',
      // applyEvolvedPrompt omitted => default off
      getEvolvedPromptImpl: async (b) => {
        evolvedCalled = true;
        return b + '\nEVOLVED';
      },
    });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('flag-off');
    expect(result.prompt).toBe('BASE');
    expect(evolvedCalled).toBe(false);
  });

  it('returns the baseline when the evolved prompt is identical to base', async () => {
    const result = await getApprovedAutonomyPrompt({
      projectDir,
      basePrompt: 'BASE',
      applyEvolvedPrompt: true,
      getEvolvedPromptImpl: async () => '  BASE  ',
    });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('no-evolution');
    expect(result.prompt).toBe('BASE');
  });

  it('falls back to baseline when there is no approval marker', async () => {
    const result = await getApprovedAutonomyPrompt({
      projectDir,
      basePrompt: 'BASE',
      applyEvolvedPrompt: true,
      getEvolvedPromptImpl: async (b) => b + '\nEVOLVED',
    });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('not-approved');
    expect(result.prompt).toBe('BASE');
  });

  it('falls back to baseline when the approval hash is stale (evolved content drifted)', async () => {
    await writeApprovalMarker(projectDir, marker('deadbeef-not-the-current-hash'));
    const result = await getApprovedAutonomyPrompt({
      projectDir,
      basePrompt: 'BASE',
      applyEvolvedPrompt: true,
      getEvolvedPromptImpl: async (b) => b + '\nEVOLVED',
    });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('approval-stale');
    expect(result.prompt).toBe('BASE');
  });

  it('applies the evolved prompt when the flag is on and the approval hash matches', async () => {
    const evolved = 'BASE\nEVOLVED';
    await writeApprovalMarker(projectDir, marker(hashPrompt(evolved)));
    const result = await getApprovedAutonomyPrompt({
      projectDir,
      basePrompt: 'BASE',
      applyEvolvedPrompt: true,
      getEvolvedPromptImpl: async () => evolved,
    });
    expect(result.applied).toBe(true);
    expect(result.reason).toBe('approved');
    expect(result.prompt).toBe(evolved);
  });
});
