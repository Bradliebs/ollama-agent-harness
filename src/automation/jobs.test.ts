import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createAutomationJob, executeDueJobs, listAutomationJobs, listDueAutomationJobs, markAutomationJobRun, parseAutomationSchedule } from './jobs';
import { buildAutomationPrompt, listShellCommandAllowlistPresets, matchShellCommandPreset, prepareAutomationRun } from './runner';
import { createCapabilityGrant, type CapabilityGrant } from '../permissions/capabilities';
import { readCapabilityAuditEvents } from '../permissions/capabilityAudit';

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

  it('blocks script-backed automation without active shell and background grants', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-run-blocked-'));
    const job = await createAutomationJob(projectDir, { name: 'Scripted', prompt: 'Analyze script output', schedule: '30m', scriptCommand: 'node -e "console.log(\'SCRIPT OK\')"' }, new Date('2026-05-01T00:00:00.000Z'));

    const run = await prepareAutomationRun(projectDir, job, new Date('2026-05-01T00:01:00.000Z'));

    expect(run.scriptOutput).toContain('Script blocked by arbitrary-shell');
    expect(run.scriptOutput).toContain('Script blocked by background-autonomous-jobs');
    expect(run.scriptOutput).not.toContain('SCRIPT OK');
  });

  it('runs script-backed automation when both capability grants are active', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-run-granted-'));
    const job = await createAutomationJob(projectDir, { name: 'Scripted', prompt: 'Analyze script output', schedule: '30m', scriptCommand: 'node --version' }, new Date('2026-05-01T00:00:00.000Z'));
    const grants = [
      createCapabilityGrant({ id: 'grant-shell', capabilityId: 'arbitrary-shell', controls: ['explicit-grant', 'audit-log', 'allowlist', 'kill-switch'], now: new Date('2026-05-01T00:00:00.000Z') }).grant,
      createCapabilityGrant({ id: 'grant-background', capabilityId: 'background-autonomous-jobs', controls: ['explicit-grant', 'time-limit', 'audit-log', 'allowlist', 'kill-switch'], now: new Date('2026-05-01T00:00:00.000Z') }).grant,
    ].filter((grant): grant is CapabilityGrant => grant !== undefined);

    const run = await prepareAutomationRun(projectDir, job, new Date('2026-05-01T00:01:00.000Z'), { grants });

    expect(run.scriptOutput).toMatch(/^v?\d+\.\d+\.\d+/);
    await expect(readCapabilityAuditEvents(projectDir)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'automation_script.allowed', jobId: job.id, command: 'node --version', presetId: 'tool-version' })]));
  });

  it('blocks granted script-backed automation when command is not allowlisted', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-run-disallowed-'));
    const job = await createAutomationJob(projectDir, { name: 'Scripted', prompt: 'Analyze script output', schedule: '30m', scriptCommand: 'node -e "console.log(\'SCRIPT OK\')"' }, new Date('2026-05-01T00:00:00.000Z'));
    const grants = [
      createCapabilityGrant({ id: 'grant-shell', capabilityId: 'arbitrary-shell', controls: ['explicit-grant', 'audit-log', 'allowlist', 'kill-switch'], now: new Date('2026-05-01T00:00:00.000Z') }).grant,
      createCapabilityGrant({ id: 'grant-background', capabilityId: 'background-autonomous-jobs', controls: ['explicit-grant', 'time-limit', 'audit-log', 'allowlist', 'kill-switch'], now: new Date('2026-05-01T00:00:00.000Z') }).grant,
    ].filter((grant): grant is CapabilityGrant => grant !== undefined);

    const run = await prepareAutomationRun(projectDir, job, new Date('2026-05-01T00:01:00.000Z'), { grants });

    expect(run.scriptOutput).toContain('Script blocked by command allowlist');
    await expect(readCapabilityAuditEvents(projectDir)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'automation_script.denied', jobId: job.id, command: expect.stringContaining('node -e') })]));
  });

  it('admits a script when an arbitrary-shell grant carries a matching commandAllowlist regex', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-run-grant-allowlist-'));
    const cmd = 'node -e "console.log(\'SCRIPT OK\')"';
    const job = await createAutomationJob(projectDir, { name: 'Grant-allowlisted', prompt: 'Analyze', schedule: '30m', scriptCommand: cmd }, new Date('2026-05-01T00:00:00.000Z'));
    const grants = [
      createCapabilityGrant({
        id: 'grant-shell-allowlist',
        capabilityId: 'arbitrary-shell',
        controls: ['explicit-grant', 'audit-log', 'allowlist', 'kill-switch'],
        now: new Date('2026-05-01T00:00:00.000Z'),
        // Operator deliberately approves THIS exact command shape via
        // the persistent grant-allowlist surface (not the static preset
        // list). The runner must admit it AND the audit trail must record
        // which grant + pattern matched so a later forensics pass can see
        // exactly what authorized the execution.
        commandAllowlist: ['^node\\s+-e\\s+".*SCRIPT OK.*"$'],
      }).grant,
      createCapabilityGrant({ id: 'grant-background', capabilityId: 'background-autonomous-jobs', controls: ['explicit-grant', 'time-limit', 'audit-log', 'allowlist', 'kill-switch'], now: new Date('2026-05-01T00:00:00.000Z') }).grant,
    ].filter((grant): grant is CapabilityGrant => grant !== undefined);

    const run = await prepareAutomationRun(projectDir, job, new Date('2026-05-01T00:01:00.000Z'), { grants });

    expect(run.scriptOutput).toContain('SCRIPT OK');
    const events = await readCapabilityAuditEvents(projectDir);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'automation_script.allowed',
        jobId: job.id,
        command: cmd,
        // The presetId is set to the synthetic grant-id marker so audit
        // logs distinguish preset-admitted commands from grant-admitted
        // commands without ambiguity.
        presetId: expect.stringMatching(/^grant:grant-shell-allowlist:/),
      }),
    ]));
  });

  it('describes shell command allowlist presets without exposing regex internals', () => {
    expect(listShellCommandAllowlistPresets()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'tool-version', examples: expect.arrayContaining(['node --version']) })]));
    expect(matchShellCommandPreset('node --version')).toMatchObject({ id: 'tool-version' });
    expect(matchShellCommandPreset('node -e "console.log(1)"')).toBeNull();
  });

  it('executes due jobs with policy context and marks them complete', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-executor-'));
    const t0 = new Date('2026-05-01T00:00:00.000Z');
    await createAutomationJob(projectDir, { name: 'Version check', prompt: 'Check version', schedule: 'every 1h', scriptCommand: 'node --version' }, t0);
    await createAutomationJob(projectDir, { name: 'Plain job', prompt: 'Do something', schedule: 'every 1h' }, t0);

    const grants = [
      createCapabilityGrant({ id: 'g-shell', capabilityId: 'arbitrary-shell', controls: ['explicit-grant', 'audit-log', 'allowlist', 'kill-switch'], now: t0, expiresInMinutes: 120 }).grant,
      createCapabilityGrant({ id: 'g-bg', capabilityId: 'background-autonomous-jobs', controls: ['explicit-grant', 'time-limit', 'audit-log', 'allowlist', 'kill-switch'], now: t0, expiresInMinutes: 120 }).grant,
    ].filter((g): g is CapabilityGrant => g !== undefined);

    const t1 = new Date('2026-05-01T01:00:00.000Z');
    const results = await executeDueJobs(projectDir, { grants, now: t1 }, t1);

    expect(results).toHaveLength(2);
    expect(results[0].run.scriptOutput).toMatch(/^v?\d+\.\d+\.\d+/);
    expect(results[1].run.scriptOutput).toBe('');
    expect(results[0].markedJob.lastRunAt).toBe(t1.toISOString());
    expect(results[1].markedJob.lastRunAt).toBe(t1.toISOString());

    const jobs = await listAutomationJobs(projectDir);
    expect(jobs.every((j) => j.lastRunAt === t1.toISOString())).toBe(true);
  });

  it('returns empty array when no jobs are due', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-executor-empty-'));
    await createAutomationJob(projectDir, { name: 'Future job', prompt: 'Later', schedule: 'every 2h' }, new Date('2026-05-01T00:00:00.000Z'));

    const results = await executeDueJobs(projectDir, {}, new Date('2026-05-01T00:30:00.000Z'));

    expect(results).toHaveLength(0);
  });

  it('blocks due job scripts without grants', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-executor-blocked-'));
    const t0 = new Date('2026-05-01T00:00:00.000Z');
    await createAutomationJob(projectDir, { name: 'Blocked', prompt: 'Run', schedule: 'every 1h', scriptCommand: 'node --version' }, t0);

    const t1 = new Date('2026-05-01T01:00:00.000Z');
    const results = await executeDueJobs(projectDir, {}, t1);

    expect(results).toHaveLength(1);
    expect(results[0].run.scriptOutput).toContain('Script blocked by');
    const events = await readCapabilityAuditEvents(projectDir);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'automation_script.denied' })]));
  });
});
