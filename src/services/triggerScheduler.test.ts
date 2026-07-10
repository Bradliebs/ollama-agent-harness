import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  TriggerScheduler,
  loadTriggers,
  normalizeEnvelope,
  saveTriggers,
  type TriggerDefinition,
} from './triggerScheduler';
import { queryEvents } from '../persistence/eventStore';

describe('triggerScheduler', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-triggers-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('normalizes a legacy bare-array file into the v1 envelope', () => {
    const env = normalizeEnvelope([
      { id: 'a', command: 'echo', intervalSeconds: 5 },
      { invalid: true },
    ]);
    expect(env.version).toBe(1);
    expect(env.triggers).toHaveLength(1);
    expect(env.triggers[0].id).toBe('a');
  });

  it('loads and saves triggers round-trip', async () => {
    const definitions: TriggerDefinition[] = [
      { id: 't1', command: 'node', args: ['-e', 'console.log("hi")'], intervalSeconds: 10, enabled: true },
    ];
    await saveTriggers(projectDir, definitions);
    const reread = await loadTriggers(projectDir);
    expect(reread).toEqual(definitions);
  });

  it('skips ticks during the startup cooldown', async () => {
    await saveTriggers(projectDir, [{ id: 't1', command: 'echo', intervalSeconds: 5 }]);
    const scheduler = new TriggerScheduler({
      projectDir,
      tickMs: 1_000_000,
      startupCooldownMs: 60_000,
      isEnabled: () => true,
      isKillSwitchActive: () => false,
      spawn: async () => ({ exitCode: 0, stdout: 'should not run', stderr: '' }),
    });
    scheduler.start();
    const results = await scheduler.tick();
    scheduler.stop();
    expect(results).toHaveLength(0);
  });

  it('emits a trigger.message event when stdout is non-empty and exit is zero', async () => {
    await saveTriggers(projectDir, [{ id: 't1', command: 'echo', intervalSeconds: 5 }]);
    const scheduler = new TriggerScheduler({
      projectDir,
      tickMs: 1_000_000,
      startupCooldownMs: 0,
      isEnabled: () => true,
      isKillSwitchActive: () => false,
      spawn: async () => ({ exitCode: 0, stdout: 'mailbox has 2 items', stderr: '' }),
    });
    scheduler.start();
    const results = await scheduler.tick();
    scheduler.stop();
    expect(results).toHaveLength(1);
    const events = await queryEvents(projectDir, { category: 'notification', type: 'trigger.message' });
    expect(events).toHaveLength(1);
    expect(events[0].data.message).toContain('mailbox has 2 items');
  });

  it('does not emit when exit code is non-zero or stdout is empty', async () => {
    await saveTriggers(projectDir, [
      { id: 'fail', command: 'echo', intervalSeconds: 5 },
      { id: 'silent', command: 'echo', intervalSeconds: 5 },
    ]);
    let call = 0;
    const scheduler = new TriggerScheduler({
      projectDir,
      tickMs: 1_000_000,
      startupCooldownMs: 0,
      isEnabled: () => true,
      isKillSwitchActive: () => false,
      spawn: async () => {
        call += 1;
        if (call === 1) return { exitCode: 1, stdout: 'should be ignored', stderr: '' };
        return { exitCode: 0, stdout: '   \n', stderr: '' };
      },
    });
    scheduler.start();
    await scheduler.tick();
    scheduler.stop();
    const events = await queryEvents(projectDir, { category: 'notification', type: 'trigger.message' });
    expect(events).toHaveLength(0);
  });

  it('honours the minimum interval clamp', async () => {
    await saveTriggers(projectDir, [{ id: 't1', command: 'echo', intervalSeconds: 1 }]);
    let calls = 0;
    const scheduler = new TriggerScheduler({
      projectDir,
      tickMs: 1_000_000,
      startupCooldownMs: 0,
      isEnabled: () => true,
      isKillSwitchActive: () => false,
      // Only count t1 — ensureDefaultTriggers may concurrently add morning-priority.
      spawn: async (def) => { if (def.id === 't1') calls += 1; return { exitCode: 0, stdout: 'x', stderr: '' }; },
    });
    scheduler.start();
    const t0 = new Date();
    await scheduler.tick(t0);
    // Second tick 2s later — clamp pushes the interval to 5s, so still no run.
    await scheduler.tick(new Date(t0.getTime() + 2_000));
    scheduler.stop();
    expect(calls).toBe(1);
  });

  it('skips triggers that are explicitly disabled', async () => {
    await saveTriggers(projectDir, [{ id: 't1', command: 'echo', intervalSeconds: 5, enabled: false }]);
    let calls = 0;
    const scheduler = new TriggerScheduler({
      projectDir,
      tickMs: 1_000_000,
      startupCooldownMs: 0,
      isEnabled: () => true,
      isKillSwitchActive: () => false,
      spawn: async () => { calls += 1; return { exitCode: 0, stdout: 'x', stderr: '' }; },
    });
    scheduler.start();
    await scheduler.tick();
    scheduler.stop();
    expect(calls).toBe(0);
  });

  it('respects the kill switch and the global enable flag', async () => {
    await saveTriggers(projectDir, [{ id: 't1', command: 'echo', intervalSeconds: 5 }]);
    let calls = 0;
    const scheduler = new TriggerScheduler({
      projectDir,
      tickMs: 1_000_000,
      startupCooldownMs: 0,
      isEnabled: () => false,
      isKillSwitchActive: () => false,
      spawn: async () => { calls += 1; return { exitCode: 0, stdout: 'x', stderr: '' }; },
    });
    scheduler.start();
    await scheduler.tick();
    scheduler.stop();
    expect(calls).toBe(0);
  });

  it('invalidate() forgets timestamps for deleted triggers and resets the rest', async () => {
    await saveTriggers(projectDir, [
      { id: 'keep', command: 'echo', intervalSeconds: 5 },
      { id: 'remove', command: 'echo', intervalSeconds: 5 },
    ]);
    let calls = 0;
    const scheduler = new TriggerScheduler({
      projectDir,
      tickMs: 1_000_000,
      startupCooldownMs: 0,
      isEnabled: () => true,
      isKillSwitchActive: () => false,
      spawn: async () => { calls += 1; return { exitCode: 0, stdout: 'x', stderr: '' }; },
    });
    scheduler.start();
    // First tick fires both.
    await scheduler.tick(new Date());
    expect(calls).toBe(2);
    // Remove one trigger and invalidate.
    await saveTriggers(projectDir, [{ id: 'keep', command: 'echo', intervalSeconds: 5 }]);
    await scheduler.invalidate();
    // Next tick (well within the 5s clamp) — without invalidate this would skip.
    // After invalidate, the keep trigger's lastRunMs is reset, so it fires again.
    await scheduler.tick(new Date());
    scheduler.stop();
    expect(calls).toBe(3);
  });
});
