import { createToolFailureAlerts } from './toolFailureAlerts';

describe('services/toolFailureAlerts', () => {
  it('does not alert before the minimum sample size', () => {
    const tracker = createToolFailureAlerts({ minSamples: 5, failureThreshold: 0.5, windowSize: 10 });
    for (let i = 0; i < 4; i += 1) {
      const alert = tracker.record('bash', false);
      expect(alert).toBeNull();
    }
  });

  it('fires once when failure rate exceeds threshold', () => {
    const events: string[] = [];
    let now = 1_000;
    const tracker = createToolFailureAlerts({
      minSamples: 5,
      failureThreshold: 0.6,
      windowSize: 10,
      cooldownMs: 60_000,
      now: () => now,
    });
    tracker.subscribe((alert) => events.push(alert.tool));
    // Seed 4 successes — under min-samples so no alert yet.
    for (let i = 0; i < 4; i += 1) tracker.record('bash', true);
    // 5th sample is a failure: 1/5 = 20%, below 60% threshold → no alert.
    expect(tracker.record('bash', false)).toBeNull();
    // Stream failures until the window's failure rate crosses 60%. The
    // exact firing record depends on rounding, so check via the listener.
    for (let i = 0; i < 10; i += 1) tracker.record('bash', false);
    expect(events).toEqual(['bash']); // exactly one alert despite many failures
  });

  it('honours the cooldown — second alert suppressed within window', () => {
    let now = 1_000;
    const tracker = createToolFailureAlerts({
      minSamples: 3,
      failureThreshold: 0.5,
      windowSize: 5,
      cooldownMs: 10_000,
      now: () => now,
    });
    // Seed under the threshold.
    tracker.record('bash', false);
    tracker.record('bash', false);
    // Third call hits min-samples and fires.
    expect(tracker.record('bash', false)).not.toBeNull();
    // Subsequent failures inside the cooldown window are suppressed.
    expect(tracker.record('bash', false)).toBeNull();
    // After the cooldown, a new alert is allowed.
    now += 11_000;
    expect(tracker.record('bash', false)).not.toBeNull();
  });

  it('tracks tools independently', () => {
    const tracker = createToolFailureAlerts({ minSamples: 3, failureThreshold: 0.5, windowSize: 5 });
    tracker.record('bash', false);
    tracker.record('bash', false);
    expect(tracker.record('bash', false)).not.toBeNull();
    // Other tool still happy.
    tracker.record('web_read', true);
    tracker.record('web_read', true);
    expect(tracker.record('web_read', true)).toBeNull();
  });

  it('drops oldest results once the window is full', () => {
    const tracker = createToolFailureAlerts({ minSamples: 3, failureThreshold: 0.5, windowSize: 4, cooldownMs: 0 });
    // Seed 4 failures.
    for (let i = 0; i < 4; i += 1) tracker.record('bash', false);
    // Stream successes — window slides; eventually below threshold.
    for (let i = 0; i < 4; i += 1) tracker.record('bash', true);
    const status = tracker.status();
    expect(status.bash.samples).toBe(4);
    expect(status.bash.failureRate).toBe(0);
  });

  it('status() reports per-tool sample counts and last alert time', () => {
    let now = 1_000;
    const tracker = createToolFailureAlerts({ minSamples: 2, failureThreshold: 0.5, windowSize: 10, now: () => now });
    tracker.record('bash', false);
    tracker.record('bash', false);
    expect(tracker.status().bash.samples).toBe(2);
    expect(tracker.status().bash.lastAlertAt).not.toBeNull();
  });
});
