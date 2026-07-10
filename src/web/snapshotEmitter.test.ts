import {
  createSessionViewEmitter,
  DEFAULT_RECENT_EVENT_LIMIT,
  DEFAULT_SESSION_VIEW_THROTTLE_MS,
  resolveSessionViewThrottleMs,
  type SessionView,
  type SubscribeFn,
} from './snapshotEmitter';
import type { HarnessEvent } from '../persistence/eventStore';

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
  return {
    event_id: overrides.event_id ?? 'evt-1',
    category: overrides.category ?? 'tool',
    type: overrides.type ?? 'tool_called',
    timestamp: overrides.timestamp ?? '2020-01-01T00:00:00.000Z',
    data: overrides.data ?? {},
    actor: overrides.actor ?? 'agent',
    subject_id: overrides.subject_id,
    seq: overrides.seq,
    parent_event_id: overrides.parent_event_id,
  };
}

interface FakeBus {
  subscribe: SubscribeFn;
  emit: (event: HarnessEvent) => void;
  listenerCount: () => number;
}

function makeBus(): FakeBus {
  const listeners = new Set<(event: HarnessEvent) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const l of listeners) l(event);
    },
    listenerCount: () => listeners.size,
  };
}

describe('resolveSessionViewThrottleMs', () => {
  const original = process.env.HARNESS_SESSION_VIEW_THROTTLE_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.HARNESS_SESSION_VIEW_THROTTLE_MS;
    else process.env.HARNESS_SESSION_VIEW_THROTTLE_MS = original;
  });

  it('returns default when no env and no explicit', () => {
    delete process.env.HARNESS_SESSION_VIEW_THROTTLE_MS;
    expect(resolveSessionViewThrottleMs()).toBe(DEFAULT_SESSION_VIEW_THROTTLE_MS);
  });

  it('honours explicit override', () => {
    expect(resolveSessionViewThrottleMs(150)).toBe(150);
  });

  it('explicit 0 disables throttle', () => {
    expect(resolveSessionViewThrottleMs(0)).toBe(0);
  });

  it('reads env when no explicit', () => {
    delete process.env.HARNESS_SESSION_VIEW_THROTTLE_MS;
    process.env.HARNESS_SESSION_VIEW_THROTTLE_MS = '250';
    expect(resolveSessionViewThrottleMs()).toBe(250);
  });

  it('ignores garbage env', () => {
    delete process.env.HARNESS_SESSION_VIEW_THROTTLE_MS;
    process.env.HARNESS_SESSION_VIEW_THROTTLE_MS = 'banana';
    expect(resolveSessionViewThrottleMs()).toBe(DEFAULT_SESSION_VIEW_THROTTLE_MS);
  });

  it('ignores negative env', () => {
    delete process.env.HARNESS_SESSION_VIEW_THROTTLE_MS;
    process.env.HARNESS_SESSION_VIEW_THROTTLE_MS = '-5';
    expect(resolveSessionViewThrottleMs()).toBe(DEFAULT_SESSION_VIEW_THROTTLE_MS);
  });
});

