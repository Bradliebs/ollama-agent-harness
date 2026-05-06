// Self-learning heartbeat scheduler.
//
// Periodic background actions — runs the harness's "behind the scenes"
// maintenance and learning. Mirrors the curator scheduler pattern:
// 60-second heartbeat tick, gated by interval/idle/kill-switch, actions
// are pluggable so the server (or tests) can inject what to run.
//
// Built-in default actions:
//   - memory_maintenance  — compact daily logs, run tiered summarization
//   - memory_gc           — drop empty sections, dedup obvious duplicates
//   - cleanup_workspace   — prune .harness/tmp/ files older than N days
//   - monitor_tasks       — flag stale in-progress tasks as 'blocked'
//
// Each action is best-effort: if one fails it is logged and the next runs.

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../core/logger';
import { runtimeTracer } from '../core/tracing';
import { detectStaleTasks, listTasks, recordCheckIn, updateTask, type Task } from './taskStore';
import { runMemoryGc, runMemoryMaintenance } from './memoryIntelligence';
import { runIdentityGc } from './identity';
import { emitEvent } from '../persistence/eventStore';

export interface HeartbeatAction {
  name: string;
  run(projectDir: string): Promise<HeartbeatActionResult>;
}

export interface HeartbeatActionResult {
  ok: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

export interface SelfLearningHeartbeatOptions {
  projectDir: string;
  /** Minutes between full heartbeat runs (default 15). */
  intervalMinutes?: number;
  /** Tick interval in ms (default 60_000). Tests override this. */
  tickMs?: number;
  /** Optional override of the default action set. */
  actions?: HeartbeatAction[];
  /** Returns true when the kill switch is engaged (skip everything). */
  isKillSwitchActive(): boolean;
  /** Returns true when the scheduler is enabled. */
  isEnabled(): boolean;
  /** Returns ms timestamp of the last full run. */
  getLastRunMs(): number;
  /** Persists the last full-run timestamp. */
  recordRunMs(timestamp: number): void;
}

const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_TICK_MS = 60_000;

export class SelfLearningHeartbeat {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private actions: HeartbeatAction[];

  constructor(private opts: SelfLearningHeartbeatOptions) {
    this.actions = opts.actions ?? defaultHeartbeatActions();
  }

