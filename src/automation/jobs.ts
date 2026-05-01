import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

export type AutomationScheduleKind = 'once' | 'interval' | 'cron';

export interface AutomationSchedule {
  kind: AutomationScheduleKind;
  display: string;
  runAt?: string;
  minutes?: number;
  expr?: string;
}

export interface AutomationJob {
  id: string;
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  scriptCommand?: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  enabled: boolean;
}

export interface AutomationRunUpdate {
  outputPath?: string;
  success?: boolean;
  summary?: string;
}

export interface CreateAutomationJobInput {
  name: string;
  prompt: string;
  schedule: string;
  scriptCommand?: string;
}

export function parseAutomationSchedule(value: string, now = new Date()): AutomationSchedule {
  const schedule = value.trim();
  const lower = schedule.toLowerCase();
  if (!schedule) throw new Error('Schedule is required.');
  if (lower.startsWith('every ')) {
    const minutes = parseDurationMinutes(schedule.slice(6));
    return { kind: 'interval', minutes, display: `every ${minutes}m` };
  }
  if (/^(\d+\s*)?(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i.test(schedule) || /^\d+\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i.test(schedule)) {
    const minutes = parseDurationMinutes(schedule);
    return { kind: 'once', runAt: new Date(now.getTime() + minutes * 60_000).toISOString(), display: `once in ${schedule}` };
  }
  const parts = schedule.split(/\s+/);
  if (parts.length >= 5 && parts.every((part) => /^[\d*,-/]+$/.test(part))) {
    return { kind: 'cron', expr: schedule, display: schedule };
  }
  const timestamp = Date.parse(schedule);
  if (Number.isFinite(timestamp)) {
    return { kind: 'once', runAt: new Date(timestamp).toISOString(), display: `once at ${new Date(timestamp).toISOString()}` };
  }
  throw new Error(`Invalid schedule: ${value}`);
}

export function computeNextAutomationRun(schedule: AutomationSchedule, lastRunAt?: string, now = new Date()): string | undefined {
  if (schedule.kind === 'once') return lastRunAt ? undefined : schedule.runAt;
  if (schedule.kind === 'interval') {
    const base = lastRunAt ? new Date(lastRunAt) : now;
    return new Date(base.getTime() + (schedule.minutes ?? 1) * 60_000).toISOString();
  }
  if (schedule.kind === 'cron' && schedule.expr) return computeNextCronRun(schedule.expr, now);
  return undefined;
}

export async function createAutomationJob(projectDir: string, input: CreateAutomationJobInput, now = new Date()): Promise<AutomationJob> {
  const schedule = parseAutomationSchedule(input.schedule, now);
  const job: AutomationJob = {
    id: crypto.randomUUID(),
    name: input.name.trim() || 'Untitled automation',
    prompt: input.prompt,
    schedule,
    scriptCommand: input.scriptCommand?.trim() || undefined,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    enabled: true,
    nextRunAt: computeNextAutomationRun(schedule, undefined, now),
  };
  const jobs = await listAutomationJobs(projectDir);
  jobs.push(job);
  await saveAutomationJobs(projectDir, jobs);
  return job;
}

export async function listAutomationJobs(projectDir: string): Promise<AutomationJob[]> {
  try {
    const raw = await fs.readFile(jobsPath(projectDir), 'utf-8');
    const parsed = JSON.parse(raw) as { jobs?: AutomationJob[] };
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch {
    return [];
  }
}

export async function saveAutomationJobs(projectDir: string, jobs: AutomationJob[]): Promise<void> {
  const filePath = jobsPath(projectDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ jobs }, null, 2), 'utf-8');
}

export async function listDueAutomationJobs(projectDir: string, now = new Date()): Promise<AutomationJob[]> {
  const jobs = await listAutomationJobs(projectDir);
  return jobs.filter((job) => job.enabled && job.nextRunAt !== undefined && Date.parse(job.nextRunAt) <= now.getTime());
}

export async function markAutomationJobRun(projectDir: string, jobId: string, update: AutomationRunUpdate = {}, now = new Date()): Promise<AutomationJob> {
  const jobs = await listAutomationJobs(projectDir);
  const jobIndex = jobs.findIndex((job) => job.id === jobId);
  if (jobIndex === -1) throw new Error(`Automation job not found: ${jobId}`);
  const existing = jobs[jobIndex];
  const lastRunAt = now.toISOString();
  const updated: AutomationJob = {
    ...existing,
    lastRunAt,
    updatedAt: lastRunAt,
    nextRunAt: computeNextAutomationRun(existing.schedule, lastRunAt, now),
  };
  if (existing.schedule.kind === 'once') updated.enabled = false;
  jobs[jobIndex] = updated;
  await saveAutomationJobs(projectDir, jobs);
  await appendAutomationRunLog(projectDir, updated, update, now);
  return updated;
}

function parseDurationMinutes(value: string): number {
  const match = value.trim().toLowerCase().match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2][0];
  if (unit === 'h') return amount * 60;
  if (unit === 'd') return amount * 1440;
  return amount;
}

async function appendAutomationRunLog(projectDir: string, job: AutomationJob, update: AutomationRunUpdate, now: Date): Promise<void> {
  const logPath = path.join(projectDir, '.harness', 'automations', 'runs.jsonl');
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, JSON.stringify({ jobId: job.id, ranAt: now.toISOString(), ...update }) + '\n', 'utf-8');
}

function computeNextCronRun(expr: string, now: Date): string | undefined {
  const parts = expr.trim().split(/\s+/).slice(0, 5);
  if (parts.length !== 5) return undefined;
  const start = new Date(now.getTime());
  start.setUTCSeconds(0, 0);
  for (let offset = 1; offset <= 525_600; offset++) {
    const candidate = new Date(start.getTime() + offset * 60_000);
    if (cronPartMatches(parts[0], candidate.getUTCMinutes(), 0, 59)
      && cronPartMatches(parts[1], candidate.getUTCHours(), 0, 23)
      && cronPartMatches(parts[2], candidate.getUTCDate(), 1, 31)
      && cronPartMatches(parts[3], candidate.getUTCMonth() + 1, 1, 12)
      && cronPartMatches(parts[4], candidate.getUTCDay(), 0, 6)) {
      return candidate.toISOString();
    }
  }
  return undefined;
}

function cronPartMatches(part: string, value: number, min: number, max: number): boolean {
  return part.split(',').some((segment) => cronSegmentMatches(segment, value, min, max));
}

function cronSegmentMatches(segment: string, value: number, min: number, max: number): boolean {
  const [rangePart, stepPart] = segment.split('/');
  const step = stepPart ? Number(stepPart) : 1;
  if (!Number.isInteger(step) || step < 1) return false;
  let rangeMin = min;
  let rangeMax = max;
  if (rangePart !== '*') {
    const rangeMatch = rangePart.match(/^(\d+)(?:-(\d+))?$/);
    if (!rangeMatch) return false;
    rangeMin = Number(rangeMatch[1]);
    rangeMax = rangeMatch[2] ? Number(rangeMatch[2]) : rangeMin;
  }
  if (rangeMin < min || rangeMax > max || value < rangeMin || value > rangeMax) return false;
  return (value - rangeMin) % step === 0;
}

function jobsPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'automations', 'jobs.json');
}
