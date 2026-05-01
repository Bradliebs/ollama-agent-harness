// Skill Curator.
//
// Phase 1 (deterministic): identifies skills as "stale" based on usage
// metadata (last use, view count, age) and archives unpinned ones by moving
// the skill folder to .harness/skills/_archive/<name>/. Archive is reversible
// via restoreSkill.
//
// Phase 2 (LLM): asks the configured model to identify clusters of related
// skills and propose merges into umbrella skills. The first version writes
// proposals to .harness/curator/proposals.md for human review rather than
// auto-merging — gives the user a chance to see what the model suggests
// before granting it autonomous skill rewrite power.
//
// Both phases honor:
//   - Pinned skills are never touched.
//   - The global kill switch (passed in via deps).
//   - A maximum-actions-per-run cap so a misbehaving curator can't nuke the
//     library in one go.

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../core/logger';
import { runtimeTracer } from '../core/tracing';
import { scanSkillsDir, type SkillDefinition } from '../extensibility/skillLoader';
import { loadSkillUsage, saveSkillUsage, setSkillArchived, type SkillUsageRecord, type SkillUsageStore } from '../extensibility/skillUsage';

export interface CuratorConfig {
  /** Days without use before a skill is considered stale. */
  staleDays: number;
  /** A skill must have at least this many views before it can be archived (protects fresh skills with low use). */
  minViewsBeforeArchive: number;
  /** Maximum number of skills the curator may archive in a single run. */
  maxArchivePerRun: number;
  /** When false, Phase 2 (LLM merge proposals) is skipped. */
  enableLlmPhase: boolean;
}

export const DEFAULT_CURATOR_CONFIG: CuratorConfig = {
  staleDays: 60,
  minViewsBeforeArchive: 1,
  maxArchivePerRun: 5,
  enableLlmPhase: false,
};

export type CuratorActionKind = 'archive' | 'restore' | 'merge-proposed' | 'skip-pinned' | 'skip-active' | 'skip-cap';

export interface CuratorAction {
  kind: CuratorActionKind;
  skill: string;
  reason: string;
  ageDays?: number;
  daysSinceUse?: number;
  viewCount?: number;
  useCount?: number;
}

export interface CuratorRunSummary {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  staleCandidates: CuratorAction[];
  archived: CuratorAction[];
  proposals?: string;
  proposalsPath?: string;
  llmSkipped?: string;
}

export interface CuratorDeps {
  /** Async function that returns true when the global kill switch is engaged. */
  isKillSwitchActive(): boolean;
  /** Optional LLM call used by Phase 2. Receives a prompt, returns the response text. */
  callModel?(prompt: string): Promise<string>;
}

const ARCHIVE_DIR_NAME = '_archive';

function curatorDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'curator');
}

function logFile(projectDir: string): string {
  return path.join(curatorDir(projectDir), 'log.jsonl');
}

function proposalsFile(projectDir: string): string {
  return path.join(curatorDir(projectDir), 'proposals.md');
}

function skillsDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'skills');
}

function archiveDir(projectDir: string): string {
  return path.join(skillsDir(projectDir), ARCHIVE_DIR_NAME);
}

