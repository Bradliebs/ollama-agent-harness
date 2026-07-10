import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AutomationScheduler } from './scheduler';
import { createAutomationJob } from './jobs';
import { createCapabilityGrant, type CapabilityGrant } from '../permissions/capabilities';

const CHECK_INTERVAL_MS = 5 * 60_000;

describe('AutomationScheduler.tick', () => {
  function makeScheduler(projectDir: string, overrides: Partial<ConstructorParameters<typeof AutomationScheduler>[0]> = {}) {
    return new AutomationScheduler({
      projectDir,
      getPolicyContext: () => ({ grants: [], killSwitchActive: false }),
      isKillSwitchActive: () => false,
      isEnabled: () => true,
      getLastUserActivityMs: () => Date.now() - 10 * 60_000,
      idleThresholdMinutes: 1,
      ...overrides,
    });
  }

  it('skips when disabled', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-auto-sched-'));
    const scheduler = makeScheduler(dir, { isEnabled: () => false });
    const result = await scheduler.tick(new Date(Date.now() + CHECK_INTERVAL_MS + 1));
    expect(result).toMatchObject({ executed: 0, reason: 'disabled' });
  });

  it('skips when kill switch is active', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-auto-sched-'));
    const scheduler = makeScheduler(dir, { isKillSwitchActive: () => true });
    const result = await scheduler.tick(new Date(Date.now() + CHECK_INTERVAL_MS + 1));
    expect(result).toMatchObject({ executed: 0, reason: 'kill switch' });
  });

  it('skips opportunistic jobs when system is not idle but cron jobs still fire', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-auto-sched-'));
    const t0 = new Date('2026-05-01T00:00:00.000Z');
    // Two due jobs at t1: one interval (opportunistic), one cron (always-fire).
    await createAutomationJob(dir, { name: 'Opportunistic', prompt: 'p', schedule: 'every 1h' }, t0);
    await createAutomationJob(dir, { name: 'Cron job', prompt: 'p', schedule: '0 1 * * *' }, t0);
    const t1 = new Date('2026-05-01T01:00:30.000Z');
    const scheduler = makeScheduler(dir, {
      getLastUserActivityMs: () => t1.getTime(), // active right now → not idle
      idleThresholdMinutes: 10,
    });
    const result = await scheduler.tick(t1);
    // Cron must fire even when not idle. Opportunistic must be skipped.
    expect(result.results?.map((r) => r.name)).toEqual(['Cron job']);
    expect(result.reason).toMatch(/system not idle/);
  });

  it('returns zero executed and no reason when nothing is due even if not idle', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-auto-sched-'));
    const fakeNow = Date.now() + CHECK_INTERVAL_MS + 1;
    const scheduler = makeScheduler(dir, { getLastUserActivityMs: () => fakeNow, idleThresholdMinutes: 10 });
    const result = await scheduler.tick(new Date(fakeNow));
    expect(result.executed).toBe(0);
    expect(result.reason).toBeUndefined();
  });

  it('skips repeated ticks within the check interval', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-auto-sched-'));
    const scheduler = makeScheduler(dir);
    await scheduler.tick(new Date(0));
    const result = await scheduler.tick(new Date(60_000));
    expect(result).toMatchObject({ executed: 0, reason: 'within check interval' });
  });

  it('fires the onIdle hook when the system is idle, not when it is active', async () => {
    const idleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-auto-sched-'));
    const onIdle = jest.fn();
    const idleScheduler = makeScheduler(idleDir, {
      getLastUserActivityMs: () => Date.now() - 30 * 60_000, // idle 30m
      idleThresholdMinutes: 10,
      onIdle,
    });
    await idleScheduler.tick(new Date(Date.now() + CHECK_INTERVAL_MS + 1));
    expect(onIdle).toHaveBeenCalledTimes(1);

    const activeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-auto-sched-'));
    const onIdleActive = jest.fn();
    const now = Date.now() + CHECK_INTERVAL_MS + 1;
    const activeScheduler = makeScheduler(activeDir, {
      getLastUserActivityMs: () => now, // active right now → not idle
      idleThresholdMinutes: 10,
      onIdle: onIdleActive,
    });
    await activeScheduler.tick(new Date(now));
    expect(onIdleActive).not.toHaveBeenCalled();
  });

  it('executes due jobs when conditions are met', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-auto-sched-'));
    const t0 = new Date('2026-05-01T00:00:00.000Z');
    await createAutomationJob(dir, { name: 'Scheduled', prompt: 'Do work', schedule: 'every 1h' }, t0);

    const grants = [
      createCapabilityGrant({ id: 'g-shell', capabilityId: 'arbitrary-shell', controls: ['explicit-grant', 'audit-log', 'allowlist', 'kill-switch'], now: t0, expiresInMinutes: 180 }).grant,
      createCapabilityGrant({ id: 'g-bg', capabilityId: 'background-autonomous-jobs', controls: ['explicit-grant', 'time-limit', 'audit-log', 'allowlist', 'kill-switch'], now: t0, expiresInMinutes: 180 }).grant,
    ].filter((g): g is CapabilityGrant => g !== undefined);

    const t1 = new Date('2026-05-01T01:00:00.000Z');
    const scheduler = makeScheduler(dir, {
      getPolicyContext: () => ({ grants, now: t1 }),
      getLastUserActivityMs: () => t1.getTime() - 10 * 60_000,
    });

    const result = await scheduler.tick(t1);
    expect(result.executed).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results![0].name).toBe('Scheduled');
  });

  it('returns zero executed when no jobs are due', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-auto-sched-'));
    const t0 = new Date('2026-05-01T00:00:00.000Z');
    await createAutomationJob(dir, { name: 'Future', prompt: 'Later', schedule: 'every 2h' }, t0);

    const scheduler = makeScheduler(dir, {
      getLastUserActivityMs: () => t0.getTime() - 10 * 60_000,
    });

    const result = await scheduler.tick(new Date('2026-05-01T00:30:00.000Z'));
    expect(result.executed).toBe(0);
  });
});
