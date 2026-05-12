import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { parseSkillFile } from '../extensibility/skillLoader';

// ─── Install skill from URL tool ────────────────────────────────────
//
// Downloads a SKILL.md file from a URL and installs it into the local
// skills directory. Creates a snapshot-friendly backup before install.
//
// Capability: auto-install-third-party-skills (gated)
// Risk: medium — downloads external content but validates skill format

let skillsDir = '';
export function setInstallSkillsDir(dir: string): void { skillsDir = dir; }

const MAX_SKILL_SIZE = 100_000;
const ALLOWED_HOSTS = new Set([
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'gitlab.com',
]);

export const InstallSkillTool: Tool = {
  name: 'install_skill',
  description: 'Install a skill from a URL (GitHub raw, Gist, or GitLab). Downloads the SKILL.md, validates its format, and saves it to the local skills directory. Requires auto-install-third-party-skills capability grant.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to a raw SKILL.md file (must be from GitHub, Gist, or GitLab)' },
      name: { type: 'string', description: 'Optional override for the skill directory name (kebab-case)' },
    },
    required: ['url'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const url = String(input.url ?? '').trim();
    if (!url) return { success: false, output: 'URL is required.', error: 'missing url' };

    // Validate URL host
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { success: false, output: 'Invalid URL.', error: 'invalid url' };
    }
    if (!ALLOWED_HOSTS.has(parsed.hostname)) {
      return {
        success: false,
        output: `Host "${parsed.hostname}" is not in the allowlist. Allowed: ${Array.from(ALLOWED_HOSTS).join(', ')}`,
        error: 'host not allowed',
      };
    }
    if (parsed.protocol !== 'https:') {
      return { success: false, output: 'Only HTTPS URLs are allowed.', error: 'not https' };
    }

    // Download the skill file
    let content: string;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) {
        return { success: false, output: `Download failed: HTTP ${response.status}`, error: `http ${response.status}` };
      }
      content = await response.text();
      if (content.length > MAX_SKILL_SIZE) {
        return { success: false, output: `Skill file too large (${content.length} bytes, max ${MAX_SKILL_SIZE}).`, error: 'too large' };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Download failed: ${msg}`, error: msg };
    }

    // Validate skill format
    const skill = parseSkillFile(content, 'downloaded');
    if (!skill) {
      return { success: false, output: 'Downloaded file is not a valid SKILL.md (missing or invalid YAML frontmatter with name and description).', error: 'invalid skill format' };
    }

    // Determine skill name
    const nameOverride = typeof input.name === 'string' ? input.name.trim() : '';
    const skillName = nameOverride || skill.name;
    if (!/^[a-z0-9-]+$/.test(skillName)) {
      return { success: false, output: `Skill name "${skillName}" must be kebab-case.`, error: 'invalid name' };
    }

    // Install to skills directory
    const dir = skillsDir || path.join(process.cwd(), '.harness', 'skills');
    const skillDir = path.join(dir, skillName);
    const skillPath = path.join(skillDir, 'SKILL.md');

    // Check if already exists
    try {
      await fs.access(skillPath);
      // Back up existing skill
      const backup = path.join(skillDir, `SKILL.md.backup-${Date.now()}`);
      await fs.copyFile(skillPath, backup);
    } catch { /* doesn't exist yet — good */ }

    try {
      await fs.mkdir(skillDir, { recursive: true });
      // Add provenance metadata
      const provenance = `\n\n<!-- installed-from: ${url} -->\n<!-- installed-at: ${new Date().toISOString()} -->\n`;
      await fs.writeFile(skillPath, content + provenance, 'utf-8');

      return {
        success: true,
        output: `Skill "${skillName}" installed from ${parsed.hostname}. Description: ${skill.description}. Use it by saying: ${skill.triggers.length > 0 ? skill.triggers[0] : skillName}`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Install failed: ${msg}`, error: msg };
    }
  },
};