async function appendAuditLog(projectDir: string, entry: Record<string, unknown>): Promise<void> {
  await fs.mkdir(curatorDir(projectDir), { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
  await fs.appendFile(logFile(projectDir), line, 'utf-8');
}

/**
 * Phase 1: identify skills the curator considers stale. Pure function over
 * loaded definitions and usage records. Always safe to call.
 */
export function findStaleSkills(
  skills: SkillDefinition[],
  usage: SkillUsageStore,
  config: CuratorConfig,
  now: Date = new Date(),
): CuratorAction[] {
  const actions: CuratorAction[] = [];
  const cutoffMs = now.getTime() - config.staleDays * 24 * 60 * 60 * 1000;
  for (const skill of skills) {
    const record = usage.records[skill.name];
    if (record?.pinned) {
      actions.push({ kind: 'skip-pinned', skill: skill.name, reason: 'Pinned by user.' });
      continue;
    }
    if (record?.archived) {
      // Already archived; skip silently.
      continue;
    }
    const lastTouch = record?.lastUsedAt ?? record?.lastViewedAt ?? record?.firstSeenAt;
    if (!lastTouch) {
      // No usage record yet — too fresh to judge.
      actions.push({ kind: 'skip-active', skill: skill.name, reason: 'No usage record yet.' });
      continue;
    }
    const lastTouchMs = Date.parse(lastTouch);
    if (!Number.isFinite(lastTouchMs)) continue;
    if (lastTouchMs >= cutoffMs) {
      actions.push({ kind: 'skip-active', skill: skill.name, reason: `Used within the last ${config.staleDays} days.` });
      continue;
    }
    const viewCount = record?.viewCount ?? 0;
    if (viewCount < config.minViewsBeforeArchive) {
      actions.push({ kind: 'skip-active', skill: skill.name, reason: `Below view threshold (${viewCount}/${config.minViewsBeforeArchive}).` });
      continue;
    }
    const ageDays = Math.round((now.getTime() - Date.parse(record?.firstSeenAt ?? lastTouch)) / (24 * 60 * 60 * 1000));
    const daysSinceUse = Math.round((now.getTime() - lastTouchMs) / (24 * 60 * 60 * 1000));
    actions.push({
      kind: 'archive',
      skill: skill.name,
      reason: `Stale: ${daysSinceUse} days since last touch (threshold ${config.staleDays}).`,
      ageDays,
      daysSinceUse,
      viewCount,
      useCount: record?.useCount ?? 0,
    });
  }
  return actions;
}

/**
 * Move a skill folder into the archive subdirectory and update the usage record.
 * Reversible via restoreSkill.
 */
export async function archiveSkill(projectDir: string, name: string): Promise<{ from: string; to: string }> {
  const sourceDir = path.join(skillsDir(projectDir), name);
  const destDir = path.join(archiveDir(projectDir), name);
  await fs.mkdir(archiveDir(projectDir), { recursive: true });
  await fs.rename(sourceDir, destDir);
  await setSkillArchived(projectDir, name, true);
  return { from: sourceDir, to: destDir };
}

export async function restoreSkill(projectDir: string, name: string): Promise<{ from: string; to: string }> {
  const sourceDir = path.join(archiveDir(projectDir), name);
  const destDir = path.join(skillsDir(projectDir), name);
  await fs.rename(sourceDir, destDir);
  await setSkillArchived(projectDir, name, false);
  return { from: sourceDir, to: destDir };
}

export async function runDeterministicPhase(
  projectDir: string,
  config: CuratorConfig,
  deps: CuratorDeps,
  options: { dryRun?: boolean } = {},
): Promise<CuratorRunSummary> {
  const startedAt = new Date().toISOString();
  if (deps.isKillSwitchActive()) {
    const skipped: CuratorRunSummary = {
      startedAt,
      finishedAt: new Date().toISOString(),
      dryRun: Boolean(options.dryRun),
      staleCandidates: [],
      archived: [],
      llmSkipped: 'kill switch active',
    };
    await appendAuditLog(projectDir, { phase: 'deterministic', skipped: 'kill switch active' });
    return skipped;
  }

  const scan = await scanSkillsDir(skillsDir(projectDir));
  const usage = await loadSkillUsage(projectDir);
  const candidates = findStaleSkills(scan.skills, usage, config);
  const archiveCandidates = candidates.filter((action) => action.kind === 'archive');
  const archived: CuratorAction[] = [];

  if (!options.dryRun) {
    let count = 0;
    for (const candidate of archiveCandidates) {
      if (count >= config.maxArchivePerRun) {
        archived.push({ kind: 'skip-cap', skill: candidate.skill, reason: `Per-run cap (${config.maxArchivePerRun}) reached.` });
        continue;
      }
      try {
        await archiveSkill(projectDir, candidate.skill);
        archived.push({ ...candidate });
        await appendAuditLog(projectDir, { phase: 'deterministic', action: 'archive', skill: candidate.skill, reason: candidate.reason });
        runtimeTracer.recordEvent('curator.archive', { skill: candidate.skill, reason: candidate.reason });
        count++;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn('Curator', 'Failed to archive skill', { skill: candidate.skill, error: msg });
        await appendAuditLog(projectDir, { phase: 'deterministic', action: 'archive-failed', skill: candidate.skill, error: msg });
      }
    }
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    dryRun: Boolean(options.dryRun),
    staleCandidates: candidates,
    archived,
  };
}

/**
 * Phase 2: ask the LLM to cluster related skills and propose merges into
 * umbrella skills. Writes proposals to .harness/curator/proposals.md for
 * human review. Does not auto-apply changes in this version.
 */
export async function runLlmPhase(
  projectDir: string,
  config: CuratorConfig,
  deps: CuratorDeps,
): Promise<{ proposals?: string; proposalsPath?: string; skipped?: string }> {
  if (deps.isKillSwitchActive()) {
    return { skipped: 'kill switch active' };
  }
  if (!config.enableLlmPhase) {
    return { skipped: 'LLM phase disabled in config' };
  }
  if (!deps.callModel) {
    return { skipped: 'No model adapter wired into curator' };
  }
  const scan = await scanSkillsDir(skillsDir(projectDir));
  const usage = await loadSkillUsage(projectDir);
  const active = scan.skills.filter((skill) => !usage.records[skill.name]?.archived);
  if (active.length < 3) {
    return { skipped: `Need at least 3 active skills, have ${active.length}` };
  }
  const summary = active.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n');
  const prompt = [
    'You are reviewing a local agent harness skill library to suggest cleanup.',
    'Skills are markdown files; each one teaches the agent a repeatable workflow.',
    '',
    'For the skills below, identify clusters of 2-4 skills that overlap enough to merge into a single umbrella skill.',
    'Only propose a merge when the combined skill would be clearly more useful than its parts.',
    'Do NOT propose changes for skills that look unique or unrelated.',
    'Format your answer as a Markdown report with one section per proposed cluster:',
    '',
    '### Cluster: <umbrella name>',
    '- merge: skill-a, skill-b, skill-c',
    '- rationale: <one sentence>',
    '- proposed description: <one sentence>',
    '',
    'If no clusters are worth proposing, say "No merges proposed." and nothing else.',
    '',
    'Skills:',
    summary,
  ].join('\n');

  let proposals: string;
  try {
    proposals = await deps.callModel(prompt);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn('Curator', 'LLM phase failed', { error: msg });
    await appendAuditLog(projectDir, { phase: 'llm', error: msg });
    return { skipped: `LLM call failed: ${msg}` };
  }
  await fs.mkdir(curatorDir(projectDir), { recursive: true });
  const header = `<!-- markdownlint-disable-file -->\n# Curator merge proposals\n\nGenerated: ${new Date().toISOString()}\nActive skills considered: ${active.length}\n\n`;
  const body = header + proposals.trim() + '\n';
  await fs.writeFile(proposalsFile(projectDir), body, 'utf-8');
  await appendAuditLog(projectDir, { phase: 'llm', wrote: proposalsFile(projectDir), activeSkillCount: active.length });
  return { proposals, proposalsPath: proposalsFile(projectDir) };
}

export async function runCurator(
  projectDir: string,
  config: CuratorConfig,
  deps: CuratorDeps,
  options: { dryRun?: boolean } = {},
): Promise<CuratorRunSummary> {
  const phase1 = await runDeterministicPhase(projectDir, config, deps, options);
  if (options.dryRun || deps.isKillSwitchActive()) return phase1;
  const phase2 = await runLlmPhase(projectDir, config, deps);
  return { ...phase1, proposals: phase2.proposals, proposalsPath: phase2.proposalsPath, llmSkipped: phase2.skipped };
}

export async function readCuratorLog(projectDir: string, limit = 50): Promise<unknown[]> {
  try {
    const raw = await fs.readFile(logFile(projectDir), 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return { raw: line }; }
    });
  } catch {
    return [];
  }
}

export async function readCuratorProposals(projectDir: string): Promise<string | null> {
  try {
    return await fs.readFile(proposalsFile(projectDir), 'utf-8');
  } catch { return null; }
}

// Re-export for tests / convenience
export { loadSkillUsage, saveSkillUsage } from '../extensibility/skillUsage';
export type { SkillUsageRecord };
