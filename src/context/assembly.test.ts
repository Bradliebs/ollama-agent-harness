import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { assembleSystemContext } from './assembly';

describe('assembleSystemContext', () => {
  it('trims large agent memory files before injecting them into the system prompt', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-context-'));
    await fs.mkdir(path.join(projectDir, '.harness', 'memory'), { recursive: true });
    await fs.writeFile(path.join(projectDir, '.harness', 'memory', 'notes.md'), 'old note\n'.repeat(15_000) + 'latest important note', 'utf-8');

    const context = await assembleSystemContext({ systemPrompt: 'base prompt', projectDir });

    expect(context).toContain('base prompt');
    expect(context).toContain('trimmed to latest 4000 chars for prompt budget');
    expect(context).toContain('latest important note');
    expect(context.length).toBeLessThan(8_000);
  });

  it('keeps capped prompt sources under the baseline context budget', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-context-budget-'));
    const skillsDir = path.join(projectDir, '.harness', 'skills');
    await fs.mkdir(path.join(projectDir, 'forge-memory'), { recursive: true });
    await fs.mkdir(path.join(projectDir, '.harness', 'memory'), { recursive: true });
    await fs.writeFile(path.join(projectDir, 'HARNESS.md'), 'project start\n' + 'project memory line\n'.repeat(5_000) + 'project end', 'utf-8');
    await fs.writeFile(path.join(projectDir, 'forge-memory', 'patterns.md'), 'pattern start\n' + 'pattern line\n'.repeat(5_000) + 'pattern end', 'utf-8');

    for (const file of ['decisions.md', 'patterns.md', 'notes.md']) {
      await fs.writeFile(path.join(projectDir, '.harness', 'memory', file), 'old agent memory\n'.repeat(4_000) + `${file} latest`, 'utf-8');
    }
    for (let index = 0; index < 75; index++) {
      const skillDir = path.join(skillsDir, `skill-${String(index).padStart(2, '0')}`);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: skill-${index}\ndescription: Skill ${index} keeps descriptions concise for prompt budget checks\ndomain: test\n---\nFull skill content should not be injected.\n`, 'utf-8');
    }

    const context = await assembleSystemContext({ systemPrompt: 'base prompt', projectDir, skillsDir });

    expect(context).toContain('project start');
    expect(context).toContain('project end');
    expect(context).toContain('notes.md latest');
    expect(context).toContain('35 more skill(s) omitted from prompt');
    expect(context).not.toContain('skill-41');
    expect(context.length).toBeLessThan(32_768);
  });
});
