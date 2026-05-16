import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { parseSkillFile } from '../extensibility/skillLoader';
import { getAllowedExternalPaths } from './pathResolution';
import { invalidateSkillsCache } from './skillTools';

// ─── Import skill from a local folder ───────────────────────────────────────
//
// Bulk-import an entire skill bundle (SKILL.md + any sibling files like
// FORMS.md, scripts/, REFERENCE.md) from a local folder into the harness
// skills directory. Complements install_skill, which downloads a single
// SKILL.md file from an allowlisted URL.
//
// This is how the harness consumes Anthropic-format skill bundles
// (https://github.com/anthropics/skills) without coupling to any model
// or vendor API: `git clone` the repo first, then point this tool at the
// local subdirectory.
//
// Safety: the source folder must live inside the project root or inside
// one of the Allowed External Paths (Settings → Allowed External Paths).

let skillsDirOverride = '';
let projectRootOverride = '';
export function setImportSkillsDir(dir: string): void {
  skillsDirOverride = dir;
  // Skills directory is <project>/.harness/skills, so the project root is two
  // levels up. Mirrors the convention used by setSkillsDir() in skillTools.ts.
  projectRootOverride = dir ? path.dirname(path.dirname(dir)) : '';
}

const MAX_BUNDLE_BYTES = 5 * 1024 * 1024; // 5 MB total bundle cap
const MAX_BUNDLE_FILES = 200;
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.venv', '__pycache__', 'dist', 'build']);

