import * as path from 'path';
import { promises as fs } from 'fs';
import express from 'express';

import {
  loadSkillsDir,
  scanSkillsDir,
  type SkillDefinition,
  type SkillDirectoryScan,
} from '../extensibility/skillLoader';
import { listSkillUsage, setSkillPinned } from '../extensibility/skillUsage';
import {
  buildRuntimeSkillFile,
  sanitizeSkillText,
  sanitizeSkillBody,
  sanitizeSkillList,
  sanitizeSkillRiskLevel,
  snapshotSkillHistory,
} from '../extensibility/skillAuthoring';
import { invalidateSkillsCache } from '../tools/skillTools';
import { recordSwallowed } from '../observability/silentFailureSink';

export interface SkillRoutesDeps {
  projectDir: string;
  skillsDir: string;
  repoSkillsDir: string;
  globalSkillsDir: string;
}

type SkillApiSource = 'runtime' | 'repo' | 'global';

const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

function safeLocalId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!SAFE_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function skillFolderId(skill: SkillDefinition): string {
  return path.basename(path.dirname(skill.filePath));
}

function mapSkillForApi(source: SkillApiSource): (skill: SkillDefinition) => Record<string, unknown> {
  return (skill) => ({
    id: skillFolderId(skill),
    name: skill.name,
    description: skill.description,
    domain: skill.domain,
    triggers: skill.triggers,
    filePath: skill.filePath,
    source,
    enabled: skill.enabled !== false,
  });
}

function skillSourceForApi(source: SkillApiSource, label: string, directory: string, scan: SkillDirectoryScan, mutable: boolean): Record<string, unknown> {
  return {
    source,
    label,
    directory,
    skills: scan.skills.map(mapSkillForApi(source)),
    diagnostics: scan.diagnostics,
    mutable,
  };
}

