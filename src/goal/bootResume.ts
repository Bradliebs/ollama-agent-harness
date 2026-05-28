// Boot-time check for an active goal that survived a restart.
//
// Designed to be called by any host (web server, CLI, daemon) early in
// startup. Returns the resumable goal classification so the host can decide:
//   * `auto`      — process crashed mid-flight; safe to restart the loop
//   * `needs_ack` — a human paused/blocked it; surface a prompt
//   * `none`      — nothing to do

import { getResumableGoal, type ResumableGoal } from './resume';

export interface BootResumeLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface BootResumeOptions {
  /** Optional logger; defaults to console.log/console.warn. */
  logger?: BootResumeLogger;
}

const defaultLogger: BootResumeLogger = {
  info: (msg, meta) => meta ? console.log(`[goal-resume] ${msg}`, meta) : console.log(`[goal-resume] ${msg}`),
  warn: (msg, meta) => meta ? console.warn(`[goal-resume] ${msg}`, meta) : console.warn(`[goal-resume] ${msg}`),
};

export async function surfaceResumableGoalOnBoot(
  projectDir: string,
  opts: BootResumeOptions = {},
): Promise<ResumableGoal | { kind: 'none' }> {
  const logger = opts.logger ?? defaultLogger;
  const res = await getResumableGoal(projectDir);
  if (res.kind === 'none') return res;
  const meta = { goalId: res.goal.id, status: res.goal.status, target: res.goal.target };
  if (res.kind === 'auto') {
    logger.info('Active goal can be auto-resumed (process likely restarted mid-flight)', meta);
  } else {
    logger.warn('Active goal needs human acknowledgement before resuming', meta);
  }
  return res;
}
