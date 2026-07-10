import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { readIdentityFile, writeIdentityFile } from './identity';
import { listIdentityHistory, loadIdentityHistory } from './identityHistory';
import {
  acceptSoulProposal,
  applyUserProposal,
  discardSoulProposal,
  parseProposalResponse,
  proposeSoulUpdate,
  proposeUserUpdate,
  readSoulProposal,
} from './identityProposals';

describe('identity proposals — parseProposalResponse', () => {
  it('returns null for empty input', () => {
    expect(parseProposalResponse('', 'before')).toBeNull();
    expect(parseProposalResponse('   \n  ', 'before')).toBeNull();
  });

  it('returns null when the model says NO_CHANGE', () => {
    expect(parseProposalResponse('NO_CHANGE', 'before')).toBeNull();
    expect(parseProposalResponse('  NO_CHANGE  ', 'before')).toBeNull();
  });

  it('returns null when no identity block is present', () => {
    expect(parseProposalResponse('here is some prose with no block', 'before')).toBeNull();
  });

  it('returns null when the identity block is empty', () => {
    const response = '```identity\n\n```';
    expect(parseProposalResponse(response, 'before')).toBeNull();
  });

  it('returns null when the proposed content equals before', () => {
    const response = '```identity\nsame content\n```';
    expect(parseProposalResponse(response, '  same content  ')).toBeNull();
  });

  it('extracts identity and rationale blocks', () => {
    const response = [
      'sure thing',
      '```identity',
      '# New USER',
      '',
      '- prefers concise answers',
      '```',
      '',
      '```rationale',
      'observed in three turns',
      '```',
    ].join('\n');
    const parsed = parseProposalResponse(response, 'old');
    expect(parsed).not.toBeNull();
    expect(parsed!.after).toBe('# New USER\n\n- prefers concise answers');
    expect(parsed!.rationale).toBe('observed in three turns');
  });

  it('returns empty rationale when no rationale block is present', () => {
    const response = '```identity\nnew body\n```';
    const parsed = parseProposalResponse(response, 'old');
    expect(parsed).not.toBeNull();
    expect(parsed!.after).toBe('new body');
    expect(parsed!.rationale).toBe('');
  });
});

describe('identity proposals — USER flow', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-proposals-user-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('proposeUserUpdate returns null when the model says NO_CHANGE', async () => {
    await writeIdentityFile(projectDir, 'USER.md', '# Current');
    const callModel = jest.fn(async (_prompt: string) => 'NO_CHANGE');
    const result = await proposeUserUpdate(projectDir, 'observations', callModel);
    expect(result).toBeNull();
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(callModel.mock.calls[0][0]).toContain('USER.md');
    expect(callModel.mock.calls[0][0]).toContain('observations');
  });

  it('proposeUserUpdate returns a proposal with before/after/rationale', async () => {
    await writeIdentityFile(projectDir, 'USER.md', '# Old');
    const callModel = jest.fn(async () => [
      '```identity',
      '# New',
      '```',
      '```rationale',
      'because',
      '```',
    ].join('\n'));
    const result = await proposeUserUpdate(projectDir, 'observed X', callModel);
    expect(result).not.toBeNull();
    expect(result!.target).toBe('USER');
    expect(result!.before).toBe('# Old');
    expect(result!.after).toBe('# New');
    expect(result!.rationale).toBe('because');
  });

  it('applyUserProposal captures a snapshot before writing USER.md', async () => {
    await writeIdentityFile(projectDir, 'USER.md', '# Original');
    const proposal = {
      target: 'USER' as const,
      before: '# Original',
      after: '# Updated',
      rationale: 'r',
    };
    const { snapshotId } = await applyUserProposal(projectDir, proposal);
    expect(await readIdentityFile(projectDir, 'USER.md')).toBe('# Updated');
    const history = await listIdentityHistory(projectDir);
    expect(history.find((h) => h.id === snapshotId)).toBeDefined();
    const backup = await loadIdentityHistory(projectDir, snapshotId);
    expect(backup!.snapshot.user).toBe('# Original');
  });

  it('applyUserProposal rejects a SOUL proposal', async () => {
    const proposal = {
      target: 'SOUL' as const,
      before: 'a',
      after: 'b',
      rationale: '',
    };
    await expect(applyUserProposal(projectDir, proposal as any)).rejects.toThrow(/USER proposal/);
  });
});

