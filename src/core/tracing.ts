export type TraceStatus = 'ok' | 'error';

export interface TraceRecord {
  id: string;
  name: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status?: TraceStatus;
  attributes: Record<string, unknown>;
  error?: string;
}

export interface TraceEvent {
  id: string;
  name: string;
  timestamp: string;
  attributes: Record<string, unknown>;
}

export interface TraceSpan {
  id: string;
  end(status?: TraceStatus, attributes?: Record<string, unknown>): void;
  fail(error: unknown, attributes?: Record<string, unknown>): void;
}

export class RuntimeTracer {
  private spans: TraceRecord[] = [];
  private events: TraceEvent[] = [];

  constructor(private readonly maxRecords = 500) {}

  startSpan(name: string, attributes: Record<string, unknown> = {}): TraceSpan {
    const record: TraceRecord = {
      id: createTraceId(),
      name,
      startedAt: new Date().toISOString(),
      attributes,
    };
    const started = Date.now();
    this.spans.push(record);
    this.trim();

    return {
      id: record.id,
      end: (status: TraceStatus = 'ok', attributes: Record<string, unknown> = {}) => {
        if (record.endedAt) return;
        record.endedAt = new Date().toISOString();
        record.durationMs = Date.now() - started;
        record.status = status;
        record.attributes = { ...record.attributes, ...attributes };
      },
      fail: (error: unknown, attributes: Record<string, unknown> = {}) => {
        if (record.endedAt) return;
        record.endedAt = new Date().toISOString();
        record.durationMs = Date.now() - started;
        record.status = 'error';
        record.error = error instanceof Error ? error.message : String(error);
        record.attributes = { ...record.attributes, ...attributes };
      },
    };
  }

  recordEvent(name: string, attributes: Record<string, unknown> = {}): void {
    this.events.push({ id: createTraceId(), name, timestamp: new Date().toISOString(), attributes });
    this.trim();
  }

  snapshot(): { spans: TraceRecord[]; events: TraceEvent[] } {
    return {
      spans: this.spans.map((span) => ({ ...span, attributes: { ...span.attributes } })),
      events: this.events.map((event) => ({ ...event, attributes: { ...event.attributes } })),
    };
  }

  clear(): void {
    this.spans = [];
    this.events = [];
  }

  private trim(): void {
    if (this.spans.length > this.maxRecords) {
      this.spans = this.spans.slice(-this.maxRecords);
    }
    if (this.events.length > this.maxRecords) {
      this.events = this.events.slice(-this.maxRecords);
    }
  }
}

export const runtimeTracer = new RuntimeTracer();

function createTraceId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}