import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { loadSkillsDir, matchSkillTrigger, type SkillDefinition } from '../extensibility/skillLoader';

let cachedSkills: SkillDefinition[] | null = null;
let skillsDir = '';

export function setSkillsDir(dir: string): void {
  skillsDir = dir;
  cachedSkills = null;
}

async function getSkills(): Promise<SkillDefinition[]> {
  if (cachedSkills) return cachedSkills;
  if (!skillsDir) return [];
  cachedSkills = await loadSkillsDir(skillsDir);
  return cachedSkills;
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

    return {
      success: true,
      output: `--- Skill: ${skill.name} ---\n${skill.description}\n\n${skill.content}`,
    };
  },
};

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
      cachedSkills = null;

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
