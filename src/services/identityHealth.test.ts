import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { assessIdentityHealth, parsePersonaName } from './identityHealth';

const REAL_SOUL = `# Soul — Moss\n\nI am **Moss**, an adaptive working partner.\n\n${'Evidence first, honest abstention, clear bottom lines. '.repeat(6)}`;

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-identity-health-'));
  await fs.mkdir(path.join(dir, '.harness', 'identity'), { recursive: true });
  return dir;
}

async function writeProposal(dir: string, capturedAt: string): Promise<void> {
  await fs.writeFile(
    path.join(dir, '.harness', 'identity', 'SOUL.proposed.md'),
    `---\ncapturedAt: ${capturedAt}\nproposedBy: auto\ntarget: SOUL.md\n---\n\n## Rationale\n\nwhy\n\n## Proposed SOUL.md\n\n# Soul — Moss\nnew body\n`,
  );
}

describe('parsePersonaName', () => {
  it('reads the name from the Soul heading, bold intro, or "My name is"', () => {
    expect(parsePersonaName('# Soul — Moss\n')).toBe('Moss');
    expect(parsePersonaName('# SOUL\n\nI am **Juniper**, a helper.')).toBe('Juniper');
    expect(parsePersonaName('Hello. My name is Ada and I help.')).toBe('Ada');
    expect(parsePersonaName('# Soul\n\nNo name here.')).toBeNull();
  });
});

describe('assessIdentityHealth', () => {
  let dir: string;
  beforeEach(async () => { dir = await makeProject(); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('reports a healthy persona with its name', async () => {
    await fs.writeFile(path.join(dir, '.harness', 'identity', 'SOUL.md'), REAL_SOUL);
    await expect(assessIdentityHealth(dir)).resolves.toMatchObject({ name: 'Moss', issue: null, proposalPending: false, proposalStale: false });
  });

  it('flags a missing SOUL.md', async () => {
    await expect(assessIdentityHealth(dir)).resolves.toMatchObject({ issue: 'missing', name: null });
  });

  it('flags the regression-test placeholder', async () => {
    await fs.writeFile(path.join(dir, '.harness', 'identity', 'SOUL.md'), 'Temporary import soul text for regression test.');
    await expect(assessIdentityHealth(dir)).resolves.toMatchObject({ issue: 'placeholder', name: null });
  });

  it('flags a SOUL.md that is too short to be a persona', async () => {
    await fs.writeFile(path.join(dir, '.harness', 'identity', 'SOUL.md'), '# Soul — Moss\nBrief.');
    await expect(assessIdentityHealth(dir)).resolves.toMatchObject({ issue: 'too-short' });
  });

  it('marks a pending proposal as stale when SOUL.md changed after it was generated', async () => {
    await fs.writeFile(path.join(dir, '.harness', 'identity', 'SOUL.md'), REAL_SOUL);
    await writeProposal(dir, '2020-01-01T00:00:00.000Z');
    await expect(assessIdentityHealth(dir)).resolves.toMatchObject({ proposalPending: true, proposalStale: true, proposalCapturedAt: '2020-01-01T00:00:00.000Z' });
  });

  it('treats a proposal generated after the current SOUL.md as fresh', async () => {
    await fs.writeFile(path.join(dir, '.harness', 'identity', 'SOUL.md'), REAL_SOUL);
    await writeProposal(dir, new Date(Date.now() + 60_000).toISOString());
    await expect(assessIdentityHealth(dir)).resolves.toMatchObject({ proposalPending: true, proposalStale: false });
  });
});
