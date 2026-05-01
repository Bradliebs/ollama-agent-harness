// Curator heartbeat scheduler.
//
// Runs a 60-second heartbeat. Once an hour the heartbeat checks whether the
// configured maintenance interval has elapsed AND whether the system has been
// idle long enough. If both are true, the scheduler invokes runCurator. The
// kill switch always wins — if it's engaged, the curator is skipped.

import { logger } from '../core/logger';
import { runtimeTracer } from '../core/tracing';
import { runCurator, type CuratorConfig, type CuratorDeps } from './curator';

export interface CuratorSchedulerOptions extends CuratorDeps {
  projectDir: string;
  /** Effective curator config (already merged with defaults). */
  config: CuratorConfig;
  /** Hours between curator runs (default 168 = once a week). */
  intervalHours: number;
  /** Minutes of inactivity before the scheduler is allowed to run. */
  idleThresholdMinutes: number;
  /** Returns ms timestamp of the last user activity (e.g. last chat send). */
  getLastUserActivityMs(): number;
  /** When false, the scheduler is paused and no runs are scheduled. */
  isEnabled(): boolean;
  /** Returns ms timestamp of the last successful curator run, or 0 if never. */
  getLastRunMs(): number;
  /** Persists the last-run timestamp so the interval check survives restarts. */
  recordRunMs(timestamp: number): void;
}

const HEARTBEAT_MS = 60_000;
const MAINTENANCE_CHECK_MS = 60 * 60 * 1000;

export class CuratorScheduler {
  private heartbeat: NodeJS.Timeout | null = null;
  private lastMaintenanceCheckMs = 0;
  private running = false;

  constructor(private opts: CuratorSchedulerOptions) {}

  start(now: Date = new Date()): void {
    if (this.heartbeat) return;
    this.lastMaintenanceCheckMs = now.getTime();
    this.heartbeat = setInterval(() => { this.tick().catch((error) => logger.warn('Curator', 'Heartbeat tick failed', { error: error instanceof Error ? error.message : String(error) })); }, HEARTBEAT_MS);
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
    logger.info('Curator', 'Scheduler started', { intervalHours: this.opts.intervalHours, idleThresholdMinutes: this.opts.idleThresholdMinutes });
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Exposed for tests. Runs one tick of the heartbeat loop. */
  async tick(now: Date = new Date()): Promise<{ ranCurator: boolean; reason?: string }> {
    if (this.running) return { ranCurator: false, reason: 'curator already running' };
    if (!this.opts.isEnabled()) return { ranCurator: false, reason: 'disabled' };
    if (this.opts.isKillSwitchActive()) return { ranCurator: false, reason: 'kill switch' };
    const nowMs = now.getTime();
    if (nowMs - this.lastMaintenanceCheckMs < MAINTENANCE_CHECK_MS) {
      return { ranCurator: false, reason: 'within maintenance check window' };
    }
    this.lastMaintenanceCheckMs = nowMs;
    const intervalMs = this.opts.intervalHours * 60 * 60 * 1000;
    const sinceLastRun = nowMs - (this.opts.getLastRunMs() || 0);
    if (sinceLastRun < intervalMs) {
      return { ranCurator: false, reason: 'interval not elapsed' };
    }
    const idleMs = nowMs - (this.opts.getLastUserActivityMs() || nowMs);
    const idleThresholdMs = this.opts.idleThresholdMinutes * 60 * 1000;
    if (idleMs < idleThresholdMs) {
      return { ranCurator: false, reason: 'system not idle' };
    }
    this.running = true;
    try {
      const summary = await runCurator(this.opts.projectDir, this.opts.config, { isKillSwitchActive: this.opts.isKillSwitchActive, callModel: this.opts.callModel });
      this.opts.recordRunMs(nowMs);
      runtimeTracer.recordEvent('curator.scheduled_run', { archived: summary.archived.length, candidates: summary.staleCandidates.length });
      logger.info('Curator', 'Scheduled run completed', { archived: summary.archived.length, candidates: summary.staleCandidates.length });
      return { ranCurator: true };
    } finally {
      this.running = false;
    }
  }
}