  start(): void {
    if (this.timer) return;
    const tickMs = this.opts.tickMs ?? DEFAULT_TICK_MS;
    this.timer = setInterval(() => {
      this.tick().catch((error) => logger.warn('Heartbeat', 'Tick failed', { error: error instanceof Error ? error.message : String(error) }));
    }, tickMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.info('Heartbeat', 'Scheduler started', { intervalMinutes: this.opts.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run one tick. Public for tests. */
  async tick(now: Date = new Date()): Promise<{ ranActions: boolean; reason?: string; results?: HeartbeatActionResult[] }> {
    if (this.running) return { ranActions: false, reason: 'already running' };
    if (!this.opts.isEnabled()) return { ranActions: false, reason: 'disabled' };
    if (this.opts.isKillSwitchActive()) return { ranActions: false, reason: 'kill switch' };
    const intervalMs = (this.opts.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES) * 60 * 1000;
    const sinceLast = now.getTime() - (this.opts.getLastRunMs() || 0);
    if (sinceLast < intervalMs) return { ranActions: false, reason: 'interval not elapsed' };

    this.running = true;
    const results: HeartbeatActionResult[] = [];
    const actionTimings: Array<{ name: string; durationMs: number; ok: boolean; summary: string }> = [];
    const tickStarted = Date.now();
    try {
      for (const action of this.actions) {
        const actionStarted = Date.now();
        try {
          const result = await action.run(this.opts.projectDir);
          results.push(result);
          actionTimings.push({ name: action.name, durationMs: Date.now() - actionStarted, ok: result.ok, summary: result.summary });
          await emitEvent(this.opts.projectDir, 'system', 'heartbeat.action', { action: action.name, ok: result.ok, summary: result.summary, durationMs: actionTimings[actionTimings.length - 1].durationMs }, 'heartbeat').catch(() => {});
          runtimeTracer.recordEvent('heartbeat.action', { action: action.name, ok: result.ok });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({ ok: false, summary: `${action.name} threw: ${message}` });
          actionTimings.push({ name: action.name, durationMs: Date.now() - actionStarted, ok: false, summary: `threw: ${message}` });
          logger.warn('Heartbeat', `Action ${action.name} threw`, { error: message });
        }
      }
      this.opts.recordRunMs(now.getTime());
      const totalMs = Date.now() - tickStarted;
      logger.info('Heartbeat', 'Tick complete', { actions: results.length, ok: results.filter((r) => r.ok).length, durationMs: totalMs });
      // Best-effort: append a single line capturing this tick to history.
      // Awaited so callers can read history immediately after tick() resolves.
      try {
        await writeHeartbeatHistory(this.opts.projectDir, {
          timestamp: now.toISOString(),
          durationMs: totalMs,
          actions: actionTimings,
        });
      } catch { /* best-effort history; don't fail the tick */ }
      return { ranActions: true, results };
    } finally {
      this.running = false;
    }
  }
}

export function defaultHeartbeatActions(): HeartbeatAction[] {
  return [
    {
      name: 'memory_maintenance',
      async run(projectDir) {
        const summary = await runMemoryMaintenance(projectDir);
        return { ok: true, summary: `Compacted ${summary.compactedFiles} file(s); archived ${summary.archivedSections} section(s).`, details: summary as unknown as Record<string, unknown> };
      },
    },
    {
      name: 'memory_gc',
      async run(projectDir) {
        const summary = await runMemoryGc(projectDir);
        return { ok: true, summary: `Removed ${summary.removedSections} empty section(s); deduped ${summary.dedupedLines} line(s).`, details: summary as unknown as Record<string, unknown> };
      },
    },
    {
      name: 'cleanup_workspace',
      async run(projectDir) {
        const removed = await cleanupTmpFiles(projectDir);
        return { ok: true, summary: `Removed ${removed} stale temp file(s).`, details: { removed } };
      },
    },
    {
      name: 'monitor_tasks',
      async run(projectDir) {
        const stale = await detectStaleTasks(projectDir);
        for (const report of stale) {
          await updateTask(projectDir, report.taskId, { status: 'blocked' }).catch(() => {});
        }
        return { ok: true, summary: `Flagged ${stale.length} stale task(s) as blocked.`, details: { stale: stale.length } };
      },
    },
  ];
}

/** Runner that executes a task by delegating to the assigned agent. */
export type TaskAgentRunner = (input: { task: Task; agentId: string }) => Promise<string>;

/**
 * Factory: build a heartbeat action that picks up tasks whose assignee is a
 * known agent and runs them via the supplied runner. The runner returns a
 * summary string; the action records a check-in and marks the task done on
 * success or failed on throw. Designed so the server can wire it to
 * `runSubagent` without coupling this module to chat clients or tools.
 */
export interface WorkAssignedTasksOptions {
  /** Returns the set of agent ids the heartbeat is allowed to schedule. */
  knownAgentIds(): Promise<Set<string>>;
  runner: TaskAgentRunner;
  /** Maximum tasks to process per tick (default 3). */
  maxTasksPerTick?: number;
}

export function createWorkAssignedTasksAction(options: WorkAssignedTasksOptions): HeartbeatAction {
  const maxTasks = options.maxTasksPerTick ?? 3;
  return {
    name: 'work_assigned_tasks',
    async run(projectDir) {
      const known = await options.knownAgentIds();
      const candidates = await listTasks(projectDir, { status: 'assigned' });
      const eligible = candidates.filter((task) => task.assigneeId && known.has(task.assigneeId)).slice(0, maxTasks);
      if (eligible.length === 0) {
        return { ok: true, summary: 'No assigned tasks ready to execute.', details: { picked: 0 } };
      }
      let succeeded = 0;
      let failed = 0;
      for (const task of eligible) {
        if (!task.assigneeId) continue;
        try {
          await recordCheckIn(projectDir, task.id, { message: `heartbeat picked up task; delegating to ${task.assigneeId}`, status: 'in_progress' }).catch(() => {});
          const summary = await options.runner({ task, agentId: task.assigneeId });
          await recordCheckIn(projectDir, task.id, { progressPercent: 100, message: summary.slice(0, 500), status: 'done' }).catch(() => {});
          succeeded += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await recordCheckIn(projectDir, task.id, { message: `runner failed: ${message}`, status: 'failed' }).catch(() => {});
          failed += 1;
        }
      }
      return { ok: failed === 0, summary: `Executed ${succeeded} task(s); ${failed} failed.`, details: { succeeded, failed, picked: eligible.length } };
    },
  };
}

export interface IdentityGcActionOptions {
  /** Drop structured entries older than this many days. Defaults to 90. */
  maxAgeDays?: number;
}

/** Heartbeat action that runs identity garbage collection. */
export function createIdentityGcAction(options: IdentityGcActionOptions = {}): HeartbeatAction {
  return {
    name: 'identity_gc',
    async run(projectDir) {
      const summary = await runIdentityGc(projectDir, { maxAgeDays: options.maxAgeDays });
      return { ok: true, summary: `Scanned ${summary.scanned} structured entries; removed ${summary.removed}; kept ${summary.pinnedKept} pinned.`, details: summary as unknown as Record<string, unknown> };
    },
  };
}

// ─── Learning hooks ────────────────────────────────────────────────

/**
 * Reflect on the most recent session: read the latest reflection from
 * `.harness/learning/reflections.jsonl` if present, summarize tool
 * success rate and high-signal insights, and surface them through the
 * heartbeat result so the Health tab / event store can show them.
 *
 * Deterministic and read-only: never invokes an LLM. The actual
 * reflection generation lives in `learning/engine.reflectOnSession()`
 * and is driven by the chat path; this action just snapshots whatever
 * was already produced.
 */
export function createReflectAndLearnAction(): HeartbeatAction {
  return {
    name: 'reflect_and_learn',
    async run(projectDir) {
      const reflectionsPath = path.join(projectDir, '.harness', 'learning', 'reflections.jsonl');
      let raw: string;
      try {
        raw = await fs.readFile(reflectionsPath, 'utf-8');
      } catch {
        return { ok: true, summary: 'No reflections yet — nothing to surface.', details: { reflections: 0 } };
      }
      const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
      const recent: Array<{ successRate?: number; insights?: string[]; suggestedImprovements?: string[]; sessionId?: string }> = [];
      for (let i = lines.length - 1; i >= 0 && recent.length < 5; i--) {
        try {
          recent.push(JSON.parse(lines[i]));
        } catch { /* skip corrupt line */ }
      }
      if (recent.length === 0) {
        return { ok: true, summary: 'No parseable reflections yet.', details: { reflections: 0 } };
      }
      const insightCount = recent.reduce((sum, r) => sum + (r.insights?.length ?? 0), 0);
      const improvementCount = recent.reduce((sum, r) => sum + (r.suggestedImprovements?.length ?? 0), 0);
      const successRates = recent
        .map((r) => (typeof r.successRate === 'number' ? r.successRate : null))
        .filter((value): value is number => value !== null);
      const avgSuccess = successRates.length > 0
        ? Math.round((successRates.reduce((sum, value) => sum + value, 0) / successRates.length) * 100)
        : null;
      return {
        ok: true,
        summary: `Surfaced ${recent.length} recent reflection(s); ${insightCount} insight(s), ${improvementCount} improvement note(s)${avgSuccess !== null ? `; avg success ${avgSuccess}%` : ''}.`,
        details: { sessions: recent.length, insightCount, improvementCount, avgSuccessPercent: avgSuccess },
      };
    },
  };
}

export interface SkillEvolutionActionOptions {
  /** Stale-detector cutoff in days; defaults to 30. */
  staleAfterDays?: number;
  /** Max skills to flag per tick; defaults to 5. */
  maxFlagged?: number;
}

/**
 * Detect stale or unused skills in dry-run mode and surface them via the
 * heartbeat. Never archives in this action — archiving stays a curator
 * decision. Pure deterministic Phase 1 from `curator/curator.ts`.
 *
 * Additionally, when the curator's safety gate is enabled, we re-scan
 * every active skill against the safety rule library and surface any
 * blocking violations so they show up in heartbeat history before a
 * curator run silently skips them.
 */
export function createSkillEvolutionAction(options: SkillEvolutionActionOptions = {}): HeartbeatAction {
  const maxFlagged = options.maxFlagged ?? 5;
  return {
    name: 'skill_evolution',
    async run(projectDir) {
      // Lazy import keeps the heartbeat module independent of the curator
      // module's runtime dependencies (skill loader, usage store, etc.).
      const { runDeterministicPhase, DEFAULT_CURATOR_CONFIG } = await import('../curator/curator');
      const config = {
        ...DEFAULT_CURATOR_CONFIG,
        ...(typeof options.staleAfterDays === 'number' ? { staleAfterDays: options.staleAfterDays } : {}),
      };
      const summary = await runDeterministicPhase(
        projectDir,
        config,
        { isKillSwitchActive: () => false },
        { dryRun: true },
      );
      const flagged = summary.staleCandidates.slice(0, maxFlagged).map((candidate) => candidate.skill);

      // Active-skill safety scan (always runs, regardless of the
      // curator gate flag). A heartbeat surface should make unsafe
      // skills loud even when the curator is configured permissively.
      let safetyHits: Array<{ skill: string; ruleId: string; severity: 'low' | 'medium' | 'high' }> = [];
      try {
        const { scanSkillsDir } = await import('../extensibility/skillLoader');
        const { loadSafetyRules, scanSafetyText } = await import('../learning/promotionGate');
        const scan = await scanSkillsDir(path.join(projectDir, '.harness', 'skills'));
        const rules = await loadSafetyRules(projectDir);
        for (const skill of scan.skills) {
          const violations = scanSafetyText(skill.content ?? '', 'outcome', rules);
          for (const violation of violations.slice(0, 1)) { // one per skill is enough for the surface
            safetyHits.push({ skill: skill.name, ruleId: violation.ruleId, severity: violation.severity });
          }
        }
      } catch { /* best-effort — heartbeat must keep running */ }
      const blockingHits = safetyHits.filter((hit) => hit.severity === 'high');

      const summaryParts: string[] = [];
      summaryParts.push(`Stale skills detected (dry-run): ${summary.staleCandidates.length} candidate(s)`);
      if (flagged.length > 0) summaryParts.push(`— ${flagged.join(', ')}`);
      summaryParts.push(`. Safety: ${safetyHits.length} hit(s)`);
      if (blockingHits.length > 0) summaryParts.push(` (${blockingHits.length} HIGH severity)`);
      summaryParts.push('.');
      return {
        ok: true,
        summary: summaryParts.join(''),
        details: { candidates: summary.staleCandidates.length, flagged, safetyHits, blockingSafetyHits: blockingHits.length },
      };
    },
  };
}

const TMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function cleanupTmpFiles(projectDir: string, now = Date.now(), maxAgeMs = TMP_MAX_AGE_MS): Promise<number> {
  const tmpDir = path.join(projectDir, '.harness', 'tmp');
  let removed = 0;
  try {
    const entries = await fs.readdir(tmpDir, { withFileTypes: true });
    for (const entry of entries) {
      const fp = path.join(tmpDir, entry.name);
      try {
        const stat = await fs.stat(fp);
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.rm(fp, { recursive: true, force: true });
          removed += 1;
        }
      } catch { /* best-effort */ }
    }
  } catch { /* tmp dir doesn't exist — nothing to do */ }
  return removed;
}

export interface CleanupAgentOutputsActionOptions {
  /** Files older than this age are removed. Defaults to 14 days. */
  maxAgeDays?: number;
  /** Override the directory name (relative to projectDir). Defaults to `agent-outputs`. */
  dirName?: string;
}

/**
 * Heartbeat action: prune scratch files the agent has written into
 * `agent-outputs/` past the configured age. The folder is the corral
 * for new bare-filename writes from `file_write` (see
 * `src/tools/pathResolution.ts`), so without this prune old reports
 * (e.g. a 2-day-old VW comparison) keep showing up in `grep` searches
 * and pollute later, unrelated tasks.
 *
 * Skips the corral root itself; only files (not subdirectories) are
 * removed so any deliberately curated subfolder under `agent-outputs/`
 * is preserved.
 */
export function createCleanupAgentOutputsAction(options: CleanupAgentOutputsActionOptions = {}): HeartbeatAction {
  const maxAgeDays = Math.max(0, options.maxAgeDays ?? 14);
  const dirName = (options.dirName ?? 'agent-outputs').replace(/[\\/]+$/, '');
  return {
    name: 'cleanup_agent_outputs',
    async run(projectDir) {
      const dir = path.join(projectDir, dirName);
      const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
      const now = Date.now();
      let removed = 0;
      let scanned = 0;
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue; // never recurse / never touch user-curated subfolders
          scanned += 1;
          const fp = path.join(dir, entry.name);
          try {
            const stat = await fs.stat(fp);
            if (now - stat.mtimeMs > maxAgeMs) {
              await fs.rm(fp, { force: true });
              removed += 1;
            }
          } catch { /* best-effort */ }
        }
      } catch {
        return { ok: true, summary: `agent-outputs dir not found at ${dir} — nothing to do.`, details: { scanned: 0, removed: 0 } };
      }
      return {
        ok: true,
        summary: `Pruned ${removed} stale file(s) older than ${maxAgeDays}d from ${dirName}/ (scanned ${scanned}).`,
        details: { scanned, removed, maxAgeDays },
      };
    },
  };
}

// ─── History ────────────────────────────────────────────────────────

export interface HeartbeatRunRecord {
  timestamp: string;
  durationMs: number;
  actions: Array<{ name: string; durationMs: number; ok: boolean; summary: string }>;
}

const HEARTBEAT_HISTORY_PATH = path.join('.harness', 'heartbeat', 'runs.jsonl');
const HEARTBEAT_HISTORY_MAX_LINES = 1_000;

function heartbeatHistoryPath(projectDir: string): string {
  return path.join(projectDir, HEARTBEAT_HISTORY_PATH);
}

export async function writeHeartbeatHistory(projectDir: string, run: HeartbeatRunRecord): Promise<void> {
  const fp = heartbeatHistoryPath(projectDir);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.appendFile(fp, JSON.stringify(run) + '\n', 'utf-8');
}

export async function readHeartbeatHistory(projectDir: string, limit = 100): Promise<HeartbeatRunRecord[]> {
  const fp = heartbeatHistoryPath(projectDir);
  let raw: string;
  try {
    raw = await fs.readFile(fp, 'utf-8');
  } catch {
    return [];
  }
  const records: HeartbeatRunRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as HeartbeatRunRecord);
    } catch {
      // Skip corrupt lines.
    }
  }
  if (records.length > HEARTBEAT_HISTORY_MAX_LINES) {
    const latest = records.slice(-HEARTBEAT_HISTORY_MAX_LINES);
    fs.writeFile(fp, latest.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf-8').catch(() => {});
    return latest.slice(-limit);
  }
  return records.slice(-limit);
}