export function createSkillRouter(deps: SkillRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir, skillsDir, repoSkillsDir, globalSkillsDir } = deps;

  router.get('/api/skills', async (_req, res) => {
    try {
      await fs.mkdir(skillsDir, { recursive: true });
      const [runtime, repo, global] = await Promise.all([
        scanSkillsDir(skillsDir),
        scanSkillsDir(repoSkillsDir),
        scanSkillsDir(globalSkillsDir),
      ]);
      res.json({
        skills: runtime.skills.map(mapSkillForApi('runtime')),
        diagnostics: runtime.diagnostics,
        sources: [
          skillSourceForApi('runtime', 'Runtime skills', skillsDir, runtime, true),
          skillSourceForApi('repo', 'Repo skills', repoSkillsDir, repo, false),
          skillSourceForApi('global', 'Global skills', globalSkillsDir, global, false),
        ],
      });
    } catch { res.json({ skills: [], diagnostics: [], sources: [] }); }
  });

  // Placed BEFORE GET /api/skills/:name so 'usage' isn't matched as a skill name.
  router.get('/api/skills/usage', async (_req, res) => {
    try {
      const records = await listSkillUsage(projectDir);
      res.json({ records });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/skills/:name', async (req, res) => {
    try {
      const skillName = safeLocalId(req.params.name);
      if (!skillName) { res.status(400).json({ error: 'Invalid skill name.' }); return; }
      if (req.query.raw === '1') {
        const skillFile = path.join(skillsDir, skillName, 'SKILL.md');
        try {
          const content = await fs.readFile(skillFile, 'utf-8');
          res.json({ name: skillName, filePath: skillFile, content });
          return;
        } catch {
          res.status(404).json({ error: 'Skill not found' });
          return;
        }
      }
      const skills = await loadSkillsDir(skillsDir);
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) { res.status(404).json({ error: 'Skill not found' }); return; }
      res.json(skill);
    } catch { res.status(500).json({ error: 'Failed to load skill' }); }
  });

  router.delete('/api/skills/:name', async (req, res) => {
    try {
      const skillName = safeLocalId(req.params.name);
      if (!skillName) { res.status(400).json({ error: 'Invalid skill name.' }); return; }
      const skillDir = path.join(skillsDir, skillName);
      await fs.rm(skillDir, { recursive: true });
      invalidateSkillsCache();
      res.json({ ok: true });
    } catch { res.status(404).json({ error: 'Skill not found' }); }
  });

  // Replace SKILL.md content for a runtime skill. Body accepts EITHER:
  //   { content: string }     -> raw markdown (must start with frontmatter)
  //   { fields: { name, description, domain, triggers, whenToUse, requiredTools, riskLevel, body } }
  //                           -> structured form, server rebuilds frontmatter
  // Before writing, the previous content is snapshotted into
  // `.harness/skills/_history/<name>/<ISO>.md` so users can revert via the
  // /history endpoints below.
  router.put('/api/skills/:name', async (req, res) => {
    const skillName = safeLocalId(req.params.name);
    if (!skillName) { res.status(400).json({ error: 'Invalid skill name.' }); return; }
    const skillFile = path.join(skillsDir, skillName, 'SKILL.md');
    let content: string;
    if (req.body?.fields && typeof req.body.fields === 'object') {
      const f = req.body.fields as Record<string, unknown>;
      content = buildRuntimeSkillFile({
        name: skillName,
        description: sanitizeSkillText(f.description, 'Describe what this skill does.', 500),
        domain: sanitizeSkillText(f.domain, 'general', 120),
        triggers: sanitizeSkillList(f.triggers, 20, 120),
        whenToUse: sanitizeSkillText(f.whenToUse, '', 800),
        requiredTools: sanitizeSkillList(f.requiredTools, 40, 80),
        riskLevel: sanitizeSkillRiskLevel(f.riskLevel),
        body: sanitizeSkillBody(f.body),
      });
    } else {
      content = typeof req.body?.content === 'string' ? req.body.content : '';
      if (!content.trim()) { res.status(400).json({ error: 'content or fields is required.' }); return; }
      if (content.length > 200_000) { res.status(413).json({ error: 'Skill content too large (max 200KB).' }); return; }
      if (!/^---\n[\s\S]*?\n---/.test(content)) {
        res.status(400).json({ error: 'Content must start with YAML frontmatter (--- ... ---).' });
        return;
      }
    }
    try {
      const existing = await fs.stat(skillFile).catch(() => null);
      if (!existing) { res.status(404).json({ error: 'Skill not found' }); return; }
      const previous = await fs.readFile(skillFile, 'utf-8').catch(() => '');
      if (previous && previous !== content) await snapshotSkillHistory(skillsDir, skillName, previous);
      await fs.writeFile(skillFile, content, 'utf-8');
      invalidateSkillsCache();
      res.json({ ok: true, name: skillName, filePath: skillFile });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // List previous SKILL.md snapshots for a runtime skill.
  router.get('/api/skills/:name/history', async (req, res) => {
    const skillName = safeLocalId(req.params.name);
    if (!skillName) { res.status(400).json({ error: 'Invalid skill name.' }); return; }
    try {
      const dir = path.join(skillsDir, '_history', skillName);
      const entries = await fs.readdir(dir).catch(() => [] as string[]);
      const versions = entries
        .filter((name) => name.endsWith('.md'))
        .sort()
        .reverse()
        .map((name) => ({ timestamp: name.replace(/\.md$/, ''), filePath: path.join(dir, name) }));
      res.json({ name: skillName, versions });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Read a single historical snapshot.
  router.get('/api/skills/:name/history/:ts', async (req, res) => {
    const skillName = safeLocalId(req.params.name);
    const ts = String(req.params.ts || '').replace(/[^A-Za-z0-9._:\-]/g, '');
    if (!skillName || !ts) { res.status(400).json({ error: 'Invalid identifier.' }); return; }
    try {
      const filePath = path.join(skillsDir, '_history', skillName, `${ts}.md`);
      const content = await fs.readFile(filePath, 'utf-8');
      res.json({ name: skillName, timestamp: ts, filePath, content });
    } catch {
      res.status(404).json({ error: 'Snapshot not found' });
    }
  });

  // Install a read-only repo skill (.github/skills/<name>) into runtime (.harness/skills/<name>).
  router.post('/api/skills/install', async (req, res) => {
    const skillName = safeLocalId(req.body?.name);
    if (!skillName) { res.status(400).json({ error: 'Invalid skill name.' }); return; }
    const overwrite = Boolean(req.body?.overwrite);
    try {
      const sourceScan = await scanSkillsDir(repoSkillsDir);
      const sourceSkill = sourceScan.skills.find((s) => skillFolderId(s) === skillName || s.name === skillName);
      if (!sourceSkill) {
        const directSourceDir = path.join(repoSkillsDir, skillName);
        const directSourceStat = await fs.stat(directSourceDir).catch(() => null);
        if (directSourceStat?.isDirectory()) {
          res.status(400).json({ error: 'Source skill is malformed and cannot be installed. Fix SKILL.md frontmatter first.' });
          return;
        }
        res.status(404).json({ error: 'Source skill not found in .github/skills.' });
        return;
      }
      const sourceDir = path.dirname(sourceSkill.filePath);
      const destinationId = skillFolderId(sourceSkill);
      const destDir = path.join(skillsDir, destinationId);
      const sourceStat = await fs.stat(sourceDir).catch(() => null);
      if (!sourceStat || !sourceStat.isDirectory()) {
        res.status(404).json({ error: 'Source skill not found in .github/skills.' });
        return;
      }
      const destStat = await fs.stat(destDir).catch(() => null);
      if (destStat && !overwrite) {
        res.status(409).json({ error: 'Runtime skill already exists. Pass overwrite=true to replace it.' });
        return;
      }
      if (destStat) await fs.rm(destDir, { recursive: true, force: true });
      await fs.mkdir(skillsDir, { recursive: true });
      await fs.cp(sourceDir, destDir, { recursive: true });
      invalidateSkillsCache();
      res.json({ ok: true, id: destinationId, name: sourceSkill.name, source: sourceDir, destination: destDir, overwrote: Boolean(destStat) });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // Create a starter SKILL.md scaffold for a runtime skill folder that is missing one.
  router.post('/api/skills/scaffold', async (req, res) => {
    const skillName = safeLocalId(req.body?.name);
    if (!skillName) { res.status(400).json({ error: 'Invalid skill name.' }); return; }
    const skillDir = path.join(skillsDir, skillName);
    const skillFile = path.join(skillDir, 'SKILL.md');
    try {
      await fs.mkdir(skillDir, { recursive: true });
      const existing = await fs.stat(skillFile).catch(() => null);
      if (existing) {
        res.status(409).json({ error: 'SKILL.md already exists. Edit the file directly to repair frontmatter.' });
        return;
      }
      const description = typeof req.body?.description === 'string' && req.body.description.trim()
        ? String(req.body.description).trim()
        : 'Describe what this skill does.';
      const domain = typeof req.body?.domain === 'string' && req.body.domain.trim()
        ? String(req.body.domain).trim()
        : 'general';
      const scaffold = `---\nname: ${skillName}\ndescription: ${description}\ndomain: ${domain}\ntriggers: []\n---\n\n# ${skillName}\n\nDescribe how to use this skill here.\n`;
      await fs.writeFile(skillFile, scaffold, 'utf-8');
      invalidateSkillsCache();
      res.json({ ok: true, name: skillName, filePath: skillFile });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/skills/create', async (req, res) => {
    const skillName = safeLocalId(req.body?.name);
    if (!skillName) { res.status(400).json({ error: 'Invalid skill name.' }); return; }
    const overwrite = req.body?.overwrite === true;
    const skillDir = path.join(skillsDir, skillName);
    const skillFile = path.join(skillDir, 'SKILL.md');
    try {
      const existing = await fs.stat(skillFile).catch(() => null);
      if (existing && !overwrite) {
        res.status(409).json({ error: 'Runtime skill already exists. Pass overwrite=true to replace it.' });
        return;
      }
      await fs.mkdir(skillDir, { recursive: true });
      const scaffold = buildRuntimeSkillFile({
        name: skillName,
        description: sanitizeSkillText(req.body?.description, 'Describe what this skill does.', 500),
        domain: sanitizeSkillText(req.body?.domain, 'general', 120),
        triggers: sanitizeSkillList(req.body?.triggers, 20, 120),
        whenToUse: sanitizeSkillText(req.body?.whenToUse, '', 800),
        requiredTools: sanitizeSkillList(req.body?.requiredTools, 40, 80),
        riskLevel: sanitizeSkillRiskLevel(req.body?.riskLevel),
        body: sanitizeSkillBody(req.body?.content),
      });
      await fs.writeFile(skillFile, scaffold, 'utf-8');
      invalidateSkillsCache();
      res.json({ ok: true, name: skillName, filePath: skillFile, overwritten: Boolean(existing) });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/skills/automation/repair', async (_req, res) => {
    try {
      await fs.mkdir(skillsDir, { recursive: true });
      const [runtime, repo] = await Promise.all([
        scanSkillsDir(skillsDir),
        scanSkillsDir(repoSkillsDir),
      ]);
      const runtimeNames = new Set(runtime.skills.map((skill) => skill.name));
      const runtimeIds = new Set(runtime.skills.map(skillFolderId));
      const installed: Array<{ id: string; name: string; source: string; destination: string }> = [];
      const scaffolded: Array<{ id: string; filePath: string }> = [];
      const skipped: Array<{ id: string; reason: string }> = [];

      for (const skill of repo.skills) {
        const id = skillFolderId(skill);
        const destination = path.join(skillsDir, id);
        const destinationExists = await fs.stat(destination).catch(() => null);
        if (runtimeNames.has(skill.name) || runtimeIds.has(id) || destinationExists) {
          skipped.push({ id, reason: 'runtime skill already exists' });
          continue;
        }
        await fs.cp(path.dirname(skill.filePath), destination, { recursive: true });
        installed.push({ id, name: skill.name, source: path.dirname(skill.filePath), destination });
        runtimeNames.add(skill.name);
        runtimeIds.add(id);
      }

      for (const diagnostic of runtime.diagnostics) {
        if (diagnostic.reason !== 'missing-skill-file') {
          skipped.push({ id: diagnostic.name, reason: `manual repair required: ${diagnostic.reason}` });
          continue;
        }
        const id = safeLocalId(diagnostic.name);
        if (!id) {
          skipped.push({ id: diagnostic.name, reason: 'invalid runtime skill folder name' });
          continue;
        }
        const skillDir = path.join(skillsDir, id);
        const skillFile = path.join(skillDir, 'SKILL.md');
        const existing = await fs.stat(skillFile).catch(() => null);
        if (existing) {
          skipped.push({ id, reason: 'SKILL.md already exists' });
          continue;
        }
        const scaffold = `---\nname: ${id}\ndescription: Describe what this skill does.\ndomain: general\ntriggers: []\n---\n\n# ${id}\n\nDescribe how to use this skill here.\n`;
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(skillFile, scaffold, 'utf-8');
        scaffolded.push({ id, filePath: skillFile });
      }

      if (installed.length > 0 || scaffolded.length > 0) invalidateSkillsCache();
      res.json({ ok: true, installed, scaffolded, skipped });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // Pin / unpin a skill so the curator never archives it.
  router.post('/api/skills/:name/pin', async (req, res) => {
    const skillName = safeLocalId(req.params.name);
    if (!skillName) { res.status(400).json({ error: 'Invalid skill name.' }); return; }
    const desired = req.body?.pinned === undefined ? true : Boolean(req.body.pinned);
    try {
      const record = await setSkillPinned(projectDir, skillName, desired);
      res.json({ ok: true, record });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Enable / disable a runtime skill by rewriting the `enabled:` line in its SKILL.md
  // frontmatter. Disabled skills stay on disk but are skipped by trigger matching.
  router.post('/api/skills/:name/enabled', async (req, res) => {
    const skillName = safeLocalId(req.params.name);
    if (!skillName) { res.status(400).json({ error: 'Invalid skill name.' }); return; }
    const enabled = req.body?.enabled === undefined ? true : Boolean(req.body.enabled);
    const skillFile = path.join(skillsDir, skillName, 'SKILL.md');
    try {
      const content = await fs.readFile(skillFile, 'utf-8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) { res.status(400).json({ error: 'SKILL.md is missing YAML frontmatter.' }); return; }
      const yaml = fmMatch[1];
      const enabledLine = `enabled: ${enabled ? 'true' : 'false'}`;
      let newYaml: string;
      if (/^enabled:\s*.*$/m.test(yaml)) {
        newYaml = yaml.replace(/^enabled:\s*.*$/m, enabledLine);
      } else {
        newYaml = `${yaml}\n${enabledLine}`;
      }
      const newContent = content.replace(/^---\n[\s\S]*?\n---/, `---\n${newYaml}\n---`);
      await fs.writeFile(skillFile, newContent, 'utf-8');
      invalidateSkillsCache();
      res.json({ ok: true, name: skillName, enabled });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500).json({ error: msg });
    }
  });

  return router;
}
