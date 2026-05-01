import * as fs from 'fs/promises';
import * as path from 'path';
import { loadSkillsDir } from './skillLoader';

export type ExtensionManifestKind = 'plugin' | 'skill';

export interface ExtensionManifest {
  kind: ExtensionManifestKind;
  name: string;
  description: string;
  version: string;
  source: 'project';
  filePath: string;
  enabled: boolean;
  providesTools: string[];
  providesHooks: string[];
  triggers: string[];
}

export async function discoverExtensionManifests(projectDir: string): Promise<ExtensionManifest[]> {
  const [plugins, skills] = await Promise.all([
    discoverPluginManifests(path.join(projectDir, '.harness', 'plugins')),
    discoverSkillManifests(path.join(projectDir, '.harness', 'skills')),
  ]);
  return [...plugins, ...skills].sort((a, b) => a.name.localeCompare(b.name) || a.filePath.localeCompare(b.filePath));
}

async function discoverPluginManifests(pluginsDir: string): Promise<ExtensionManifest[]> {
  const files = await findManifestFiles(pluginsDir);
  const manifests: ExtensionManifest[] = [];
  for (const filePath of files) {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = filePath.endsWith('.json') ? JSON.parse(raw) as Record<string, unknown> : parseSimpleYaml(raw);
      const name = stringField(parsed.name) || path.basename(path.dirname(filePath));
      manifests.push({
        kind: 'plugin',
        name,
        description: stringField(parsed.description),
        version: stringField(parsed.version),
        source: 'project',
        filePath,
        enabled: parsed.enabled !== false,
        providesTools: stringList(parsed.providesTools ?? parsed.provides_tools),
        providesHooks: stringList(parsed.providesHooks ?? parsed.provides_hooks),
        triggers: [],
      });
    } catch {
      // Ignore malformed extension manifests during discovery.
    }
  }
  return manifests;
}

async function discoverSkillManifests(skillsDir: string): Promise<ExtensionManifest[]> {
  const skills = await loadSkillsDir(skillsDir);
  return skills.map((skill) => ({
    kind: 'skill',
    name: skill.name,
    description: skill.description,
    version: '',
    source: 'project',
    filePath: skill.filePath,
    enabled: true,
    providesTools: [],
    providesHooks: [],
    triggers: skill.triggers,
  }));
}

async function findManifestFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) results.push(...await findManifestFiles(entryPath));
      else if (entry.name === 'plugin.json' || entry.name === 'plugin.yaml' || entry.name === 'plugin.yml') results.push(entryPath);
    }
  } catch {
    return [];
  }
  return results;
}

function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (value) {
      result[key] = value.replace(/^['"]|['"]$/g, '');
      continue;
    }
    const values: string[] = [];
    while (index + 1 < lines.length) {
      const listMatch = lines[index + 1].match(/^\s*-\s*(.+)$/);
      if (!listMatch) break;
      values.push(listMatch[1].trim().replace(/^['"]|['"]$/g, ''));
      index++;
    }
    result[key] = values;
  }
  return result;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
}