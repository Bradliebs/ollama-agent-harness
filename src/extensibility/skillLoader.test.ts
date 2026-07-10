import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { loadSkillsDir, loadSkillsFromDirs, matchSkillTrigger, scanSkillsDir, scanSkillsDirs } from './skillLoader';

describe('skillLoader', () => {
  it('loads valid skills and reports skipped skill folders', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-skill-loader-'));
    const skillsDir = path.join(projectDir, 'skills');
    await fs.mkdir(path.join(skillsDir, 'valid'), { recursive: true });
    await fs.mkdir(path.join(skillsDir, 'missing'), { recursive: true });
    await fs.mkdir(path.join(skillsDir, 'malformed'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'valid', 'SKILL.md'), ['---', 'name: valid', 'description: Valid skill', 'domain: tests', 'triggers:', '  - valid', '---', 'Use it.'].join('\n'), 'utf-8');
    await fs.writeFile(path.join(skillsDir, 'malformed', 'SKILL.md'), '# Missing frontmatter', 'utf-8');

    try {
      const scan = await scanSkillsDir(skillsDir);
      expect(scan.skills).toEqual([expect.objectContaining({ name: 'valid', triggers: ['valid'] })]);
      expect(scan.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'missing', reason: 'missing-skill-file' }),
        expect.objectContaining({ name: 'malformed', reason: 'missing-frontmatter' }),
      ]));
      await expect(loadSkillsDir(skillsDir)).resolves.toEqual([expect.objectContaining({ name: 'valid' })]);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('parses extended skill schema fields when present', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-skill-extended-'));
    const skillsDir = path.join(projectDir, 'skills');
    await fs.mkdir(path.join(skillsDir, 'health-check'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'health-check', 'SKILL.md'), [
      '---',
      'name: project-health-check',
      'description: Run a project health check.',
      'domain: ops',
      'triggers:',
      '  - health',
      'when_to_use: Before each release.',
      'risk_level: medium',
      'required_tools:',
      '  - bash',
      '  - file_read',
      'steps:',
      '  - Read the package.json.',
      '  - Run the test suite.',
      'examples:',
      '  - "Check the harness before tagging v0.2.0"',
      'validation_checks:',
      '  - All tests pass.',
      'rollback_notes: No state mutated; nothing to roll back.',
      '---',
      'Body content.',
    ].join('\n'), 'utf-8');

    try {
      const skills = await loadSkillsDir(skillsDir);
      expect(skills).toHaveLength(1);
      const skill = skills[0];
      expect(skill.whenToUse).toBe('Before each release.');
      expect(skill.riskLevel).toBe('medium');
      expect(skill.requiredTools).toEqual(['bash', 'file_read']);
      expect(skill.steps).toEqual(['Read the package.json.', 'Run the test suite.']);
      expect(skill.examples?.[0]).toContain('v0.2.0');
      expect(skill.validationChecks).toEqual(['All tests pass.']);
      expect(skill.rollbackNotes).toContain('nothing to roll back');
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('treats `enabled: false` as disabled and omitted enabled as enabled-by-default', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-skill-enabled-'));
    const skillsDir = path.join(projectDir, 'skills');
    await fs.mkdir(path.join(skillsDir, 'on'), { recursive: true });
    await fs.mkdir(path.join(skillsDir, 'off'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'on', 'SKILL.md'), [
      '---', 'name: on-skill', 'description: Enabled skill', 'domain: t', 'triggers: []', '---', 'Body.',
    ].join('\n'), 'utf-8');
    await fs.writeFile(path.join(skillsDir, 'off', 'SKILL.md'), [
      '---', 'name: off-skill', 'description: Disabled skill', 'domain: t', 'triggers: []', 'enabled: false', '---', 'Body.',
    ].join('\n'), 'utf-8');

    try {
      const skills = await loadSkillsDir(skillsDir);
      const on = skills.find((s) => s.name === 'on-skill');
      const off = skills.find((s) => s.name === 'off-skill');
      expect(on?.enabled).toBeUndefined();
      expect(off?.enabled).toBe(false);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('matchSkillTrigger skips disabled skills even when triggers match', () => {
    const enabled = { name: 'enabled-skill', triggers: ['lottery'], enabled: true } as Parameters<typeof matchSkillTrigger>[0][0];
    const disabled = { name: 'disabled-skill', triggers: ['lottery'], enabled: false } as Parameters<typeof matchSkillTrigger>[0][0];
    // Disabled skill listed first; matchSkillTrigger should still find the
    // enabled one because it skips entries with enabled === false.
    expect(matchSkillTrigger([disabled, enabled], 'run lottery analysis')?.name).toBe('enabled-skill');
    // With only a disabled skill in the list, no match.
    expect(matchSkillTrigger([disabled], 'run lottery analysis')).toBeNull();
  });

  it('merges tiered skill directories with higher-precedence dirs winning name collisions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-skill-tiers-'));
    const globalDir = path.join(root, 'global');
    const workspaceDir = path.join(root, 'workspace');
    await fs.mkdir(path.join(globalDir, 'shared'), { recursive: true });
    await fs.mkdir(path.join(globalDir, 'global-only'), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, 'shared'), { recursive: true });
    await fs.writeFile(path.join(globalDir, 'shared', 'SKILL.md'), ['---', 'name: shared', 'description: Global version', 'domain: t', 'triggers: []', '---', 'Global body.'].join('\n'), 'utf-8');
    await fs.writeFile(path.join(globalDir, 'global-only', 'SKILL.md'), ['---', 'name: global-only', 'description: Only in global', 'domain: t', 'triggers: []', '---', 'Body.'].join('\n'), 'utf-8');
    await fs.writeFile(path.join(workspaceDir, 'shared', 'SKILL.md'), ['---', 'name: shared', 'description: Workspace version', 'domain: t', 'triggers: []', '---', 'Workspace body.'].join('\n'), 'utf-8');

    try {
      // Ordered low-to-high precedence: global first, workspace last (wins).
      const merged = await loadSkillsFromDirs([globalDir, workspaceDir]);
      const shared = merged.find((s) => s.name === 'shared');
      const globalOnly = merged.find((s) => s.name === 'global-only');
      expect(shared?.description).toBe('Workspace version');
      expect(globalOnly?.description).toBe('Only in global');
      expect(merged).toHaveLength(2);

      const scan = await scanSkillsDirs([globalDir, workspaceDir]);
      expect(scan.skills).toHaveLength(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('scanSkillsDirs tolerates missing directories and preserves diagnostics', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-skill-tiers-missing-'));
    const realDir = path.join(root, 'real');
    await fs.mkdir(path.join(realDir, 'broken'), { recursive: true });
    await fs.writeFile(path.join(realDir, 'broken', 'SKILL.md'), '# no frontmatter', 'utf-8');

    try {
      const scan = await scanSkillsDirs([path.join(root, 'does-not-exist'), realDir]);
      expect(scan.skills).toEqual([]);
      expect(scan.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'broken', reason: 'missing-frontmatter' }),
      ]));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});