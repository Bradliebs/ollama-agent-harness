// Throttled SessionView snapshot emitter.
//
// Subscribes to the harness event stream and broadcasts a coalesced snapshot
// at most every `throttleMs`. The snapshot is a small rollup of recent
// activity so the web UI can render a steady "what's happening now" panel
// without re-rendering on every micro-event.
//
// The version counter is monotonic per emitter instance. Clients that miss
// snapshots (backpressure, disconnect, reconnect) can detect dropped frames
// by checking that received versions are contiguous; a jump means frames were
// dropped between the last received version and the current one.
//
// Out of scope (intentionally):
//   - Per-client subscription protocol. Snapshots are broadcast to all
//     connected clients tagged `type: 'session_view'`. Existing clients that
//     do not recognise the tag ignore the message — fully back-compat.
//   - Deep semantic modelling (turn number, assistant text). Those are
//     consumer concerns; the rollup stays event-shape-agnostic.

import type { EventCategory, HarnessEvent } from '../persistence/eventStore';

export interface RecentEvent {
  category: EventCategory;
  type: string;
  at: string;
  subject_id?: string;
  actor: string;
}

export interface SessionView {
  version: number;
  generatedAt: string;
  totalEvents: number;
  lastEvent?: RecentEvent;
  /** Newest first, bounded by `recentLimit`. */
  recentEvents: RecentEvent[];
  /** Latest event seen per category. */
  lastByCategory: Partial<Record<EventCategory, RecentEvent>>;
}

export type SubscribeFn = (listener: (event: HarnessEvent) => void) => () => void;
export type BroadcastFn = (message: { type: 'session_view'; view: SessionView }) => void;

export interface SessionViewEmitterOptions {
  subscribe: SubscribeFn;
  broadcast: BroadcastFn;
  /** Min ms between broadcasts. Defaults to env `HARNESS_SESSION_VIEW_THROTTLE_MS` or 80. */
  throttleMs?: number;
  /** Max recent events retained in the rollup. Defaults to 10. */
  recentLimit?: number;
  /** Time source (for tests). */
  now?: () => number;
}

export interface SessionViewEmitter {
  /** Current snapshot. Always defined (starts empty version=0). */
  snapshot(): SessionView;
  /** Stop subscribing and cancel any pending broadcast. */
  stop(): void;
}

export const DEFAULT_SESSION_VIEW_THROTTLE_MS = 80;
export const DEFAULT_RECENT_EVENT_LIMIT = 10;

export function resolveSessionViewThrottleMs(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
  const raw = process.env.HARNESS_SESSION_VIEW_THROTTLE_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return DEFAULT_SESSION_VIEW_THROTTLE_MS;
}

export function createSessionViewEmitter(options: SessionViewEmitterOptions): SessionViewEmitter {
  const throttleMs = resolveSessionViewThrottleMs(options.throttleMs);
  const recentLimit = Math.max(1, options.recentLimit ?? DEFAULT_RECENT_EVENT_LIMIT);
  const now = options.now ?? Date.now;

  let version = 0;
  let totalEvents = 0;
  let lastEvent: RecentEvent | undefined;
  const recentEvents: RecentEvent[] = [];
  const lastByCategory: Partial<Record<EventCategory, RecentEvent>> = {};

  let pendingTimer: NodeJS.Timeout | null = null;
  let dirty = false;
  let lastBroadcastMs = 0;
  let stopped = false;

  function buildSnapshot(): SessionView {
    return {
      version,
      generatedAt: new Date(now()).toISOString(),
      totalEvents,
      lastEvent,
      recentEvents: recentEvents.slice(),
      lastByCategory: { ...lastByCategory },
    };
  }

  function publish(): void {
    if (stopped) return;
    version += 1;
    dirty = false;
    lastBroadcastMs = now();
    options.broadcast({ type: 'session_view', view: buildSnapshot() });
  }

  function scheduleBroadcast(): void {
    if (stopped || pendingTimer) return;
    if (throttleMs <= 0) {
      publish();
      return;
    }
    const sinceLast = now() - lastBroadcastMs;
    const wait = Math.max(0, throttleMs - sinceLast);
    if (wait === 0) {
      publish();
      return;
    }
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (dirty) publish();
    }, wait);
    if (typeof pendingTimer.unref === 'function') pendingTimer.unref();
  }

  function onEvent(event: HarnessEvent): void {
    if (stopped) return;
    totalEvents += 1;
    const recent: RecentEvent = {
      category: event.category,
      type: event.type,
      at: event.timestamp,
      subject_id: event.subject_id,
      actor: event.actor,
    };
    lastEvent = recent;
    lastByCategory[event.category] = recent;
    recentEvents.unshift(recent);
    if (recentEvents.length > recentLimit) recentEvents.length = recentLimit;
    dirty = true;
    scheduleBroadcast();
  }

  const unsubscribe = options.subscribe(onEvent);

  return {
    snapshot: buildSnapshot,
    stop(): void {
      if (stopped) return;
      stopped = true;
      try { unsubscribe(); } catch { /* best-effort */ }
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    },
  };
}
