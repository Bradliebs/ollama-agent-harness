import { CuratorScheduler } from './scheduler';
import { DEFAULT_CURATOR_CONFIG } from './curator';

describe('CuratorScheduler.tick', () => {
  function makeScheduler(overrides: Partial<ConstructorParameters<typeof CuratorScheduler>[0]> = {}) {
    let lastRunMs = 0;
    return new CuratorScheduler({
      projectDir: '/tmp/does-not-exist',
      config: DEFAULT_CURATOR_CONFIG,
      intervalHours: 1,
      idleThresholdMinutes: 1,
      isKillSwitchActive: () => false,
      isEnabled: () => true,
      getLastUserActivityMs: () => Date.now() - 10 * 60 * 1000,
      getLastRunMs: () => lastRunMs,
      recordRunMs: (ts) => { lastRunMs = ts; },
      callModel: undefined,
      ...overrides,
    });
  }

  it('skips when disabled', async () => {
    const scheduler = makeScheduler({ isEnabled: () => false });
    const result = await scheduler.tick(new Date(Date.now() + MAINTENANCE_WINDOW_MS + 1));
    expect(result.ranCurator).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  it('skips when kill switch is active', async () => {
    const scheduler = makeScheduler({ isKillSwitchActive: () => true });
    const result = await scheduler.tick(new Date(Date.now() + MAINTENANCE_WINDOW_MS + 1));
    expect(result.ranCurator).toBe(false);
    expect(result.reason).toBe('kill switch');
  });

  it('skips when system is not idle', async () => {
    // The "now" we pass to tick() is 1ms past the maintenance window. To stay
    // non-idle relative to that "now", lastUserActivity has to be measured
    // relative to the same simulated clock.
    const fakeNow = Date.now() + MAINTENANCE_WINDOW_MS + 1;
    const scheduler = makeScheduler({ getLastUserActivityMs: () => fakeNow, idleThresholdMinutes: 10 });
    const result = await scheduler.tick(new Date(fakeNow));
    expect(result.ranCurator).toBe(false);
    expect(result.reason).toBe('system not idle');
  });

  it('skips when interval has not elapsed', async () => {
    const scheduler = makeScheduler({
      intervalHours: 24,
      getLastRunMs: () => Date.now() - 60 * 60 * 1000, // 1 hour ago, interval is 24 hours
    });
    const result = await scheduler.tick(new Date(Date.now() + MAINTENANCE_WINDOW_MS + 1));
    expect(result.ranCurator).toBe(false);
    expect(result.reason).toBe('interval not elapsed');
  });

  it('skips repeated ticks within the maintenance check window', async () => {
    const scheduler = makeScheduler();
    // First tick at t=0 sets lastMaintenanceCheckMs.
    await scheduler.tick(new Date(0));
    // Second tick 10 minutes later — well inside the 1-hour window.
    const result = await scheduler.tick(new Date(10 * 60 * 1000));
    expect(result.ranCurator).toBe(false);
    expect(result.reason).toBe('within maintenance check window');
  });

  it('still skips when candidate pressure is below threshold and interval has not elapsed', async () => {
    const scheduler = makeScheduler({
      intervalHours: 168,
      getLastRunMs: () => Date.now() - 60 * 60 * 1000, // 1h ago vs 168h interval
      runWhenCandidatesAtLeast: 25,
      getPendingCandidateCount: async () => 5,
    });
    const result = await scheduler.tick(new Date(Date.now() + MAINTENANCE_WINDOW_MS + 1));
    expect(result.ranCurator).toBe(false);
    expect(result.reason).toBe('interval not elapsed');
  });

  it('overrides the long interval when pending candidates reach the pressure threshold', async () => {
    const callModel = jest.fn(async (_prompt: string) => '');
    let recorded = 0;
    const scheduler = makeScheduler({
      intervalHours: 168,
      getLastRunMs: () => Date.now() - 60 * 60 * 1000,
      runWhenCandidatesAtLeast: 25,
      getPendingCandidateCount: async () => 30,
      callModel,
      recordRunMs: (ts) => { recorded = ts; },
    });
    const result = await scheduler.tick(new Date(Date.now() + MAINTENANCE_WINDOW_MS + 1));
    expect(result.ranCurator).toBe(true);
    expect(recorded).toBeGreaterThan(0);
  });
});

const MAINTENANCE_WINDOW_MS = 60 * 60 * 1000;