describe('identity proposals — SOUL flow', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-proposals-soul-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('proposeSoulUpdate writes SOUL.proposed.md and leaves SOUL.md untouched', async () => {
    await writeIdentityFile(projectDir, 'SOUL.md', '# Soul current');
    const callModel = jest.fn(async () => [
      '```identity',
      '# Soul proposed',
      '```',
      '```rationale',
      'drift observed',
      '```',
    ].join('\n'));
    const result = await proposeSoulUpdate(projectDir, 'obs', callModel, new Date('2026-06-07T12:00:00Z'));
    expect(result).not.toBeNull();
    expect(result!.target).toBe('SOUL');
    expect(result!.after).toBe('# Soul proposed');
    expect(result!.rationale).toBe('drift observed');
    expect(result!.capturedAt).toBe('2026-06-07T12:00:00.000Z');
    // SOUL.md unchanged.
    expect(await readIdentityFile(projectDir, 'SOUL.md')).toBe('# Soul current');
    // Proposal file exists.
    const proposed = await fs.readFile(
      path.join(projectDir, '.harness', 'identity', 'SOUL.proposed.md'),
      'utf-8',
    );
    expect(proposed).toContain('# Soul proposed');
    expect(proposed).toContain('drift observed');
  });

  it('proposeSoulUpdate returns null when the model says NO_CHANGE', async () => {
    await writeIdentityFile(projectDir, 'SOUL.md', '# Soul');
    const callModel = jest.fn(async () => 'NO_CHANGE');
    const result = await proposeSoulUpdate(projectDir, 'obs', callModel);
    expect(result).toBeNull();
    const proposalPath = path.join(projectDir, '.harness', 'identity', 'SOUL.proposed.md');
    await expect(fs.access(proposalPath)).rejects.toThrow();
  });

  it('readSoulProposal returns null when no proposal exists', async () => {
    expect(await readSoulProposal(projectDir)).toBeNull();
  });

  it('readSoulProposal round-trips a written proposal', async () => {
    await writeIdentityFile(projectDir, 'SOUL.md', '# Current soul');
    const callModel = jest.fn(async () => [
      '```identity',
      '# New soul body',
      '',
      'with detail',
      '```',
      '```rationale',
      'pattern across recent sessions',
      '```',
    ].join('\n'));
    await proposeSoulUpdate(projectDir, 'obs', callModel, new Date('2026-06-07T08:30:00Z'));
    const reread = await readSoulProposal(projectDir);
    expect(reread).not.toBeNull();
    expect(reread!.after).toBe('# New soul body\n\nwith detail');
    expect(reread!.rationale).toBe('pattern across recent sessions');
    expect(reread!.capturedAt).toBe('2026-06-07T08:30:00.000Z');
    expect(reread!.before).toBe('# Current soul');
  });

  it('readSoulProposal returns null for malformed file', async () => {
    const proposalPath = path.join(projectDir, '.harness', 'identity', 'SOUL.proposed.md');
    await fs.mkdir(path.dirname(proposalPath), { recursive: true });
    await fs.writeFile(proposalPath, 'not yaml not markdown', 'utf-8');
    expect(await readSoulProposal(projectDir)).toBeNull();
  });

  it('acceptSoulProposal captures snapshot, writes SOUL.md, deletes proposal', async () => {
    await writeIdentityFile(projectDir, 'SOUL.md', '# Pre-accept');
    const callModel = jest.fn(async () => [
      '```identity',
      '# Post-accept',
      '```',
      '```rationale',
      'r',
      '```',
    ].join('\n'));
    await proposeSoulUpdate(projectDir, 'obs', callModel);
    const accepted = await acceptSoulProposal(projectDir);
    expect(accepted).not.toBeNull();
    expect(await readIdentityFile(projectDir, 'SOUL.md')).toBe('# Post-accept');
    // Proposal removed.
    const proposalPath = path.join(projectDir, '.harness', 'identity', 'SOUL.proposed.md');
    await expect(fs.access(proposalPath)).rejects.toThrow();
    // Backup snapshot recoverable.
    const backup = await loadIdentityHistory(projectDir, accepted!.snapshotId);
    expect(backup!.snapshot.soul).toBe('# Pre-accept');
  });

  it('acceptSoulProposal returns null when no proposal exists', async () => {
    expect(await acceptSoulProposal(projectDir)).toBeNull();
  });

  it('discardSoulProposal removes the file and reports outcome', async () => {
    expect(await discardSoulProposal(projectDir)).toBe(false);
    const callModel = jest.fn(async () => '```identity\n# X\n```');
    await proposeSoulUpdate(projectDir, 'obs', callModel);
    expect(await discardSoulProposal(projectDir)).toBe(true);
    expect(await discardSoulProposal(projectDir)).toBe(false);
  });
});
