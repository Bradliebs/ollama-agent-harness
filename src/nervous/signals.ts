// Nervous System — Signal model and signal bus.
//
// Signals are structured events emitted by the sensory layer and consumed
// by the reflex engine, attention controller, and pain engine.

export type SignalSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export type SignalType =
  | 'USER_INTENT'
  | 'USER_CORRECTION'
  | 'USER_CONFUSION'
  | 'USER_CONFIRMATION'
  | 'USER_ESCALATION'
  | 'TASK_RISK'
  | 'IRREVERSIBLE_ACTION'
  | 'TOOL_ERROR'
  | 'TOOL_SUCCESS'
  | 'AGENT_LOOP'
  | 'AGENT_STALL'
  | 'CONTEXT_OVERLOAD'
  | 'TOKEN_PRESSURE'
  | 'LOW_CONFIDENCE'
  | 'VERIFIER_FAIL'
  | 'VERIFIER_PASS'
  | 'SAFETY_RISK'
  | 'PRIVACY_RISK'
  | 'COST_SPIKE'
  | 'TIMEOUT_RISK'
  | 'REPEATED_FAILURE'
  | 'ROUTE_SUCCESS'
  | 'ROUTE_FAILURE'
  | 'MEMORY_CONFLICT'
  | 'FRESHNESS_REQUIRED'
  | 'EXTERNAL_ACTION_REQUEST'
  | 'DRY_RUN_REQUIRED'
  | 'CONFIRMATION_REQUIRED'
  | 'COMPRESSION_REQUIRED'
  | 'RECOVERY_REQUIRED';

export interface NervousSignal {
  id: string;
  type: SignalType;
  source: string;
  severity: SignalSeverity;
  confidence: number;
  message: string;
  metadata?: Record<string, unknown>;
  relatedEpisodeId?: string;
  relatedRouteId?: string;
  handled: boolean;
  handledBy?: string;
  actionTaken?: string;
  createdAt: string;
}

export type SignalHandler = (signal: NervousSignal) => void;

/**
 * In-memory signal bus. Publishes signals to registered handlers
 * and keeps a rolling log of recent signals for inspection.
 */
export class SignalBus {
  private handlers = new Map<string, SignalHandler[]>();
  private allHandlers: SignalHandler[] = [];
  private log: NervousSignal[] = [];
  private maxLog: number;

  constructor(maxLog = 200) {
    this.maxLog = maxLog;
  }

  /** Subscribe to a specific signal type. */
  on(type: SignalType, handler: SignalHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  /** Subscribe to all signals. */
  onAny(handler: SignalHandler): void {
    this.allHandlers.push(handler);
  }

  /** Publish a signal to all matching handlers. */
  publish(signal: NervousSignal): void {
    this.log.push(signal);
    if (this.log.length > this.maxLog) this.log.shift();
    for (const handler of this.allHandlers) handler(signal);
    const typed = this.handlers.get(signal.type);
    if (typed) for (const handler of typed) handler(signal);
  }

  /** Publish multiple signals. */
  publishMany(signals: NervousSignal[]): void {
    for (const signal of signals) this.publish(signal);
  }

  /** Get recent signals, optionally filtered by type or severity. */
  recent(filter?: { type?: SignalType; severity?: SignalSeverity; limit?: number }): NervousSignal[] {
    let result = this.log;
    if (filter?.type) result = result.filter((s) => s.type === filter.type);
    if (filter?.severity) result = result.filter((s) => s.severity === filter.severity);
    return result.slice(-(filter?.limit ?? 50));
  }

  /** Count signals by type in the current log. */
  counts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const signal of this.log) counts[signal.type] = (counts[signal.type] ?? 0) + 1;
    return counts;
  }

  /** Clear the log. */
  clear(): void {
    this.log = [];
  }
}

let signalCounter = 0;

/** Create a signal with auto-generated ID and timestamp. */
export function createSignal(
  type: SignalType,
  source: string,
  severity: SignalSeverity,
  message: string,
  metadata?: Record<string, unknown>,
): NervousSignal {
  return {
    id: `sig-${Date.now().toString(36)}-${(++signalCounter).toString(36)}`,
    type,
    source,
    severity,
    confidence: severityToConfidence(severity),
    message,
    metadata,
    handled: false,
    createdAt: new Date().toISOString(),
  };
}

function severityToConfidence(severity: SignalSeverity): number {
  switch (severity) {
    case 'critical': return 0.95;
    case 'high': return 0.85;
    case 'medium': return 0.7;
    case 'low': return 0.5;
    case 'info': return 0.3;
  }
}
