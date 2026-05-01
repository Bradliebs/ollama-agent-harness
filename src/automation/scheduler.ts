import { logger } from '../core/logger';
import { runtimeTracer } from '../core/tracing';
import { executeDueJobs, type DueJobResult } from './jobs';
import type { AutomationPolicyContext } from './runner';

export interface AutomationSchedulerOptions {
  projectDir: string;
  /** Returns the current automation policy context (grants + kill switch state). */
  getPolicyContext(): AutomationPolicyContext;
  /** When true, the scheduler skips all execution. */
  isKillSwitchActive(): boolean;
  /** When false, the scheduler is paused. */
  isEnabled(): boolean;
  /** Returns ms timestamp of the last user activity. */
  getLastUserActivityMs(): number;
  /** Minutes of inactivity before the scheduler is allowed to run. */
  idleThresholdMinutes: number;
}

const HEARTBEAT_MS = 60_000;
const CHECK_INTERVAL_MS = 5 * 60_000;

export class AutomationScheduler {
  private heartbeat: NodeJS.Timeout | null = null;
  private lastCheckMs = 0;
  private running = false;

  constructor(private opts: AutomationSchedulerOptions) {}

  start(now: Date = new Date()): void {
    if (this.heartbeat) return;
    this.lastCheckMs = now.getTime();
    this.heartbeat = setInterval(() => {
      this.tick().catch((error) => logger.warn('Automation', 'Scheduler tick failed', { error: error instanceof Error ? error.message : String(error) }));
    }, HEARTBEAT_MS);
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
    logger.info('Automation', 'Scheduler started', { idleThresholdMinutes: this.opts.idleThresholdMinutes });
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  async tick(now: Date = new Date()): Promise<{ executed: number; reason?: string; results?: DueJobResult[] }> {
    if (this.running) return { executed: 0, reason: 'already running' };
    if (!this.opts.isEnabled()) return { executed: 0, reason: 'disabled' };
    if (this.opts.isKillSwitchActive()) return { executed: 0, reason: 'kill switch' };

    const nowMs = now.getTime();
    if (nowMs - this.lastCheckMs < CHECK_INTERVAL_MS) {
      return { executed: 0, reason: 'within check interval' };
    }
    this.lastCheckMs = nowMs;

    const idleMs = nowMs - (this.opts.getLastUserActivityMs() || nowMs);
    const idleThresholdMs = this.opts.idleThresholdMinutes * 60_000;
    if (idleMs < idleThresholdMs) {
      return { executed: 0, reason: 'system not idle' };
    }

    this.running = true;
    try {
      const policy = this.opts.getPolicyContext();
      const results = await executeDueJobs(this.opts.projectDir, policy, now);
      if (results.length > 0) {
        runtimeTracer.recordEvent('automation.scheduled_run', { executed: results.length, jobIds: results.map((r) => r.jobId) });
        logger.info('Automation', 'Scheduled execution completed', { executed: results.length });
      }
      return { executed: results.length, results };
    } finally {
      this.running = false;
    }
  }
}
