import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CreateSkillTool, ListSkillsTool, SkillTool, invalidateSkillsCache, setSkillsDir } from './skillTools';

describe('skill tools', () => {
  let projectDir: string;
  let skillsDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-skills-'));
    skillsDir = path.join(projectDir, '.harness', 'skills');
    setSkillsDir(skillsDir);
  });

  afterEach(async () => {
    invalidateSkillsCache();
    setSkillsDir('');
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('lists a newly created skill immediately after creation', async () => {
    const empty = await ListSkillsTool.execute({});
    expect(empty.output).toContain('No skills installed');

    const created = await CreateSkillTool.execute({
      name: 'fresh-skill',
      description: 'Fresh skill for visibility tests',
      domain: 'testing',
      triggers: ['fresh skill'],
      instructions: '## Context\n\nUse this skill in tests.',
    });

    expect(created.success).toBe(true);
    const listed = await ListSkillsTool.execute({});
    expect(listed.output).toContain('fresh-skill');
    await expect(fs.readFile(path.join(skillsDir, 'fresh-skill', 'SKILL.md'), 'utf-8')).resolves.toContain('Fresh skill for visibility tests');
  });

  it('lists skills when malformed frontmatter has scalar triggers', async () => {
    const skillDir = path.join(skillsDir, 'scalar-triggers');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: scalar-triggers',
      'description: Scalar trigger regression',
      'domain: testing',
      'triggers: scalar trigger',
      '---',
      '',
      '## Context',
      '',
      'Use this in tests.',
    ].join('\n'), 'utf-8');

    const listed = await ListSkillsTool.execute({});

    expect(listed.success).toBe(true);
    expect(listed.output).toContain('scalar-triggers');
    expect(listed.output).toContain('scalar trigger');
  });

  it('surfaces bundled resources when the skill tool is invoked', async () => {
    const skillDir = path.join(skillsDir, 'bundled-skill');
    const scriptsDir = path.join(skillDir, 'scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: bundled-skill',
      'description: Skill with bundled level-3 resources',
      '---',
      '',
      '# Bundled Skill',
      '',
      'See FORMS.md for form-filling details.',
    ].join('\n'), 'utf-8');
    await fs.writeFile(path.join(skillDir, 'FORMS.md'), 'Form helpers go here.\n', 'utf-8');
    await fs.writeFile(path.join(scriptsDir, 'helper.py'), 'print("hi")\n', 'utf-8');
    // Hidden files and SKILL.md backups must be excluded from the listing.
    await fs.writeFile(path.join(skillDir, '.DS_Store'), 'noise', 'utf-8');
    await fs.writeFile(path.join(skillDir, 'SKILL.md.backup-1700000000000'), 'old', 'utf-8');

    invalidateSkillsCache();
    const result = await SkillTool.execute({ name: 'bundled-skill' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('--- Bundled resources ---');
    expect(result.output).toContain('📎 FORMS.md');
    expect(result.output).toContain('📎 scripts/helper.py');
    expect(result.output).not.toContain('.DS_Store');
    expect(result.output).not.toContain('SKILL.md.backup');
    // SKILL.md itself must never appear as a bundled-resource entry (📎 prefix).
    const bundledLines = result.output.split('\n').filter(line => line.includes('📎'));
    expect(bundledLines.length).toBeGreaterThan(0);
    expect(bundledLines.some(line => line.includes('SKILL.md'))).toBe(false);
  });

  it('omits the bundled resources section when only SKILL.md is present', async () => {
    const skillDir = path.join(skillsDir, 'lonely-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: lonely-skill',
      'description: Skill without bundled files',
      '---',
      '',
      '# Lonely',
    ].join('\n'), 'utf-8');

    invalidateSkillsCache();
    const result = await SkillTool.execute({ name: 'lonely-skill' });

    expect(result.success).toBe(true);
    expect(result.output).not.toContain('--- Bundled resources ---');
  });

  it('expands ${HARNESS_SKILL_DIR} in the skill body on invocation', async () => {
    const skillDir = path.join(skillsDir, 'templated-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: templated-skill',
      'description: Skill that references its own directory',
      '---',
      '',
      '# Templated',
      '',
      'Helper scripts live in ${HARNESS_SKILL_DIR}/scripts.',
    ].join('\n'), 'utf-8');

    invalidateSkillsCache();
    const result = await SkillTool.execute({ name: 'templated-skill' });

    expect(result.success).toBe(true);
    expect(result.output).toContain(`${skillDir}/scripts`);
    expect(result.output).not.toContain('${HARNESS_SKILL_DIR}');
  });
});