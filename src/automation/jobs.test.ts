import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createAutomationJob, listAutomationJobs, listDueAutomationJobs, markAutomationJobRun, parseAutomationSchedule } from './jobs';
import { buildAutomationPrompt, prepareAutomationRun } from './runner';

describe('automation jobs', () => {
  it('parses interval, duration, timestamp, and cron schedules', () => {
    const now = new Date('2026-04-30T12:00:00.000Z');

    expect(parseAutomationSchedule('every 2h', now)).toMatchObject({ kind: 'interval', minutes: 120 });
    expect(parseAutomationSchedule('30m', now)).toMatchObject({ kind: 'once', runAt: '2026-04-30T12:30:00.000Z' });
    expect(parseAutomationSchedule('2026-05-01T00:00:00Z', now)).toMatchObject({ kind: 'once', runAt: '2026-05-01T00:00:00.000Z' });
    expect(parseAutomationSchedule('0 9 * * *', now)).toMatchObject({ kind: 'cron', expr: '0 9 * * *' });
  });

  it('creates and lists jobs in harness automation storage', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-automation-'));
    const job = await createAutomationJob(projectDir, { name: 'Morning check', prompt: 'Summarize status', schedule: 'every 1h' }, new Date('2026-04-30T12:00:00.000Z'));

    const jobs = await listAutomationJobs(projectDir);
    expect(jobs).toEqual([expect.objectContaining({ id: job.id, name: 'Morning check', nextRunAt: '2026-04-30T13:00:00.000Z' })]);
  });

  it('computes cron next run and marks interval jobs complete', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-automation-cron-'));
    const cronJob = await createAutomationJob(projectDir, { name: 'Daily', prompt: 'Check daily', schedule: '0 9 * * *' }, new Date('2026-04-30T08:58:00.000Z'));
    const intervalJob = await createAutomationJob(projectDir, { name: 'Hourly', prompt: 'Check hourly', schedule: 'every 1h' }, new Date('2026-04-30T08:00:00.000Z'));

    expect(cronJob.nextRunAt).toBe('2026-04-30T09:00:00.000Z');
    await expect(listDueAutomationJobs(projectDir, new Date('2026-04-30T09:00:00.000Z'))).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: cronJob.id }), expect.objectContaining({ id: intervalJob.id })]));
    const updated = await markAutomationJobRun(projectDir, intervalJob.id, { success: true }, new Date('2026-04-30T09:00:00.000Z'));

    expect(updated).toMatchObject({ lastRunAt: '2026-04-30T09:00:00.000Z', nextRunAt: '2026-04-30T10:00:00.000Z', enabled: true });
  });

  it('disables one-shot jobs after they run', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-automation-once-'));
    const job = await createAutomationJob(projectDir, { name: 'Once', prompt: 'Run once', schedule: '30m' }, new Date('2026-04-30T08:00:00.000Z'));

    const updated = await markAutomationJobRun(projectDir, job.id, {}, new Date('2026-04-30T08:30:00.000Z'));

    expect(updated).toMatchObject({ enabled: false, nextRunAt: undefined });
  });

  it('builds script-backed prompt context and saves run input', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-run-'));
    const job = await createAutomationJob(projectDir, { name: 'Scripted', prompt: 'Analyze script output', schedule: '30m' }, new Date('2026-04-30T12:00:00.000Z'));

    await expect(buildAutomationPrompt(job, 'CHANGE DETECTED')).resolves.toContain('Script context:\nCHANGE DETECTED');
    const run = await prepareAutomationRun(projectDir, job, new Date('2026-04-30T12:01:00.000Z'));

    await expect(fs.readFile(run.outputPath, 'utf-8')).resolves.toContain('Analyze script output');
  });
});
