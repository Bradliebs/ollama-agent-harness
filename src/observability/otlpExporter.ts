// Minimal OTLP/HTTP-JSON trace exporter.
//
// Speaks the OpenTelemetry Protocol over HTTP using the JSON encoding
// (protobuf is the official default but JSON is documented as a valid
// alternative). Avoids the full @opentelemetry/* dependency tree so the
// harness keeps its "no new runtime deps" posture intact.
//
// Behaviour:
//   * Drains a queue at most every `flushIntervalMs`, or eagerly when the
//     queue exceeds `flushThreshold`.
//   * Drops to a circular buffer if the endpoint fails — never blocks the
//     RuntimeTracer producer.
//   * Survives a missing endpoint quietly: when no `endpoint` is set the
//     exporter is a no-op.

import { buildOtlpPayload, type OtlpResourceSpansPayload } from './openinference';
import type { RuntimeTracer, TraceEvent, TraceRecord } from '../core/tracing';

export interface OtlpExporterOptions {
  /** Base URL, e.g. http://localhost:4318. The exporter appends /v1/traces. */
  endpoint?: string;
  /** Optional auth token, sent as `Authorization: <token>`. */
  authorization?: string;
  /** Process trace id; used to group all spans into one trace. */
  traceIdHex?: string;
  /** Service name reported in the OTLP resource. */
  serviceName?: string;
  /** Service version reported in the OTLP resource. */
  serviceVersion?: string;
  /** Extra OTLP resource attributes. */
  resourceAttributes?: Record<string, unknown>;
  /** Max time between flushes (ms). Default 5_000. */
  flushIntervalMs?: number;
  /** Eager flush after this many queued spans/events. Default 32. */
  flushThreshold?: number;
  /** Override fetch (mainly for tests). */
  fetchImpl?: typeof fetch;
  /** Console for warnings. Tests can mute it. */
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

export interface OtlpExporter {
  /** Queue a span record for export. */
  enqueueSpan(span: TraceRecord): void;
  /** Queue an event record for export. */
  enqueueEvent(event: TraceEvent): void;
  /** Force a flush; resolves once the HTTP call completes (or skips). */
  flush(): Promise<{ exported: number; ok: boolean; error?: string }>;
  /** Stop the timer + flush remaining items once. */
  shutdown(): Promise<void>;
  /** Snapshot of queue + last-call diagnostics. */
  status(): { queued: number; lastError?: string; lastSuccessAt?: string };
}

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_FLUSH_THRESHOLD = 32;
const DEFAULT_QUEUE_LIMIT = 1024;

export function createOtlpExporter(options: OtlpExporterOptions = {}): OtlpExporter {
  const endpoint = options.endpoint?.replace(/\/$/, '');
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const flushThreshold = options.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const logger = options.logger;
  const traceIdHex = options.traceIdHex ?? '';

  const spanQueue: TraceRecord[] = [];
  const eventQueue: TraceEvent[] = [];
  let lastError: string | undefined;
  let lastSuccessAt: string | undefined;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  function trim(): void {
    while (spanQueue.length > DEFAULT_QUEUE_LIMIT) spanQueue.shift();
    while (eventQueue.length > DEFAULT_QUEUE_LIMIT) eventQueue.shift();
  }

  function enqueueSpan(span: TraceRecord): void {
    if (!endpoint || stopped) return;
    spanQueue.push(span);
    trim();
    maybeFlushEarly();
  }

  function enqueueEvent(event: TraceEvent): void {
    if (!endpoint || stopped) return;
    eventQueue.push(event);
    trim();
    maybeFlushEarly();
  }

  function maybeFlushEarly(): void {
    if (spanQueue.length + eventQueue.length >= flushThreshold) {
      flush().catch(() => { /* recorded in lastError */ });
    }
  }

  async function flush(): Promise<{ exported: number; ok: boolean; error?: string }> {
    if (!endpoint) return { exported: 0, ok: true };
    if (!fetchImpl) {
      lastError = 'fetch is not available';
      return { exported: 0, ok: false, error: lastError };
    }
    if (spanQueue.length === 0 && eventQueue.length === 0) {
      return { exported: 0, ok: true };
    }
    const spans = spanQueue.splice(0, spanQueue.length);
    const events = eventQueue.splice(0, eventQueue.length);
    const payload: OtlpResourceSpansPayload = buildOtlpPayload({
      spans,
      events,
      traceIdHex: traceIdHex || mintFallbackTraceId(),
      serviceName: options.serviceName,
      serviceVersion: options.serviceVersion,
      resourceAttributes: options.resourceAttributes,
    });
    try {
      const response = await fetchImpl(`${endpoint}/v1/traces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options.authorization ? { Authorization: options.authorization } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        lastError = `OTLP exporter HTTP ${response.status}`;
        // Re-queue so the next flush retries.
        spanQueue.unshift(...spans);
        eventQueue.unshift(...events);
        trim();
        logger?.warn?.(lastError);
        return { exported: 0, ok: false, error: lastError };
      }
      lastSuccessAt = new Date().toISOString();
      return { exported: spans.length + events.length, ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = `OTLP exporter failed: ${message}`;
      // Re-queue and rely on the timer to retry.
      spanQueue.unshift(...spans);
      eventQueue.unshift(...events);
      trim();
      logger?.warn?.(lastError);
      return { exported: 0, ok: false, error: lastError };
    }
  }

  async function shutdown(): Promise<void> {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    await flush().catch(() => { /* lastError captured */ });
  }

  if (endpoint && flushIntervalMs > 0) {
    timer = setInterval(() => {
      flush().catch(() => { /* lastError captured */ });
    }, flushIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    enqueueSpan,
    enqueueEvent,
    flush,
    shutdown,
    status: () => ({
      queued: spanQueue.length + eventQueue.length,
      lastError,
      lastSuccessAt,
    }),
  };
}

function mintFallbackTraceId(): string {
  const seed = `${process.pid}-${Date.now()}`;
  let hex = '';
  for (let i = 0; i < seed.length; i++) {
    hex += seed.charCodeAt(i).toString(16);
  }
  return hex.padEnd(32, '0').slice(0, 32);
}

/**
 * Attach an OTLP exporter to a RuntimeTracer so every newly closed span
 * and recorded event flows through the exporter. Wraps the existing
 * `startSpan` / `recordEvent` methods rather than replacing them so all
 * downstream consumers keep working.
 *
 * Returns the exporter itself plus a detach() callback.
 */
export interface AttachOptions extends OtlpExporterOptions {
  exporter?: OtlpExporter;
}

export function attachOtlpExporter(tracer: RuntimeTracer, options: AttachOptions = {}): { exporter: OtlpExporter; detach: () => Promise<void> } {
  const exporter = options.exporter ?? createOtlpExporter(options);
  const originalStartSpan = tracer.startSpan.bind(tracer);
  const originalRecordEvent = tracer.recordEvent.bind(tracer);

  tracer.startSpan = (name: string, attributes?: Record<string, unknown>) => {
    const span = originalStartSpan(name, attributes);
    const wrappedEnd = span.end;
    const wrappedFail = span.fail;
    span.end = (status, attributes) => {
      wrappedEnd(status, attributes);
      const recent = tracer.snapshot().spans.find((record) => record.id === span.id);
      if (recent) exporter.enqueueSpan(recent);
    };
    span.fail = (error, attributes) => {
      wrappedFail(error, attributes);
      const recent = tracer.snapshot().spans.find((record) => record.id === span.id);
      if (recent) exporter.enqueueSpan(recent);
    };
    return span;
  };

  tracer.recordEvent = (name: string, attributes?: Record<string, unknown>) => {
    originalRecordEvent(name, attributes);
    const recent = tracer.snapshot().events.find((event) => event.name === name);
    if (recent) exporter.enqueueEvent(recent);
  };

  return {
    exporter,
    detach: async () => {
      tracer.startSpan = originalStartSpan;
      tracer.recordEvent = originalRecordEvent;
      await exporter.shutdown();
    },
  };
}
