import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { discoverExtensionManifests } from './extensionManifest';

describe('extensionManifest', () => {
  it('discovers plugin manifests without executing code', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-ext-'));
    const pluginDir = path.join(projectDir, '.harness', 'plugins', 'demo');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0', description: 'Demo plugin', providesTools: ['demo_tool'], providesHooks: ['pre_tool_call'] }), 'utf-8');
    await fs.writeFile(path.join(pluginDir, 'index.js'), 'throw new Error("should not execute");', 'utf-8');

    const manifests = await discoverExtensionManifests(projectDir);

    expect(manifests).toEqual([expect.objectContaining({ kind: 'plugin', name: 'demo', providesTools: ['demo_tool'], providesHooks: ['pre_tool_call'] })]);
  });

  it('discovers skill manifests from SKILL frontmatter', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-skills-'));
    const skillDir = path.join(projectDir, '.harness', 'skills', 'triage');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), ['---', 'name: triage', 'description: Triage help', 'domain: support', 'triggers:', '  - bug', '---', 'Skill body'].join('\n'), 'utf-8');

    const manifests = await discoverExtensionManifests(projectDir);

    expect(manifests).toEqual([expect.objectContaining({ kind: 'skill', name: 'triage', triggers: ['bug'] })]);
  });
});