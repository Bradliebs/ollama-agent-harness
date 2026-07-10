// Identity auto-update scheduler.
//
// Sibling to CuratorScheduler and the automation scheduler — same
// 60-second heartbeat, idle-gated, interval-gated pattern. Calls
// runIdentityAutoUpdateTick when due; that tick honours the on-disk
// auto-update.json config, so both targets being disabled (the default)
// means the model is never called.
//
// Not auto-wired into server.ts. Construction + .start() is the
// explicit opt-in to begin firing the heartbeat.

import { logger } from '../core/logger';
import { runtimeTracer } from '../core/tracing';
import { gatherIdentityObservations } from './identityObservations';
import {
  runIdentityAutoUpdateTick,
  type IdentityAutoUpdateResult,
} from './identityAutoUpdate';

export interface IdentityAutoUpdateSchedulerOptions {
  projectDir: string;
  /** Model invocation function — same shape as the curator uses. */
  callModel(prompt: string): Promise<string>;
  /** Hours between identity passes when conditions are met. Default 4. */
  intervalHours?: number;
  /** Minutes of inactivity required before a tick is allowed to run. Default 5. */
  idleThresholdMinutes?: number;
  /** Returns ms timestamp of the last user activity (e.g. last chat send). */
  getLastUserActivityMs(): number;
  /** Master kill switch — when false, ticks no-op entirely. */
  isEnabled?(): boolean;
  /** Hours of session history to feed the proposal layer. Default = max(intervalHours, 24). */
  observationLookbackHours?: number;
  /** Per-observation char cap forwarded to gatherIdentityObservations. */
  maxObservationChars?: number;
}

const HEARTBEAT_MS = 60_000;
const MAINTENANCE_CHECK_MS = 60 * 60 * 1000;

export class IdentityAutoUpdateScheduler {
  private heartbeat: NodeJS.Timeout | null = null;
  private lastMaintenanceCheckMs = 0;
  private lastRunMs = 0;
  private running = false;
  private readonly intervalHours: number;
  private readonly idleThresholdMinutes: number;
  private readonly observationLookbackHours: number;

  constructor(private readonly opts: IdentityAutoUpdateSchedulerOptions) {
    this.intervalHours = opts.intervalHours ?? 4;
    this.idleThresholdMinutes = opts.idleThresholdMinutes ?? 5;
    this.observationLookbackHours = opts.observationLookbackHours ?? Math.max(this.intervalHours, 24);
  }

  start(now: Date = new Date()): void {
    if (this.heartbeat) return;
    this.lastMaintenanceCheckMs = now.getTime();
    this.heartbeat = setInterval(() => {
      this.tick().catch((error) =>
        logger.warn('IdentityAutoUpdate', 'Heartbeat tick failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }, HEARTBEAT_MS);
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
    logger.info('IdentityAutoUpdate', 'Scheduler started', {
      intervalHours: this.intervalHours,
      idleThresholdMinutes: this.idleThresholdMinutes,
    });
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Exposed for tests. Runs one tick of the heartbeat loop. */
  async tick(now: Date = new Date()): Promise<{ ran: boolean; reason?: string; result?: IdentityAutoUpdateResult }> {
    if (this.running) return { ran: false, reason: 'already running' };
    if (this.opts.isEnabled && !this.opts.isEnabled()) return { ran: false, reason: 'disabled' };
    const nowMs = now.getTime();
    if (nowMs - this.lastMaintenanceCheckMs < MAINTENANCE_CHECK_MS) {
      return { ran: false, reason: 'within maintenance check window' };
    }
    this.lastMaintenanceCheckMs = nowMs;
    const intervalMs = this.intervalHours * 60 * 60 * 1000;
    if (this.lastRunMs && nowMs - this.lastRunMs < intervalMs) {
      return { ran: false, reason: 'interval not elapsed' };
    }
    const idleMs = nowMs - (this.opts.getLastUserActivityMs() || nowMs);
    const idleThresholdMs = this.idleThresholdMinutes * 60 * 1000;
    if (idleMs < idleThresholdMs) {
      return { ran: false, reason: 'system not idle' };
    }
    this.running = true;
    try {
      const lookbackMs = this.observationLookbackHours * 60 * 60 * 1000;
      const sinceMs = nowMs - lookbackMs;
      const result = await runIdentityAutoUpdateTick(
        this.opts.projectDir,
        {
          callModel: this.opts.callModel,
          getObservations: async () => {
            const obs = await gatherIdentityObservations(this.opts.projectDir, {
              sinceMs,
              maxChars: this.opts.maxObservationChars,
              now,
            });
            return obs.text;
          },
        },
        now,
      );
      this.lastRunMs = nowMs;
      runtimeTracer.recordEvent('identity.scheduled_run', {
        user: result.user.status,
        soul: result.soul.status,
      });
      logger.info('IdentityAutoUpdate', 'Scheduled run completed', {
        user: result.user.status,
        soul: result.soul.status,
      });
      return { ran: true, result };
    } finally {
      this.running = false;
    }
  }
}
