import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { loadSkillsFromDirs, matchSkillTrigger, parseSkillFile, type SkillDefinition } from '../extensibility/skillLoader';
import { recordSkillUse, recordSkillView } from '../extensibility/skillUsage';

let cachedSkills: SkillDefinition[] | null = null;
let cachedSkillsPromise: Promise<SkillDefinition[]> | null = null;
let skillsDir = '';
// Lower-precedence tiers (e.g. a global ~/.harness/skills shared across
// workspaces). The workspace `skillsDir` always wins on name collisions.
let lowerTierDirs: string[] = [];
let projectDirForUsage = '';

export function setSkillsDir(dir: string): void {
  skillsDir = dir;
  cachedSkills = null;
  cachedSkillsPromise = null;
  // Skills directory is .harness/skills, so the project dir is two levels up.
  projectDirForUsage = path.dirname(path.dirname(dir));
}

/**
 * Register additional skill directories that the agent can invoke, ordered
 * low-to-high precedence. They rank below the workspace `skillsDir`, so a
 * workspace skill shadows a global one of the same name.
 */
export function setLowerSkillTiers(dirs: string[]): void {
  lowerTierDirs = [...dirs];
  cachedSkills = null;
  cachedSkillsPromise = null;
}

export function invalidateSkillsCache(): void {
  cachedSkills = null;
  cachedSkillsPromise = null;
}

async function getSkills(): Promise<SkillDefinition[]> {
  if (cachedSkills) return cachedSkills;
  if (!skillsDir && lowerTierDirs.length === 0) return [];
  // Dedup concurrent loads so first-call avalanches don't all hit disk.
  if (cachedSkillsPromise) return cachedSkillsPromise;
  // Low-to-high precedence: lower tiers first, workspace skills last (they win).
  const dirs = skillsDir ? [...lowerTierDirs, skillsDir] : [...lowerTierDirs];
  cachedSkillsPromise = loadSkillsFromDirs(dirs).then(
    (skills) => { cachedSkills = skills; cachedSkillsPromise = null; return skills; },
    (err) => { cachedSkillsPromise = null; throw err; },
  );
  return cachedSkillsPromise;
}

/**
 * SkillTool — meta-tool that the agent calls to invoke a skill by name.
 * When invoked, returns the skill's instructions as context for the model.
 * (Paper §6.1: "SkillTool injects the skill's instructions into the context")
 */
export const SkillTool: Tool = {
  name: 'skill',
  description: 'Invoke a skill by name to get domain-specific instructions. Call list_skills first to see available skills.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name of the skill to invoke' },
    },
    required: ['name'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const name = input.name as string;
    const skills = await getSkills();
    const skill = skills.find(s => s.name.toLowerCase() === name.toLowerCase());

    if (!skill) {
      const available = skills.map(s => s.name).join(', ') || '(none)';
      return {
        success: false,
        output: `Skill '${name}' not found. Available skills: ${available}`,
        error: 'Skill not found',
      };
    }

    if (projectDirForUsage) {
      // Best-effort usage tracking; never fail the tool call if this errors.
      recordSkillUse(projectDirForUsage, skill.name).catch(() => {});
    }

    const bundled = await listBundledResources(skill.filePath);
    const bundledSection = bundled.length > 0
      ? `\n\n--- Bundled resources ---\nThe following files live alongside SKILL.md. Use file_read to view text/markdown or bash to execute scripts. They are NOT loaded into your context until you read them.\n${bundled.map(b => `📎 ${b.relPath} (${b.sizeLabel})`).join('\n')}`
      : '';

    return {
      success: true,
      output: `--- Skill: ${skill.name} ---\n${skill.description}\n\n${skill.content}${bundledSection}`,
    };
  },
};

/** Maximum number of bundled resources surfaced when a skill is invoked. */
const MAX_BUNDLED_RESOURCES = 20;
/** Maximum directory recursion depth when scanning for bundled resources. */
const MAX_BUNDLED_DEPTH = 2;

interface BundledResource {
  relPath: string;
  sizeLabel: string;
}

/**
 * Lists files in the skill directory other than SKILL.md so the model knows
 * what Level-3 (Anthropic spec) bundled resources exist. Recurses one level
 * deep to keep output tight; agents can always `bash ls` for deeper trees.
 */
async function listBundledResources(skillFilePath: string): Promise<BundledResource[]> {
  const skillDir = path.dirname(skillFilePath);
  const results: BundledResource[] = [];
  await collectBundled(skillDir, skillDir, 0, results);
  results.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return results.slice(0, MAX_BUNDLED_RESOURCES);
}

