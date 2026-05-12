import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CreateSkillTool, ListSkillsTool, invalidateSkillsCache, setSkillsDir } from './skillTools';

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
});