import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SUNDAY_BRIEFING_TEMPLATE, installSundayBriefingJob } from './sundayBriefing';
import { listAutomationJobs, listDueAutomationJobs, parseAutomationSchedule } from './jobs';
import { _resetFileLocksForTest } from '../persistence/atomicFile';

describe('automation/sundayBriefing', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sunday-briefing-test-'));
    _resetFileLocksForTest();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('schedule parses as a valid cron expression for Sunday 09:00', () => {
    const parsed = parseAutomationSchedule(SUNDAY_BRIEFING_TEMPLATE.schedule);
    expect(parsed.kind).toBe('cron');
    expect(parsed.expr).toBe('0 9 * * 0');
  });

  it('prompt references both list tools by their registered names', () => {
    const p = SUNDAY_BRIEFING_TEMPLATE.prompt;
    expect(p).toContain('shopping_list');
    expect(p).toContain('reading_list');
  });

  it('installs the job into jobs.json and ships disabled', async () => {
    const job = await installSundayBriefingJob(dir);
    expect(job.enabled).toBe(false);
    expect(job.name).toBe('Sunday briefing');
    expect(job.schedule.kind).toBe('cron');
    expect(job.prompt).toContain('shopping_list');
    expect(job.prompt).toContain('reading_list');

    const persisted = await listAutomationJobs(dir);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(job.id);
    expect(persisted[0].enabled).toBe(false);
  });

  it('disabled installed job never appears in listDueAutomationJobs', async () => {
    // Safety property: shipped disabled means it cannot fire until the
    // user explicitly flips enabled=true. Pick a far-future timestamp
    // that would be past any cron next-run computed at install.
    await installSundayBriefingJob(dir);
    const farFuture = new Date('2099-01-01T00:00:00Z');
    const due = await listDueAutomationJobs(dir, farFuture);
    expect(due).toEqual([]);
  });

  it('installing twice produces two distinct jobs (no implicit dedup)', async () => {
    // The harness's general automations API does not dedup, so callers
    // who want a single canonical entry must check first. Documenting
    // the behaviour here so a future refactor does not silently change it.
    const first = await installSundayBriefingJob(dir);
    const second = await installSundayBriefingJob(dir);
    expect(first.id).not.toBe(second.id);
    const persisted = await listAutomationJobs(dir);
    expect(persisted).toHaveLength(2);
  });
});
