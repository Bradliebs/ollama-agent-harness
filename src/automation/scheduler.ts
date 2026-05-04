import { logger } from '../core/logger';
import { runtimeTracer } from '../core/tracing';
import { executeDueJobs, type DueJobResult } from './jobs';
import type { AutomationPolicyContext } from './runner';
import { checkObligations } from '../services/promiseLedger';
import { listPromises, updatePromise } from '../services/promiseLedger';
import { emitEvent } from '../persistence/eventStore';
import { probeServiceHealth, transitionService } from '../services/serviceLifecycle';
import { listAgenticServices } from '../services/agenticServiceMode';

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
        // Post-execution: emit events for each completed job.
        for (const r of results) {
          emitEvent(this.opts.projectDir, 'schedule', 'job_executed', { job_id: r.jobId, name: r.name }, 'scheduler', r.jobId).catch(() => {});
        }
      }
      // Post-execution: check obligations and service health (non-blocking).
      this.runPostExecutionChecks().catch(() => {});
      return { executed: results.length, results };
    } finally {
      this.running = false;
    }
  }

  /** After jobs execute, check promise obligations and service health. */
  private async runPostExecutionChecks(): Promise<void> {
    // Auto-expire stale promises (pending with no due date for 30+ days, or overdue by 30+ days).
    try {
      const maxAgeDays = 30;
      const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000);
      const pending = await listPromises(this.opts.projectDir, { status: 'pending' });
      let expired = 0;
      for (const p of pending) {
        const overdue = p.next_due_at ? new Date(p.next_due_at) < cutoff : new Date(p.created_at) < cutoff;
        if (overdue) {
          await updatePromise(this.opts.projectDir, p.promise_id, { status: 'expired' });
          emitEvent(this.opts.projectDir, 'promise', 'promise_auto_expired', { promise_id: p.promise_id, commitment: p.commitment.slice(0, 80) }, 'scheduler', p.promise_id).catch(() => {});
          expired++;
        }
      }
      if (expired > 0) logger.info('Automation', `Auto-expired ${expired} stale promise(s)`);
    } catch (error) {
      logger.warn('Automation', 'Promise auto-expiry failed', { error: error instanceof Error ? error.message : String(error) });
    }

    try {
      const obligations = await checkObligations(this.opts.projectDir);
      if (obligations.breaches.length > 0) {
        logger.warn('Automation', `${obligations.breaches.length} promise breach(es) detected`, {
          breaches: obligations.breaches.map((b) => `${b.breach_type}: ${b.detail.slice(0, 80)}`),
        });
        for (const breach of obligations.breaches) {
          emitEvent(this.opts.projectDir, 'promise', 'promise_breach', {
            promise_id: breach.promise_id,
            breach_type: breach.breach_type,
            detail: breach.detail,
          }, 'scheduler', breach.promise_id).catch(() => {});
        }
      }
    } catch (error) {
      logger.warn('Automation', 'Obligation check failed', { error: error instanceof Error ? error.message : String(error) });
    }

    try {
      const services = await listAgenticServices(this.opts.projectDir);
      for (const svc of services) {
        const health = await probeServiceHealth(this.opts.projectDir, svc.service.service_id);
        if (!health.healthy) {
          logger.warn('Automation', `Service ${svc.service.service_id} unhealthy`, { issues: health.issues });
          await transitionService(this.opts.projectDir, svc.service.service_id, 'needs_attention').catch(() => {});
          emitEvent(this.opts.projectDir, 'service', 'service_unhealthy', {
            service_id: svc.service.service_id,
            issues: health.issues,
          }, 'scheduler', svc.service.service_id).catch(() => {});
        }
      }
    } catch (error) {
      logger.warn('Automation', 'Service health check failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
