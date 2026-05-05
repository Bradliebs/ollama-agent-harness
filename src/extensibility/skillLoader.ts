import * as fs from 'fs/promises';
import * as path from 'path';

export type SkillRiskLevel = 'low' | 'medium' | 'high';

export interface SkillDefinition {
  name: string;
  description: string;
  domain: string;
  triggers: string[];
  content: string;
  filePath: string;
  /** Optional human-readable hint for when the agent should pick this skill. */
  whenToUse?: string;
  /** Optional list of tool names this skill expects to use. */
  requiredTools?: string[];
  /** Optional risk classification used by workflow runner and UI. */
  riskLevel?: SkillRiskLevel;
  /** Optional ordered list of plain-language steps. */
  steps?: string[];
  /** Optional usage examples. */
  examples?: string[];
  /** Optional validation checks the agent should run after executing the skill. */
  validationChecks?: string[];
  /** Optional notes describing how to roll back if the skill misfires. */
  rollbackNotes?: string;
  /** Whether this skill is currently enabled. Defaults to true when omitted. */
  enabled?: boolean;
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
      // Skip internal directories like `_archive` (curator) and `_history` (undo
      // snapshots). They are scoped storage, not user-facing skills.
      if (entry.name.startsWith('_')) continue;
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

  const riskRaw = typeof frontmatter.risk_level === 'string' ? frontmatter.risk_level.toLowerCase() : '';
  const riskLevel: SkillRiskLevel | undefined = riskRaw === 'low' || riskRaw === 'medium' || riskRaw === 'high' ? riskRaw : undefined;
  const enabledRaw = frontmatter.enabled;
  // Treat omitted field as enabled. Only the literal strings/booleans `false`/`'false'`
  // count as disabled, so existing skills without the field stay live.
  const enabled: boolean | undefined = enabledRaw === undefined
    ? undefined
    : !(enabledRaw === false || (typeof enabledRaw === 'string' && enabledRaw.toLowerCase() === 'false'));

  return {
    name: (frontmatter.name as string) ?? path.basename(path.dirname(filePath)),
    description: (frontmatter.description as string) ?? '',
    domain: (frontmatter.domain as string) ?? 'general',
    triggers: normalizeStringList(frontmatter.triggers),
    content: removeFrontmatter(content),
    filePath,
    whenToUse: typeof frontmatter.when_to_use === 'string' ? frontmatter.when_to_use as string : undefined,
    requiredTools: Array.isArray(frontmatter.required_tools) ? frontmatter.required_tools as string[] : undefined,
    riskLevel,
    steps: Array.isArray(frontmatter.steps) ? frontmatter.steps as string[] : undefined,
    examples: Array.isArray(frontmatter.examples) ? frontmatter.examples as string[] : undefined,
    validationChecks: Array.isArray(frontmatter.validation_checks) ? frontmatter.validation_checks as string[] : undefined,
    rollbackNotes: typeof frontmatter.rollback_notes === 'string' ? frontmatter.rollback_notes as string : undefined,
    enabled,
  };
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
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
    result.triggers = parseYamlList(triggersMatch[1]);
  }
  for (const key of ['required_tools', 'steps', 'examples', 'validation_checks']) {
    const re = new RegExp(`${key}:\\n((?:\\s+-\\s+.+\\n?)*)`);
    const m = yaml.match(re);
    if (m) result[key] = parseYamlList(m[1]);
  }

  return result;
}

function parseYamlList(block: string): string[] {
  return block
    .trim()
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').replace(/^"|"$/g, '').trim())
    .filter(Boolean);
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
    if (skill.enabled === false) continue;
    for (const trigger of skill.triggers) {
      if (normalized.includes(trigger.toLowerCase())) {
        return skill;
      }
    }
  }
  return null;
}
