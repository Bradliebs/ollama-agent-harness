import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { loadSkillsDir, scanSkillsDir } from './skillLoader';

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
});