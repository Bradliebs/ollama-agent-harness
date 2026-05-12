import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { findStaleSkills, runDeterministicPhase, archiveSkill, restoreSkill, runCurator, parseMergeProposals, applyMergeProposal, DEFAULT_CURATOR_CONFIG } from './curator';
import type { SkillDefinition } from '../extensibility/skillLoader';
import { loadSkillUsage, saveSkillUsage, recordSkillUse, recordSkillView, setSkillPinned, type SkillUsageStore } from '../extensibility/skillUsage';

function makeSkill(name: string): SkillDefinition {
  return { name, description: name, domain: 'tests', triggers: [], content: '# ' + name, filePath: '/tmp/' + name + '/SKILL.md' };
}

function nowMinusDays(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('Curator deterministic phase', () => {
  it('flags skills not used within staleDays as archive candidates', () => {
    const skills = [makeSkill('fresh'), makeSkill('stale'), makeSkill('pinned-stale')];
    const store: SkillUsageStore = {
      version: 1,
      records: {
        fresh: { name: 'fresh', useCount: 5, viewCount: 5, lastUsedAt: nowMinusDays(1), pinned: false, archived: false, firstSeenAt: nowMinusDays(30), updatedAt: nowMinusDays(1) },
        stale: { name: 'stale', useCount: 1, viewCount: 3, lastUsedAt: nowMinusDays(120), pinned: false, archived: false, firstSeenAt: nowMinusDays(180), updatedAt: nowMinusDays(120) },
        'pinned-stale': { name: 'pinned-stale', useCount: 1, viewCount: 3, lastUsedAt: nowMinusDays(120), pinned: true, archived: false, firstSeenAt: nowMinusDays(180), updatedAt: nowMinusDays(120) },
      },
    };
    const actions = findStaleSkills(skills, store, DEFAULT_CURATOR_CONFIG);
    expect(actions.find((a) => a.skill === 'stale')?.kind).toBe('archive');
    expect(actions.find((a) => a.skill === 'fresh')?.kind).toBe('skip-active');
    expect(actions.find((a) => a.skill === 'pinned-stale')?.kind).toBe('skip-pinned');
  });

  it('honors per-run archive cap', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-curator-cap-'));
    const skillsDir = path.join(projectDir, '.harness', 'skills');
    for (const name of ['s1', 's2', 's3', 's4']) {
      await fs.mkdir(path.join(skillsDir, name), { recursive: true });
      await fs.writeFile(path.join(skillsDir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\ndomain: t\n---\n# ${name}`, 'utf-8');
    }
    const store: SkillUsageStore = {
      version: 1,
      records: Object.fromEntries(['s1', 's2', 's3', 's4'].map((name) => [name, { name, useCount: 0, viewCount: 1, lastUsedAt: nowMinusDays(120), pinned: false, archived: false, firstSeenAt: nowMinusDays(180), updatedAt: nowMinusDays(120) }])),
    };
    await saveSkillUsage(projectDir, store);

    const config = { ...DEFAULT_CURATOR_CONFIG, maxArchivePerRun: 2 };
    const summary = await runDeterministicPhase(projectDir, config, { isKillSwitchActive: () => false });
    const archived = summary.archived.filter((a) => a.kind === 'archive');
    const skipped = summary.archived.filter((a) => a.kind === 'skip-cap');
    expect(archived).toHaveLength(2);
    expect(skipped).toHaveLength(2);

    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('skips entirely when the kill switch is active', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-curator-kill-'));
    const summary = await runCurator(projectDir, DEFAULT_CURATOR_CONFIG, { isKillSwitchActive: () => true });
    expect(summary.staleCandidates).toHaveLength(0);
    expect(summary.archived).toHaveLength(0);
    expect(summary.llmSkipped).toBe('kill switch active');
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('archive moves the skill folder and restore puts it back', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-curator-archive-'));
    const skillsDir = path.join(projectDir, '.harness', 'skills');
    await fs.mkdir(path.join(skillsDir, 'mover'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'mover', 'SKILL.md'), '---\nname: mover\ndescription: mover\ndomain: t\n---\n# mover', 'utf-8');

    const arch = await archiveSkill(projectDir, 'mover');
    expect(arch.to).toContain('_archive');
    await expect(fs.access(arch.to)).resolves.toBeUndefined();
    await expect(fs.access(arch.from)).rejects.toBeDefined();

    const back = await restoreSkill(projectDir, 'mover');
    expect(back.to).not.toContain('_archive');
    await expect(fs.access(back.to)).resolves.toBeUndefined();

    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('LLM phase writes proposals to disk and is skipped when disabled', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-curator-llm-'));
    const skillsDir = path.join(projectDir, '.harness', 'skills');
    for (const name of ['a', 'b', 'c']) {
      await fs.mkdir(path.join(skillsDir, name), { recursive: true });
      await fs.writeFile(path.join(skillsDir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\ndomain: t\n---\n# ${name}`, 'utf-8');
    }
    // Disabled: proposals.md should not be created.
    const disabled = await runCurator(projectDir, DEFAULT_CURATOR_CONFIG, { isKillSwitchActive: () => false, callModel: async () => 'unused' });
    expect(disabled.llmSkipped).toContain('disabled');

    // Enabled: proposals are written.
    const enabledConfig = { ...DEFAULT_CURATOR_CONFIG, enableLlmPhase: true };
    const enabled = await runCurator(projectDir, enabledConfig, { isKillSwitchActive: () => false, callModel: async () => '### Cluster: combined\n- merge: a, b\n- rationale: similar\n' });
    expect(enabled.proposals).toContain('combined');
    const written = await fs.readFile(path.join(projectDir, '.harness', 'curator', 'proposals.md'), 'utf-8');
    expect(written).toContain('Curator merge proposals');
    expect(written).toContain('combined');

    await fs.rm(projectDir, { recursive: true, force: true });
  });
});

describe('Curator safety gate (HARNESS_CURATOR_SAFETY_GATE)', () => {
  const ENV_KEY = 'HARNESS_CURATOR_SAFETY_GATE';
  let originalEnv: string | undefined;

  beforeEach(() => { originalEnv = process.env[ENV_KEY]; });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
  });

  it('records skip-safety instead of archiving when a stale skill trips a high-severity rule', async () => {
    process.env[ENV_KEY] = '1';
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-curator-safety-'));
    const skillsDir = path.join(projectDir, '.harness', 'skills');
    await fs.mkdir(path.join(skillsDir, 'leaky'), { recursive: true });
    // Skill content contains an AWS access key id (high-severity rule).
    await fs.writeFile(
      path.join(skillsDir, 'leaky', 'SKILL.md'),
      '---\nname: leaky\ndescription: leaky\ndomain: t\n---\n# leaky\nAKIAIOSFODNN7EXAMPLE',
      'utf-8',
    );
    const store: SkillUsageStore = {
      version: 1,
      records: { leaky: { name: 'leaky', useCount: 0, viewCount: 1, lastUsedAt: nowMinusDays(120), pinned: false, archived: false, firstSeenAt: nowMinusDays(180), updatedAt: nowMinusDays(120) } },
    };
    await saveSkillUsage(projectDir, store);

    const summary = await runDeterministicPhase(projectDir, DEFAULT_CURATOR_CONFIG, { isKillSwitchActive: () => false });
    const archived = summary.archived.filter((action) => action.kind === 'archive');
    const skipped = summary.archived.filter((action) => action.kind === 'skip-safety');
    expect(archived).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].safetyViolations?.[0].severity).toBe('high');

    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('archives normally when the safety gate is off (default)', async () => {
    delete process.env[ENV_KEY];
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-curator-safety-off-'));
    const skillsDir = path.join(projectDir, '.harness', 'skills');
    await fs.mkdir(path.join(skillsDir, 'leaky'), { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, 'leaky', 'SKILL.md'),
      '---\nname: leaky\ndescription: leaky\ndomain: t\n---\n# leaky\nAKIAIOSFODNN7EXAMPLE',
      'utf-8',
    );
    const store: SkillUsageStore = {
      version: 1,
      records: { leaky: { name: 'leaky', useCount: 0, viewCount: 1, lastUsedAt: nowMinusDays(120), pinned: false, archived: false, firstSeenAt: nowMinusDays(180), updatedAt: nowMinusDays(120) } },
    };
    await saveSkillUsage(projectDir, store);

    const summary = await runDeterministicPhase(projectDir, DEFAULT_CURATOR_CONFIG, { isKillSwitchActive: () => false });
    const archived = summary.archived.filter((action) => action.kind === 'archive');
    expect(archived).toHaveLength(1);

    await fs.rm(projectDir, { recursive: true, force: true });
  });
});

describe('parseMergeProposals', () => {
  it('parses cluster headings, merge lists, rationale, and proposed description', () => {
    const md = [
      '# Curator merge proposals',
      '',
      '### Cluster: review-tooling',
      '- merge: review-skill, lint-skill, format-skill',
      '- rationale: All three help prepare a PR review.',
      '- proposed description: Single skill that lints, formats, and reviews a diff.',
      '',
      '### Cluster: misc',
      '- merge: only-one',
      '',
    ].join('\n');
    const proposals = parseMergeProposals(md);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      umbrellaName: 'review-tooling',
      heading: 'review-tooling',
      mergeSkills: ['review-skill', 'lint-skill', 'format-skill'],
      rationale: 'All three help prepare a PR review.',
      proposedDescription: 'Single skill that lints, formats, and reviews a diff.',
    });
  });

  it('returns empty for "no merges proposed"', () => {
    expect(parseMergeProposals('No merges proposed.')).toEqual([]);
  });
});

describe('applyMergeProposal', () => {
  it('writes umbrella SKILL.md and archives source skills', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-curator-merge-'));
    const skillsDir = path.join(projectDir, '.harness', 'skills');
    for (const name of ['lint', 'format']) {
      await fs.mkdir(path.join(skillsDir, name), { recursive: true });
      await fs.writeFile(path.join(skillsDir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} body\ndomain: t\n---\n# ${name}\nbody`, 'utf-8');
    }
    const result = await applyMergeProposal(projectDir, {
      umbrellaName: 'tidy-pr',
      heading: 'Tidy PR',
      mergeSkills: ['lint', 'format'],
      proposedDescription: 'Lint then format.',
    });
    expect(result.archived).toEqual(['lint', 'format']);
    const umbrella = await fs.readFile(result.umbrellaPath, 'utf-8');
    expect(umbrella).toContain('name: tidy-pr');
    expect(umbrella).toContain('## lint');
    expect(umbrella).toContain('## format');
    await expect(fs.access(path.join(skillsDir, '_archive', 'lint'))).resolves.toBeUndefined();
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('refuses to overwrite an existing umbrella name', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-curator-merge-conflict-'));
    const skillsDir = path.join(projectDir, '.harness', 'skills');
    for (const name of ['a', 'b', 'tidy']) {
      await fs.mkdir(path.join(skillsDir, name), { recursive: true });
      await fs.writeFile(path.join(skillsDir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\ndomain: t\n---\n# ${name}`, 'utf-8');
    }
    await expect(applyMergeProposal(projectDir, { umbrellaName: 'tidy', heading: '', mergeSkills: ['a', 'b'] })).rejects.toThrow(/already exists/);
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('skips pinned source skills (does not archive them)', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-curator-merge-pinned-'));
    const skillsDir = path.join(projectDir, '.harness', 'skills');
    for (const name of ['x', 'y']) {
      await fs.mkdir(path.join(skillsDir, name), { recursive: true });
      await fs.writeFile(path.join(skillsDir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\ndomain: t\n---\n# ${name}`, 'utf-8');
    }
    await setSkillPinned(projectDir, 'x', true);
    const result = await applyMergeProposal(projectDir, { umbrellaName: 'paired', heading: '', mergeSkills: ['x', 'y'] });
    expect(result.archived).toEqual(['y']);
    expect(result.skipped).toEqual(['x']);
    await fs.rm(projectDir, { recursive: true, force: true });
  });
});

describe('Skill usage store', () => {
  it('records views and uses, and persists pin state', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-usage-'));
    await recordSkillView(projectDir, 'demo');
    await recordSkillView(projectDir, 'demo');
    await recordSkillUse(projectDir, 'demo');
    await setSkillPinned(projectDir, 'demo', true);
    const store = await loadSkillUsage(projectDir);
    expect(store.records.demo.viewCount).toBe(2);
    expect(store.records.demo.useCount).toBe(1);
    expect(store.records.demo.pinned).toBe(true);
    expect(store.records.demo.lastUsedAt).toBeDefined();
    await fs.rm(projectDir, { recursive: true, force: true });
  });
});
