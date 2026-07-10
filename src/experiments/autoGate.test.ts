import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  APPROVAL_MARKER_RELPATH,
  buildPromptGateManifest,
  DEFAULT_PROMPT_GATE_GUARDRAILS,
  gateEvolvedPrompt,
  hashPrompt,
  interpretGateResult,
  readApprovalMarker,
} from './autoGate';
import type { RunExperimentResult } from './runner';
import type { ExperimentExecutionRecord, ExperimentPromotionEvidence } from './types';

function makeRecord(evidence: ExperimentPromotionEvidence | undefined, id = 'exprun-test'): ExperimentExecutionRecord {
  return {
    id,
    manifest: buildPromptGateManifest({ basePrompt: 'base', candidatePrompt: 'cand', datasetId: 'ds' }),
    evaluator: { datasetId: 'ds', scorerVersion: 'auto-gate-1', taskIds: [], tiers: [] },
    promotionEvidence: evidence,
    dryRun: false,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
  };
}

function evidence(partial: Partial<ExperimentPromotionEvidence>): ExperimentPromotionEvidence {
  return {
    status: 'experiment_confirmed',
    candidateVariantId: 'autonomy-prompt-evolved',
    baselineVariantId: 'autonomy-prompt-baseline',
    automaticPromotionAllowed: true,
    reasons: [],
    passRateDelta: 0.1,
    netCandidateWins: 2,
    ...partial,
  };
}

describe('autoGate pure helpers', () => {
  it('hashPrompt is stable and content-sensitive', () => {
    expect(hashPrompt('hello')).toBe(hashPrompt('hello'));
    expect(hashPrompt('hello')).not.toBe(hashPrompt('hello '));
  });

  it('buildPromptGateManifest only mutates the prompt scope and rolls back to baseline', () => {
    const m = buildPromptGateManifest({ basePrompt: 'B', candidatePrompt: 'C', datasetId: 'ds' });
    expect(m.allowedMutationScopes).toEqual(['prompt']);
    expect(m.baseline.systemPrompt).toBe('B');
    expect(m.candidate.systemPrompt).toBe('C');
    expect(m.rollbackTarget).toBe('autonomy-prompt-baseline');
    expect(m.guardrails).toBe(DEFAULT_PROMPT_GATE_GUARDRAILS);
    expect(m.evaluation.datasetId).toBe('ds');
  });

  it('interpretGateResult promotes only when automaticPromotionAllowed', () => {
    expect(interpretGateResult(makeRecord(evidence({ automaticPromotionAllowed: true }))).promote).toBe(true);
    expect(interpretGateResult(makeRecord(evidence({ automaticPromotionAllowed: false }))).promote).toBe(false);
  });

  it('interpretGateResult rejects when promotion evidence is missing', () => {
    const v = interpretGateResult(makeRecord(undefined));
    expect(v.promote).toBe(false);
    expect(v.reasons[0]).toMatch(/No promotion evidence/);
  });
});

describe('gateEvolvedPrompt orchestration', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autogate-'));
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns unchanged when candidate equals baseline (no experiment run)', async () => {
    let called = false;
    const decision = await gateEvolvedPrompt({
      projectDir,
      basePrompt: 'same prompt',
      candidatePrompt: '  same prompt  ',
      datasetId: 'ds',
      runExperimentImpl: async () => {
        called = true;
        return { type: 'completed', record: makeRecord(evidence({})) };
      },
    });
    expect(decision.status).toBe('unchanged');
    expect(decision.prompt).toBe('same prompt');
    expect(called).toBe(false);
  });

  it('promotes the candidate and writes an approval marker on a guardrail-passing win', async () => {
    const decision = await gateEvolvedPrompt({
      projectDir,
      basePrompt: 'base',
      candidatePrompt: 'better candidate',
      datasetId: 'ds',
      now: () => new Date('2026-02-02T00:00:00.000Z'),
      runExperimentImpl: async () => ({
        type: 'completed',
        record: makeRecord(evidence({ automaticPromotionAllowed: true, passRateDelta: 0.2, netCandidateWins: 3 }), 'exprun-win'),
      }),
    });
    expect(decision.status).toBe('promoted');
    expect(decision.prompt).toBe('better candidate');

    const marker = await readApprovalMarker(projectDir);
    expect(marker).not.toBeNull();
    expect(marker!.approvedPromptHash).toBe(hashPrompt('better candidate'));
    expect(marker!.experimentId).toBe('exprun-win');
    expect(marker!.netCandidateWins).toBe(3);
    // Marker is physically on disk at the documented path.
    expect(fs.existsSync(path.join(projectDir, APPROVAL_MARKER_RELPATH))).toBe(true);
  });

  it('keeps the baseline and writes NO marker when guardrails reject', async () => {
    const decision = await gateEvolvedPrompt({
      projectDir,
      basePrompt: 'base',
      candidatePrompt: 'regressed candidate',
      datasetId: 'ds',
      runExperimentImpl: async () => ({
        type: 'completed',
        record: makeRecord(evidence({ status: 'experiment_regressed', automaticPromotionAllowed: false, reasons: ['safety regression'] })),
      }),
    });
    expect(decision.status).toBe('rejected');
    expect(decision.prompt).toBe('base');
    expect(decision.reasons).toContain('safety regression');
    expect(await readApprovalMarker(projectDir)).toBeNull();
  });

  it('fails closed (rejects, keeps baseline) when the experiment throws', async () => {
    const decision = await gateEvolvedPrompt({
      projectDir,
      basePrompt: 'base',
      candidatePrompt: 'candidate',
      datasetId: 'ds',
      runExperimentImpl: async () => {
        throw new Error('daemon offline');
      },
    });
    expect(decision.status).toBe('rejected');
    expect(decision.prompt).toBe('base');
    expect(decision.reasons[0]).toMatch(/daemon offline/);
    expect(await readApprovalMarker(projectDir)).toBeNull();
  });

  it('rejects a dry-run result (no completion)', async () => {
    const dryRun: RunExperimentResult = {
      type: 'dry_run',
      plan: {
        manifest: buildPromptGateManifest({ basePrompt: 'base', candidatePrompt: 'c', datasetId: 'ds' }),
        evaluator: { datasetId: 'ds', scorerVersion: 'auto-gate-1', taskIds: [], tiers: [] },
        selectedTaskCount: 0,
        selectedTaskIds: [],
        dryRun: true,
      },
    };
    const decision = await gateEvolvedPrompt({
      projectDir,
      basePrompt: 'base',
      candidatePrompt: 'candidate',
      datasetId: 'ds',
      runExperimentImpl: async () => dryRun,
    });
    expect(decision.status).toBe('rejected');
    expect(decision.prompt).toBe('base');
  });

  it('does not persist when persist=false', async () => {
    await gateEvolvedPrompt({
      projectDir,
      basePrompt: 'base',
      candidatePrompt: 'candidate',
      datasetId: 'ds',
      persist: false,
      runExperimentImpl: async () => ({ type: 'completed', record: makeRecord(evidence({ automaticPromotionAllowed: true })) }),
    });
    expect(await readApprovalMarker(projectDir)).toBeNull();
  });

  it('readApprovalMarker returns null when the marker is absent or malformed', async () => {
    expect(await readApprovalMarker(projectDir)).toBeNull();
    const markerPath = path.join(projectDir, APPROVAL_MARKER_RELPATH);
    await fsp.mkdir(path.dirname(markerPath), { recursive: true });
    await fsp.writeFile(markerPath, '{ not json', 'utf8');
    expect(await readApprovalMarker(projectDir)).toBeNull();
  });
});