export const ImportSkillTool: Tool = {
  name: 'import_skill',
  description: 'Import an entire skill bundle (SKILL.md + bundled files like FORMS.md or scripts/) from a local folder into the harness skills directory. Use this to drop in an Anthropic-format skill that you have already cloned or downloaded. The source folder must live inside the project or under an Allowed External Path.',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Absolute or project-relative path to a folder containing SKILL.md.' },
      name: { type: 'string', description: 'Optional kebab-case override for the installed skill name (defaults to the folder name).' },
      overwrite: { type: 'boolean', description: 'When true, replace an existing skill of the same name. Defaults to false.' },
    },
    required: ['source'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const sourceRaw = String(input.source ?? '').trim();
    if (!sourceRaw) {
      return { success: false, output: 'source is required.', error: 'missing source' };
    }
    const overwrite = input.overwrite === true;
    const nameOverride = typeof input.name === 'string' ? input.name.trim() : '';

    const sourceAbs = path.resolve(sourceRaw);

    // Source must live inside the project root or an Allowed External Path.
    const projectRoot = projectRootOverride || process.cwd();
    const allowed = getAllowedExternalPaths();
    if (!isInsideAny(sourceAbs, [projectRoot, ...allowed])) {
      return {
        success: false,
        output: `Source folder is outside the project and not under an Allowed External Path: ${sourceAbs}\nAdd its parent in Settings → Allowed External Paths or move the folder into the project.`,
        error: 'source not allowed',
      };
    }

    // Source must be a directory containing SKILL.md.
    let sourceStat;
    try {
      sourceStat = await fs.stat(sourceAbs);
    } catch (error) {
      return {
        success: false,
        output: `Source folder not found: ${sourceAbs}`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!sourceStat.isDirectory()) {
      return { success: false, output: `Source must be a directory, got a file: ${sourceAbs}`, error: 'not a directory' };
    }

    const sourceSkillFile = path.join(sourceAbs, 'SKILL.md');
    let skillContent: string;
    try {
      skillContent = await fs.readFile(sourceSkillFile, 'utf-8');
    } catch {
      return {
        success: false,
        output: `Source folder does not contain SKILL.md: ${sourceAbs}`,
        error: 'missing SKILL.md',
      };
    }

    const parsed = parseSkillFile(skillContent, sourceSkillFile);
    if (!parsed) {
      return {
        success: false,
        output: 'SKILL.md exists but does not have valid YAML frontmatter (need at least name and description).',
        error: 'invalid frontmatter',
      };
    }

    // Decide the installed skill name.
    const skillName = nameOverride || parsed.name || path.basename(sourceAbs);
    if (!/^[a-z0-9-]+$/.test(skillName)) {
      return {
        success: false,
        output: `Skill name "${skillName}" must be kebab-case (lowercase letters, digits, hyphens). Pass an override via the "name" argument.`,
        error: 'invalid name',
      };
    }

    const skillsDir = skillsDirOverride || path.join(projectRootOverride || process.cwd(), '.harness', 'skills');
    const destDir = path.join(skillsDir, skillName);

    // Reject if destination exists unless overwrite is explicit.
    let destExists = false;
    try {
      await fs.access(destDir);
      destExists = true;
    } catch { /* not present — proceed */ }
    if (destExists && !overwrite) {
      return {
        success: false,
        output: `A skill named "${skillName}" already exists at ${destDir}. Pass overwrite: true to replace it (the existing folder will be removed).`,
        error: 'destination exists',
      };
    }

    // Walk the source bundle to enforce size and file caps before any copy.
    const planned: { src: string; rel: string; size: number }[] = [];
    let totalBytes = 0;
    try {
      await planCopy(sourceAbs, sourceAbs, planned);
    } catch (error) {
      return {
        success: false,
        output: `Failed to scan source bundle: ${error instanceof Error ? error.message : String(error)}`,
        error: 'scan failed',
      };
    }
    if (planned.length === 0) {
      return { success: false, output: 'Source bundle is empty.', error: 'empty bundle' };
    }
    if (planned.length > MAX_BUNDLE_FILES) {
      return {
        success: false,
        output: `Bundle has ${planned.length} files, max is ${MAX_BUNDLE_FILES}. Trim it or open an issue if you really need a larger bundle.`,
        error: 'too many files',
      };
    }
    for (const entry of planned) totalBytes += entry.size;
    if (totalBytes > MAX_BUNDLE_BYTES) {
      return {
        success: false,
        output: `Bundle is ${(totalBytes / (1024 * 1024)).toFixed(1)} MB, max is ${(MAX_BUNDLE_BYTES / (1024 * 1024)).toFixed(0)} MB.`,
        error: 'too large',
      };
    }

    // Perform the copy. Remove first if overwriting.
    try {
      if (destExists) {
        await fs.rm(destDir, { recursive: true, force: true });
      }
      await fs.mkdir(destDir, { recursive: true });
      for (const entry of planned) {
        const destPath = path.join(destDir, entry.rel);
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.copyFile(entry.src, destPath);
      }
    } catch (error) {
      return {
        success: false,
        output: `Copy failed: ${error instanceof Error ? error.message : String(error)}`,
        error: 'copy failed',
      };
    }

    // Append provenance to the installed SKILL.md so the source is traceable.
    try {
      const provenance = `\n\n<!-- imported-from: ${sourceAbs} -->\n<!-- imported-at: ${new Date().toISOString()} -->\n`;
      await fs.appendFile(path.join(destDir, 'SKILL.md'), provenance, 'utf-8');
    } catch { /* non-fatal */ }

    invalidateSkillsCache();

    const bundledCount = planned.length - 1; // minus SKILL.md
    const bundledNote = bundledCount > 0
      ? ` along with ${bundledCount} bundled file(s)`
      : '';
    return {
      success: true,
      output: `✅ Imported skill "${skillName}" from ${sourceAbs}${bundledNote}. Invoke it with: skill(name: "${skillName}")`,
    };
  },
};

function isInsideAny(child: string, parents: string[]): boolean {
  for (const parent of parents) {
    if (!parent) continue;
    const resolvedParent = path.resolve(parent);
    if (child === resolvedParent) return true;
    const rel = path.relative(resolvedParent, child);
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return true;
    }
  }
  return false;
}

async function planCopy(
  rootDir: string,
  currentDir: string,
  acc: { src: string; rel: string; size: number }[],
): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // skip dotfiles/dotdirs
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      await planCopy(rootDir, path.join(currentDir, entry.name), acc);
      continue;
    }
    if (!entry.isFile()) continue;
    const abs = path.join(currentDir, entry.name);
    const rel = path.relative(rootDir, abs).split(path.sep).join('/');
    let size = 0;
    try {
      const stat = await fs.stat(abs);
      size = stat.size;
    } catch { /* skip unreadable */ }
    acc.push({ src: abs, rel, size });
  }
}
