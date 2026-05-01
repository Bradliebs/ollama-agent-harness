import * as fs from 'fs/promises';
import * as path from 'path';

export interface SkillDefinition {
  name: string;
  description: string;
  domain: string;
  triggers: string[];
  content: string;
  filePath: string;
}

export interface SkillLoadDiagnostic {
  name: string;
  filePath: string;
  reason: 'missing-skill-file' | 'unreadable-skill-file' | 'missing-frontmatter';
  message: string;
}

export interface SkillDirectoryScan {
  skills: SkillDefinition[];
  diagnostics: SkillLoadDiagnostic[];
}

export async function loadSkillsDir(skillsDir: string): Promise<SkillDefinition[]> {
  return (await scanSkillsDir(skillsDir)).skills;
}

export async function scanSkillsDir(skillsDir: string): Promise<SkillDirectoryScan> {
  const skills: SkillDefinition[] = [];
  const diagnostics: SkillLoadDiagnostic[] = [];

  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
      try {
        const content = await fs.readFile(skillFile, 'utf-8');
        const skill = parseSkillFile(content, skillFile);
        if (skill) {
          skills.push(skill);
        } else {
          diagnostics.push({
            name: entry.name,
            filePath: skillFile,
            reason: 'missing-frontmatter',
            message: 'SKILL.md exists but does not start with YAML frontmatter.',
          });
        }
      } catch (error) {
        const reason = await skillFileExists(skillFile) ? 'unreadable-skill-file' : 'missing-skill-file';
        diagnostics.push({
          name: entry.name,
          filePath: skillFile,
          reason,
          message: reason === 'missing-skill-file'
            ? 'Skill folder is missing SKILL.md.'
            : `Could not read SKILL.md: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  } catch {
    // Skills directory doesn't exist — return empty
  }

  return { skills, diagnostics };
}

async function skillFileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export function parseSkillFile(content: string, filePath: string): SkillDefinition | null {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return null;

  return {
    name: (frontmatter.name as string) ?? path.basename(path.dirname(filePath)),
    description: (frontmatter.description as string) ?? '',
    domain: (frontmatter.domain as string) ?? 'general',
    triggers: (frontmatter.triggers as string[]) ?? [],
    content: removeFrontmatter(content),
    filePath,
  };
}

function extractFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const result: Record<string, unknown> = {};

  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();

    // Remove surrounding quotes
    if (typeof value === 'string' && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  // Parse triggers array (YAML list)
  const triggersMatch = yaml.match(/triggers:\n((?:\s+-\s+.+\n?)*)/);
  if (triggersMatch) {
    result.triggers = triggersMatch[1]
      .trim()
      .split('\n')
      .map((line) => line.replace(/^\s*-\s*/, '').replace(/^"|"$/g, '').trim())
      .filter(Boolean);
  }

  return result;
}

function removeFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
}

export function matchSkillTrigger(
  skills: SkillDefinition[],
  userInput: string,
): SkillDefinition | null {
  const normalized = userInput.toLowerCase().trim();
  for (const skill of skills) {
    for (const trigger of skill.triggers) {
      if (normalized.includes(trigger.toLowerCase())) {
        return skill;
      }
    }
  }
  return null;
}
