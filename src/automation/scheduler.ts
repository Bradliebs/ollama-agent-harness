import { logger } from '../core/logger';
import { runtimeTracer } from '../core/tracing';
import { listDueAutomationJobs, markAutomationJobRun, type DueJobResult } from './jobs';
import type { AutomationPolicyContext } from './runner';
import { prepareAutomationRun } from './runner';
import { checkObligations } from '../services/promiseLedger';
import { listPromises, updatePromise, fulfilPromise } from '../services/promiseLedger';
import { emitEvent } from '../persistence/eventStore';
import { pruneEventsByAge } from '../persistence/eventStore';
import { probeServiceHealth, transitionService } from '../services/serviceLifecycle';
import { listAgenticServices } from '../services/agenticServiceMode';
import { recordSwallowed } from '../observability/silentFailureSink';

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
  /** Optional callback to send breach notifications via configured channels. */
  onBreachDetected?: (breaches: Array<{ breach_type: string; detail: string }>) => void;
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

    // Cron jobs are user-explicit "run at this time" instructions and
    // must fire regardless of user activity. The idle gate only applies
    // to opportunistic interval/once jobs that the agent might run as
    // background work. Splitting the due list into two cohorts lets us
    // honour both contracts in a single tick without a second scheduler.
    this.running = true;
    try {
      const policy = this.opts.getPolicyContext();
      const due = await listDueAutomationJobs(this.opts.projectDir, now);
      const cronDue = due.filter((job) => job.schedule.kind === 'cron');
      const opportunisticDue = due.filter((job) => job.schedule.kind !== 'cron');

      const results: DueJobResult[] = [];

      // Always-fire cohort: cron.
      for (const job of cronDue) {
        try {
          const run = await prepareAutomationRun(this.opts.projectDir, job, now, policy);
          const markedJob = await markAutomationJobRun(this.opts.projectDir, job.id, { success: true, outputPath: run.outputPath }, now);
          results.push({ jobId: job.id, name: job.name, run, markedJob });
        } catch (error) {
          logger.warn('Automation', 'Cron job execution failed', { jobId: job.id, error: error instanceof Error ? error.message : String(error) });
        }
      }

      // Opportunistic cohort: only when the system has been idle long enough.
      const idleMs = nowMs - (this.opts.getLastUserActivityMs() || nowMs);
      const idleThresholdMs = this.opts.idleThresholdMinutes * 60_000;
      const idleEnough = idleMs >= idleThresholdMs;
      if (idleEnough) {
        for (const job of opportunisticDue) {
          try {
            const run = await prepareAutomationRun(this.opts.projectDir, job, now, policy);
            const markedJob = await markAutomationJobRun(this.opts.projectDir, job.id, { success: true, outputPath: run.outputPath }, now);
            results.push({ jobId: job.id, name: job.name, run, markedJob });
          } catch (error) {
            logger.warn('Automation', 'Opportunistic job execution failed', { jobId: job.id, error: error instanceof Error ? error.message : String(error) });
          }
        }
      } else if (opportunisticDue.length > 0) {
        logger.info('Automation', 'Skipped opportunistic jobs (system not idle)', { skipped: opportunisticDue.length, idleMs, idleThresholdMs });
      }

      if (results.length > 0) {
        runtimeTracer.recordEvent('automation.scheduled_run', { executed: results.length, jobIds: results.map((r) => r.jobId) });
        logger.info('Automation', 'Scheduled execution completed', { executed: results.length, cron: cronDue.length, opportunistic: idleEnough ? opportunisticDue.length : 0 });
        for (const r of results) {
          emitEvent(this.opts.projectDir, 'schedule', 'job_executed', { job_id: r.jobId, name: r.name }, 'scheduler', r.jobId).catch(() => {});
        }
        this.autoFulfilLinkedPromises(results.map((r) => r.jobId)).catch(() => {});
      }
      this.runPostExecutionChecks().catch(() => {});
      return {
        executed: results.length,
        ...(opportunisticDue.length > 0 && !idleEnough ? { reason: `system not idle (${opportunisticDue.length} opportunistic skipped, cron still ran)` } : {}),
        results,
      };
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
        // Notify via configured channels (Telegram, Slack, webhooks).
        if (this.opts.onBreachDetected) {
          try {
            this.opts.onBreachDetected(obligations.breaches.map((b) => ({ breach_type: b.breach_type, detail: b.detail })));
          } catch (err) { recordSwallowed('scheduler.onBreachDetected', err); }
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

    // Prune old events (default 30-day retention, configurable via HARNESS_EVENT_RETENTION_DAYS).
    try {
      const retentionDays = parseInt(process.env.HARNESS_EVENT_RETENTION_DAYS ?? '30', 10) || 30;
      const pruned = await pruneEventsByAge(this.opts.projectDir, retentionDays);
      if (pruned > 0) logger.info('Automation', `Pruned ${pruned} event(s) older than ${retentionDays} days`);
    } catch (err) { recordSwallowed('scheduler.pruneEventsByAge', err); }
  }

  /** Auto-fulfil pending promises that are linked to the executed job IDs via schedule_id. */
  private async autoFulfilLinkedPromises(executedJobIds: string[]): Promise<void> {
    if (executedJobIds.length === 0) return;
    try {
      const jobIdSet = new Set(executedJobIds);
      const pending = await listPromises(this.opts.projectDir, { status: 'pending' });
      let fulfilled = 0;
      for (const p of pending) {
        if (p.schedule_id && jobIdSet.has(p.schedule_id)) {
          await fulfilPromise(this.opts.projectDir, p.promise_id);
          emitEvent(this.opts.projectDir, 'promise', 'promise_auto_fulfilled', {
            promise_id: p.promise_id,
            schedule_id: p.schedule_id,
            commitment: p.commitment.slice(0, 80),
          }, 'scheduler', p.promise_id).catch(() => {});
          fulfilled++;
        }
      }
      if (fulfilled > 0) logger.info('Automation', `Auto-fulfilled ${fulfilled} promise(s) linked to executed jobs`);
    } catch (error) {
      logger.warn('Automation', 'Promise auto-fulfilment failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