async function collectBundled(
  rootDir: string,
  currentDir: string,
  depth: number,
  acc: BundledResource[],
): Promise<void> {
  if (depth > MAX_BUNDLED_DEPTH) return;
  if (acc.length >= MAX_BUNDLED_RESOURCES) return;
  let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[];
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (acc.length >= MAX_BUNDLED_RESOURCES) return;
    // Skip dotfiles, the SKILL.md itself, and provenance backups created by install_skill.
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'SKILL.md') continue;
    if (entry.name.startsWith('SKILL.md.backup-')) continue;
    const absolute = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectBundled(rootDir, absolute, depth + 1, acc);
    } else if (entry.isFile()) {
      let size = 0;
      try {
        const stat = await fs.stat(absolute);
        size = stat.size;
      } catch { /* ignore */ }
      acc.push({
        relPath: path.relative(rootDir, absolute).split(path.sep).join('/'),
        sizeLabel: formatSize(size),
      });
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * ListSkillsTool — lists all available skills with descriptions.
 */
export const ListSkillsTool: Tool = {
  name: 'list_skills',
  description: 'List all available skills. Returns skill names, descriptions, and trigger phrases.',
  parameters: { type: 'object', properties: {} },
  isReadOnly: true,
  async execute(): Promise<ToolResult> {
    const skills = await getSkills();
    if (skills.length === 0) {
      return { success: true, output: 'No skills installed. Use create_skill to create one.' };
    }

    if (projectDirForUsage) {
      // Surface = view event for every listed skill (best-effort).
      for (const skill of skills) {
        recordSkillView(projectDirForUsage, skill.name).catch(() => {});
      }
    }

    const listing = skills.map(s =>
      `• **${s.name}** — ${s.description}\n  Triggers: ${s.triggers.join(', ') || '(none)'}`
    ).join('\n');

    return { success: true, output: `Available skills (${skills.length}):\n\n${listing}` };
  },
};

/**
 * CreateSkillTool — the agent creates a new SKILL.md file.
 * This is the key "self-improving" capability from the paper:
 * the agent learns patterns and encodes them as reusable skills.
 * (Paper §2.1 Contextual Adaptability + §7.2 Auto Memory)
 */
export const CreateSkillTool: Tool = {
  name: 'create_skill',
  description: 'Create a new skill that teaches you (the AI) how to handle a specific type of task. The skill is saved as a SKILL.md file and becomes available for future conversations.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name in kebab-case (e.g. "python-debugging")' },
      description: { type: 'string', description: 'One-line description of what the skill does' },
      domain: { type: 'string', description: 'Domain category (e.g. "debugging", "code-review", "testing")' },
      triggers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Phrases that should activate this skill (e.g. ["debug python", "fix python error"])',
      },
      instructions: { type: 'string', description: 'The full skill instructions in Markdown. Include: Context, Patterns, Examples, and Anti-Patterns sections.' },
    },
    required: ['name', 'description', 'instructions'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const name = input.name as string;
    const description = input.description as string;
    const domain = (input.domain as string) ?? 'general';
    const triggers = (input.triggers as string[]) ?? [];
    const instructions = input.instructions as string;

    // Validate name
    if (!/^[a-z0-9-]+$/.test(name)) {
      return { success: false, output: 'Skill name must be kebab-case (lowercase, hyphens only)', error: 'invalid name' };
    }

    // Build SKILL.md content
    const triggerYaml = triggers.length > 0
      ? `triggers:\n${triggers.map(t => `  - "${t}"`).join('\n')}\n`
      : '';

    const content = `---
name: "${name}"
description: "${description}"
domain: "${domain}"
confidence: "medium"
source: "self-created by agent"
${triggerYaml}---

${instructions}
`;

    // Write to skills directory
    const dir = skillsDir || path.join(process.cwd(), '.harness', 'skills');
    const skillDir = path.join(dir, name);
    const skillPath = path.join(skillDir, 'SKILL.md');

    try {
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(skillPath, content, 'utf-8');

      // Invalidate cache so the new skill is available immediately
      invalidateSkillsCache();

      return {
        success: true,
        output: `✅ Skill '${name}' created at ${skillPath}\n\nIt's now available — invoke it with: skill(name: "${name}")`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to create skill: ${msg}`, error: msg };
    }
  },
};
