import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ImportSkillTool, setImportSkillsDir } from './skillImportTool';
import { invalidateSkillsCache, setSkillsDir } from './skillTools';
import { getAllowedExternalPaths, setAllowedExternalPaths } from './pathResolution';

describe('import_skill tool', () => {
  let projectDir: string;
  let skillsDir: string;
  let sourceRoot: string;
  let savedAllowedPaths: string[];

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-import-skill-'));
    skillsDir = path.join(projectDir, '.harness', 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
    sourceRoot = path.join(projectDir, 'incoming');
    await fs.mkdir(sourceRoot, { recursive: true });
    setImportSkillsDir(skillsDir);
    setSkillsDir(skillsDir);
    savedAllowedPaths = getAllowedExternalPaths();
    setAllowedExternalPaths([]);
  });

  afterEach(async () => {
    invalidateSkillsCache();
    setImportSkillsDir('');
    setSkillsDir('');
    setAllowedExternalPaths(savedAllowedPaths);
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  async function writeBundle(folder: string, frontmatter: string, files: Record<string, string> = {}): Promise<void> {
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'SKILL.md'), frontmatter, 'utf-8');
    for (const [relPath, body] of Object.entries(files)) {
      const abs = path.join(folder, relPath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, body, 'utf-8');
    }
  }

  it('imports an Anthropic-format skill bundle from a project-local folder', async () => {
    const source = path.join(sourceRoot, 'pdf-processing');
    await writeBundle(source, [
      '---',
      'name: pdf-processing',
      'description: Extract text from PDFs',
      '---',
      '',
      '# PDF Processing',
    ].join('\n'), {
      'FORMS.md': '# Forms helper\n',
      'scripts/fill.py': 'print("fill")\n',
    });

    const result = await ImportSkillTool.execute({ source });

    expect(result.success).toBe(true);
    expect(result.output).toContain('pdf-processing');
    expect(result.output).toContain('2 bundled file(s)');

    const dest = path.join(skillsDir, 'pdf-processing');
    await expect(fs.readFile(path.join(dest, 'SKILL.md'), 'utf-8')).resolves.toContain('Extract text from PDFs');
    await expect(fs.readFile(path.join(dest, 'FORMS.md'), 'utf-8')).resolves.toContain('Forms helper');
    await expect(fs.readFile(path.join(dest, 'scripts', 'fill.py'), 'utf-8')).resolves.toContain('fill');
    // Provenance footer is appended to SKILL.md so the import source is traceable.
    await expect(fs.readFile(path.join(dest, 'SKILL.md'), 'utf-8')).resolves.toContain('<!-- imported-from:');
  });

  it('rejects sources that live outside the project and not under an Allowed External Path', async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-import-outside-'));
    try {
      const source = path.join(outsideRoot, 'outside-skill');
      await writeBundle(source, [
        '---',
        'name: outside-skill',
        'description: Skill outside the project',
        '---',
        '',
        '# Outside',
      ].join('\n'));

      const result = await ImportSkillTool.execute({ source });

      expect(result.success).toBe(false);
      expect(result.output).toContain('Allowed External Path');
      await expect(fs.access(path.join(skillsDir, 'outside-skill'))).rejects.toThrow();
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('accepts sources under an Allowed External Path', async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-import-allowed-'));
    try {
      const source = path.join(outsideRoot, 'allowed-skill');
      await writeBundle(source, [
        '---',
        'name: allowed-skill',
        'description: Skill under an allowed external path',
        '---',
        '',
        '# Allowed',
      ].join('\n'));
      setAllowedExternalPaths([outsideRoot]);

      const result = await ImportSkillTool.execute({ source });

      expect(result.success).toBe(true);
      await expect(fs.access(path.join(skillsDir, 'allowed-skill', 'SKILL.md'))).resolves.toBeUndefined();
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing skill unless overwrite is true', async () => {
    const source = path.join(sourceRoot, 'dup-skill');
    await writeBundle(source, [
      '---',
      'name: dup-skill',
      'description: Duplicate test',
      '---',
      '',
      '# v1',
    ].join('\n'));

    const first = await ImportSkillTool.execute({ source });
    expect(first.success).toBe(true);

    // Second import without overwrite must fail.
    const second = await ImportSkillTool.execute({ source });
    expect(second.success).toBe(false);
    expect(second.output).toContain('already exists');

    // Update the source then retry with overwrite: true.
    await fs.writeFile(path.join(source, 'SKILL.md'), [
      '---',
      'name: dup-skill',
      'description: Duplicate test v2',
      '---',
      '',
      '# v2',
    ].join('\n'), 'utf-8');
    const third = await ImportSkillTool.execute({ source, overwrite: true });
    expect(third.success).toBe(true);
    await expect(fs.readFile(path.join(skillsDir, 'dup-skill', 'SKILL.md'), 'utf-8')).resolves.toContain('Duplicate test v2');
  });

  it('rejects a folder without SKILL.md', async () => {
    const source = path.join(sourceRoot, 'no-skill');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'README.md'), '# Not a skill\n', 'utf-8');

    const result = await ImportSkillTool.execute({ source });

    expect(result.success).toBe(false);
    expect(result.output).toContain('does not contain SKILL.md');
  });

  it('rejects SKILL.md without valid frontmatter', async () => {
    const source = path.join(sourceRoot, 'bad-frontmatter');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'SKILL.md'), '# Just a heading, no frontmatter\n', 'utf-8');

    const result = await ImportSkillTool.execute({ source });

    expect(result.success).toBe(false);
    expect(result.output).toContain('valid YAML frontmatter');
  });

  it('skips node_modules and dotfiles when copying the bundle', async () => {
    const source = path.join(sourceRoot, 'big-skill');
    await writeBundle(source, [
      '---',
      'name: big-skill',
      'description: Skill with junk to skip',
      '---',
      '',
      '# Big',
    ].join('\n'), {
      'KEEP.md': 'keep me',
      'node_modules/junk.js': 'noise',
      '.git/HEAD': 'noise',
      '.hidden': 'noise',
    });

    const result = await ImportSkillTool.execute({ source });

    expect(result.success).toBe(true);
    const dest = path.join(skillsDir, 'big-skill');
    await expect(fs.access(path.join(dest, 'KEEP.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dest, 'node_modules'))).rejects.toThrow();
    await expect(fs.access(path.join(dest, '.git'))).rejects.toThrow();
    await expect(fs.access(path.join(dest, '.hidden'))).rejects.toThrow();
  });

  it('honors a kebab-case name override', async () => {
    const source = path.join(sourceRoot, 'oddly_named_folder');
    await writeBundle(source, [
      '---',
      'name: oddly_named_folder',
      'description: Mixed-case original name',
      '---',
      '',
      '# Odd',
    ].join('\n'));

    // Without override the frontmatter name fails kebab-case validation.
    const without = await ImportSkillTool.execute({ source });
    expect(without.success).toBe(false);
    expect(without.output).toContain('kebab-case');

    const withOverride = await ImportSkillTool.execute({ source, name: 'renamed-skill' });
    expect(withOverride.success).toBe(true);
    await expect(fs.access(path.join(skillsDir, 'renamed-skill', 'SKILL.md'))).resolves.toBeUndefined();
  });
});