describe('createSessionViewEmitter', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('starts at version 0 with empty rollup', () => {
    const bus = makeBus();
    const broadcasts: SessionView[] = [];
    const emitter = createSessionViewEmitter({
      subscribe: bus.subscribe,
      broadcast: (m) => broadcasts.push(m.view),
    });
    const snap = emitter.snapshot();
    expect(snap.version).toBe(0);
    expect(snap.totalEvents).toBe(0);
    expect(snap.recentEvents).toEqual([]);
    expect(snap.lastEvent).toBeUndefined();
    emitter.stop();
  });

  it('publishes immediately on first event then throttles subsequent', () => {
    const bus = makeBus();
    const broadcasts: SessionView[] = [];
    let nowMs = 1_000_000;
    const emitter = createSessionViewEmitter({
      subscribe: bus.subscribe,
      broadcast: (m) => broadcasts.push(m.view),
      throttleMs: 80,
      now: () => nowMs,
    });

    bus.emit(makeEvent({ event_id: 'e1', timestamp: '2020-01-01T00:00:00.000Z' }));
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].version).toBe(1);
    expect(broadcasts[0].totalEvents).toBe(1);

    // 5 more events within the throttle window — coalesce into one publish.
    nowMs += 10;
    for (let i = 0; i < 5; i++) {
      bus.emit(makeEvent({ event_id: `e${i + 2}` }));
    }
    expect(broadcasts).toHaveLength(1);

    nowMs += 100;
    jest.advanceTimersByTime(100);
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[1].version).toBe(2);
    expect(broadcasts[1].totalEvents).toBe(6);

    emitter.stop();
  });

  it('version increments monotonically, skipping intervening events', () => {
    const bus = makeBus();
    const broadcasts: SessionView[] = [];
    let nowMs = 1_000_000;
    const emitter = createSessionViewEmitter({
      subscribe: bus.subscribe,
      broadcast: (m) => broadcasts.push(m.view),
      throttleMs: 50,
      now: () => nowMs,
    });

    bus.emit(makeEvent({ event_id: 'a' }));
    bus.emit(makeEvent({ event_id: 'b' }));
    nowMs += 60;
    jest.advanceTimersByTime(60);
    bus.emit(makeEvent({ event_id: 'c' }));
    nowMs += 60;
    jest.advanceTimersByTime(60);

    const versions = broadcasts.map((b) => b.version);
    expect(versions).toEqual([1, 2, 3]);
    // 3 broadcasts, but 3 events; version count = broadcast count, not event count.
    expect(broadcasts[broadcasts.length - 1].totalEvents).toBe(3);
    emitter.stop();
  });

  it('throttleMs=0 publishes synchronously per event', () => {
    const bus = makeBus();
    const broadcasts: SessionView[] = [];
    const emitter = createSessionViewEmitter({
      subscribe: bus.subscribe,
      broadcast: (m) => broadcasts.push(m.view),
      throttleMs: 0,
    });
    bus.emit(makeEvent({ event_id: 'a' }));
    bus.emit(makeEvent({ event_id: 'b' }));
    bus.emit(makeEvent({ event_id: 'c' }));
    expect(broadcasts.map((b) => b.version)).toEqual([1, 2, 3]);
    emitter.stop();
  });

  it('recent events ring is bounded and newest-first', () => {
    const bus = makeBus();
    const broadcasts: SessionView[] = [];
    let nowMs = 1_000_000;
    const emitter = createSessionViewEmitter({
      subscribe: bus.subscribe,
      broadcast: (m) => broadcasts.push(m.view),
      throttleMs: 0,
      recentLimit: 3,
      now: () => nowMs,
    });

    for (let i = 0; i < 5; i++) {
      bus.emit(makeEvent({ event_id: `e${i}`, type: `type-${i}` }));
    }
    const last = broadcasts[broadcasts.length - 1];
    expect(last.recentEvents.map((r) => r.type)).toEqual(['type-4', 'type-3', 'type-2']);
    emitter.stop();
  });

  it('tracks last event per category', () => {
    const bus = makeBus();
    const broadcasts: SessionView[] = [];
    const emitter = createSessionViewEmitter({
      subscribe: bus.subscribe,
      broadcast: (m) => broadcasts.push(m.view),
      throttleMs: 0,
    });

    bus.emit(makeEvent({ category: 'tool', type: 'tool_called', timestamp: '2020-01-01T00:00:01Z' }));
    bus.emit(makeEvent({ category: 'model', type: 'escalation_applied', timestamp: '2020-01-01T00:00:02Z' }));
    bus.emit(makeEvent({ category: 'tool', type: 'tool_succeeded', timestamp: '2020-01-01T00:00:03Z' }));

    const last = broadcasts[broadcasts.length - 1];
    expect(last.lastByCategory.tool?.type).toBe('tool_succeeded');
    expect(last.lastByCategory.model?.type).toBe('escalation_applied');
    emitter.stop();
  });

  it('stop() unsubscribes from the bus and cancels pending broadcast', () => {
    const bus = makeBus();
    const broadcasts: SessionView[] = [];
    const emitter = createSessionViewEmitter({
      subscribe: bus.subscribe,
      broadcast: (m) => broadcasts.push(m.view),
      throttleMs: 100,
    });
    bus.emit(makeEvent());
    bus.emit(makeEvent());
    expect(broadcasts).toHaveLength(1);

    emitter.stop();
    expect(bus.listenerCount()).toBe(0);

    // Advance past the throttle window: pending broadcast was cancelled.
    jest.advanceTimersByTime(500);
    expect(broadcasts).toHaveLength(1);

    // Further emits do nothing.
    bus.emit(makeEvent());
    expect(broadcasts).toHaveLength(1);
  });

  it('snapshot() reflects current state without forcing a broadcast', () => {
    const bus = makeBus();
    const broadcasts: SessionView[] = [];
    let nowMs = 1_000_000;
    const emitter = createSessionViewEmitter({
      subscribe: bus.subscribe,
      broadcast: (m) => broadcasts.push(m.view),
      throttleMs: 1000,
      now: () => nowMs,
    });

    bus.emit(makeEvent({ event_id: 'a' }));
    bus.emit(makeEvent({ event_id: 'b' }));
    expect(broadcasts).toHaveLength(1);
    const live = emitter.snapshot();
    expect(live.totalEvents).toBe(2);
    expect(broadcasts).toHaveLength(1);
    emitter.stop();
  });

  it('respects DEFAULT_RECENT_EVENT_LIMIT', () => {
    const bus = makeBus();
    const broadcasts: SessionView[] = [];
    const emitter = createSessionViewEmitter({
      subscribe: bus.subscribe,
      broadcast: (m) => broadcasts.push(m.view),
      throttleMs: 0,
    });
    for (let i = 0; i < DEFAULT_RECENT_EVENT_LIMIT + 5; i++) {
      bus.emit(makeEvent({ event_id: `e${i}` }));
    }
    expect(broadcasts[broadcasts.length - 1].recentEvents.length).toBe(DEFAULT_RECENT_EVENT_LIMIT);
    emitter.stop();
  });
});
