import { redact, redactSecrets } from '../safety/secretRedactor';

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
      attributes: redactAttributes(attributes),
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
        record.attributes = { ...record.attributes, ...redactAttributes(attributes) };
      },
      fail: (error: unknown, attributes: Record<string, unknown> = {}) => {
        if (record.endedAt) return;
        record.endedAt = new Date().toISOString();
        record.durationMs = Date.now() - started;
        record.status = 'error';
        record.error = redact(error instanceof Error ? error.message : String(error));
        record.attributes = { ...record.attributes, ...redactAttributes(attributes) };
      },
    };
  }

  recordEvent(name: string, attributes: Record<string, unknown> = {}): void {
    this.events.push({ id: createTraceId(), name, timestamp: new Date().toISOString(), attributes: redactAttributes(attributes) });
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

/**
 * Scrub recognized secrets from string-valued attributes before they are
 * stored in the trace buffer (and later exported via OTLP or shown in the UI).
 * Only top-level string values are scanned — that covers the high-risk
 * `tool.input` / `tool.output` attributes without recursing into structured
 * payloads or paying a cost on numeric/boolean fields.
 */
function redactAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  let scrubbed: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value !== 'string') continue;
    const { result, count } = redactSecrets(value);
    if (count === 0) continue;
    scrubbed ??= { ...attributes };
    scrubbed[key] = result;
  }
  return scrubbed ?? attributes;
}