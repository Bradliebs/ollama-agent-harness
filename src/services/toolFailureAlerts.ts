// Tool failure alerts.
//
// Sliding-window counter per tool name. Records each tool call result;
// when failure rate exceeds the configured threshold over a recent
// sample window (and the call count is large enough to be meaningful),
// fires a single `tool.failure_alert` notification.
//
// Single-fire with cooldown: an alert only fires once per `cooldownMs`
// to avoid spamming the operator. Reset on success-streak.
//
// Pure logic + an optional listener so the server can wire alerts onto
// the event store without coupling this module to it.

export interface ToolFailureAlertConfig {
  /** Window size — last N samples per tool. Default 50. */
  windowSize?: number;
  /** Minimum samples before the alert can fire. Default 10. */
  minSamples?: number;
  /** Failure rate that triggers the alert (0–1). Default 0.30. */
  failureThreshold?: number;
  /** Cooldown after a fired alert. Default 5 minutes. */
  cooldownMs?: number;
  /** Optional clock source for tests. */
  now?: () => number;
}

export interface ToolFailureAlert {
  tool: string;
  failureRate: number;
  failureCount: number;
  totalCount: number;
  windowSize: number;
  threshold: number;
  firedAt: string;
}

export type ToolFailureAlertListener = (alert: ToolFailureAlert) => void;

interface PerToolState {
  results: boolean[]; // true = success, false = failure
  lastAlertAt: number; // ms epoch; 0 means none yet
}

/**
 * Build a failure-alert tracker. Returned object exposes `record(tool,
 * success)` for each tool call and `subscribe(listener)` for callers
 * that want to receive alerts.
 */
export function createToolFailureAlerts(config: ToolFailureAlertConfig = {}) {
  const windowSize = Math.max(1, config.windowSize ?? 50);
  const minSamples = Math.max(1, config.minSamples ?? 10);
  const failureThreshold = Math.min(1, Math.max(0, config.failureThreshold ?? 0.30));
  const cooldownMs = Math.max(0, config.cooldownMs ?? 5 * 60 * 1000);
  const now = config.now ?? (() => Date.now());

  const states = new Map<string, PerToolState>();
  const listeners = new Set<ToolFailureAlertListener>();

  function record(tool: string, success: boolean): ToolFailureAlert | null {
    if (!tool) return null;
    let state = states.get(tool);
    if (!state) {
      state = { results: [], lastAlertAt: 0 };
      states.set(tool, state);
    }
    state.results.push(success);
    if (state.results.length > windowSize) state.results = state.results.slice(-windowSize);
    if (state.results.length < minSamples) return null;

    const failureCount = state.results.filter((value) => !value).length;
    const failureRate = failureCount / state.results.length;
    if (failureRate < failureThreshold) {
      return null;
    }
    const t = now();
    if (state.lastAlertAt && t - state.lastAlertAt < cooldownMs) return null;
    state.lastAlertAt = t;
    const alert: ToolFailureAlert = {
      tool,
      failureRate,
      failureCount,
      totalCount: state.results.length,
      windowSize,
      threshold: failureThreshold,
      firedAt: new Date(t).toISOString(),
    };
    for (const listener of listeners) {
      try { listener(alert); } catch { /* listener errors are non-fatal */ }
    }
    return alert;
  }

  function subscribe(listener: ToolFailureAlertListener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function status(): Record<string, { samples: number; failureCount: number; failureRate: number; lastAlertAt: string | null }> {
    const out: ReturnType<typeof status> = {};
    for (const [tool, state] of states) {
      const failureCount = state.results.filter((value) => !value).length;
      out[tool] = {
        samples: state.results.length,
        failureCount,
        failureRate: state.results.length === 0 ? 0 : failureCount / state.results.length,
        lastAlertAt: state.lastAlertAt ? new Date(state.lastAlertAt).toISOString() : null,
      };
    }
    return out;
  }

  function reset(): void {
    states.clear();
  }

  return { record, subscribe, status, reset };
}

export type ToolFailureAlertTracker = ReturnType<typeof createToolFailureAlerts>;
