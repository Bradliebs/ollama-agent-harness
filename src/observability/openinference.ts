// OpenInference span mappers.
//
// Transforms in-process `RuntimeTracer` records into OTLP/HTTP-JSON
// payloads decorated with OpenInference semantic conventions so external
// observability backends (Phoenix, Laminar, Langfuse, OTel collectors)
// can ingest harness traces without a custom adapter.
//
// Pure: no I/O, no deps. The HTTP transport lives in `otlpExporter.ts`.

import type { TraceEvent, TraceRecord } from '../core/tracing';

/**
 * OpenInference span kinds — the small subset the harness uses today.
 * Mapped from the upstream spec at
 * https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md
 */
export type OpenInferenceSpanKind =
  | 'LLM'
  | 'TOOL'
  | 'AGENT'
  | 'CHAIN'
  | 'RETRIEVER'
  | 'EMBEDDING'
  | 'GUARDRAIL'
  | 'EVALUATOR'
  | 'UNKNOWN';

export interface OtlpKeyValue {
  key: string;
  value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number; // 1=INTERNAL, 3=CLIENT, 2=SERVER
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: { code: number; message?: string }; // 1=Ok, 2=Error
}

export interface OtlpResourceSpansPayload {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{
      scope: { name: string; version?: string };
      spans: OtlpSpan[];
    }>;
  }>;
}

const SCOPE_NAME = 'harness';
const SCOPE_VERSION = '1';

/**
 * Infer OpenInference span kind from the harness span name. The harness
 * names spans like `model.chat`, `tool.bash`, `context.compaction`, and
 * emits events such as `session.append`, `synthesis.fired`. Prefix +
 * keyword matching covers the live span vocabulary today.
 */
export function inferSpanKind(name: string): OpenInferenceSpanKind {
  const lower = String(name ?? '').toLowerCase();
  if (lower.startsWith('llm') || lower.startsWith('model.') || lower.startsWith('chat.') || lower.includes('completion') || lower.includes('synthesis')) return 'LLM';
  if (lower.startsWith('tool.') || lower.startsWith('tool_') || lower.startsWith('bash') || lower.startsWith('file_')) return 'TOOL';
  if (lower.startsWith('agent.') || lower.startsWith('subagent') || lower.startsWith('squad.')) return 'AGENT';
  if (lower.startsWith('chain.') || lower.startsWith('workflow') || lower.startsWith('queryloop') || lower.startsWith('context.') || lower.startsWith('session.')) return 'CHAIN';
  if (lower.startsWith('retriev') || lower.startsWith('rag') || lower.startsWith('mycelium') || lower.includes('search')) return 'RETRIEVER';
  if (lower.startsWith('embed')) return 'EMBEDDING';
  if (lower.startsWith('guard') || lower.includes('safety') || lower.includes('permission')) return 'GUARDRAIL';
  if (lower.startsWith('eval') || lower.startsWith('verifier') || lower.startsWith('output.validation')) return 'EVALUATOR';
  return 'UNKNOWN';
}

function isoToUnixNano(iso: string | undefined, fallback: number): string {
  if (!iso) return String(fallback * 1_000_000);
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return String(fallback * 1_000_000);
  return String(ms * 1_000_000);
}

/**
 * Generate deterministic 32/16-char hex ids. We accept whatever id shape
 * the harness uses upstream and pad/truncate it for OTLP. Backends only
 * require uniqueness within a trace, not cryptographic strength.
 */
export function normalizeOtelId(id: string, length: 32 | 16): string {
  const hex = String(id ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (hex.length >= length) return hex.slice(0, length);
  return hex.padEnd(length, '0');
}

function toAttributes(input: Record<string, unknown>): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = [];
  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'string') out.push({ key, value: { stringValue: raw } });
    else if (typeof raw === 'boolean') out.push({ key, value: { boolValue: raw } });
    else if (typeof raw === 'number') {
      if (Number.isInteger(raw)) out.push({ key, value: { intValue: String(raw) } });
      else out.push({ key, value: { doubleValue: raw } });
    } else {
      // Fallback to JSON for objects / arrays so they survive transport
      // without breaking the OTLP type schema.
      try { out.push({ key, value: { stringValue: JSON.stringify(raw) } }); }
      catch { /* skip un-serialisable */ }
    }
  }
  return out;
}

/**
 * Convert a RuntimeTracer span record into an OpenInference-decorated
 * OTLP span. The harness never reuses a parent span id today, so spans
 * are emitted as roots; backends that want a tree view can group by
 * trace id (we use a single per-process trace id supplied by the caller).
 */
export function spanToOtlp(span: TraceRecord, traceIdHex: string): OtlpSpan {
  const startMs = Date.parse(span.startedAt);
  const endMs = span.endedAt ? Date.parse(span.endedAt) : startMs + (span.durationMs ?? 0);
  const kind = inferSpanKind(span.name);
  const enriched = enrichForOpenInference(kind, span.name, span.attributes);
  const attributes = toAttributes({
    ...enriched,
    'openinference.span.kind': kind,
    'harness.span.name': span.name,
    ...(span.error ? { 'exception.message': span.error } : {}),
  });
  const status = span.status === 'error'
    ? { code: 2, message: span.error }
    : { code: 1 };
  return {
    traceId: traceIdHex,
    spanId: normalizeOtelId(span.id, 16),
    name: span.name,
    kind: 1,
    startTimeUnixNano: isoToUnixNano(span.startedAt, startMs),
    endTimeUnixNano: isoToUnixNano(span.endedAt, endMs),
    attributes,
    status,
  };
}

/**
 * Map harness-internal attribute names onto OpenInference / OTel GenAI
 * semantic conventions. Backends like Phoenix / Langfuse key analytics
 * off these standardised names.
 */
function enrichForOpenInference(
  kind: OpenInferenceSpanKind,
  name: string,
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...attributes };
  if (kind === 'LLM') {
    if (typeof attributes.model === 'string' && !('llm.model_name' in attributes)) {
      out['llm.model_name'] = attributes.model;
    }
    if (typeof attributes.promptTokens === 'number' && !('llm.token_count.prompt' in attributes)) {
      out['llm.token_count.prompt'] = attributes.promptTokens;
    }
    if (typeof attributes.completionTokens === 'number' && !('llm.token_count.completion' in attributes)) {
      out['llm.token_count.completion'] = attributes.completionTokens;
    }
    if (typeof attributes.promptTokens === 'number' && typeof attributes.completionTokens === 'number') {
      out['llm.token_count.total'] = attributes.promptTokens + attributes.completionTokens;
    }
  }
  if (kind === 'TOOL') {
    // For event-style entries like `tool.bash`, derive tool.name from the suffix.
    if (!('tool.name' in attributes)) {
      const dotIdx = name.indexOf('.');
      if (dotIdx >= 0 && dotIdx < name.length - 1) out['tool.name'] = name.slice(dotIdx + 1);
    }
    if (attributes.input !== undefined && !('tool.parameters' in attributes)) {
      out['tool.parameters'] = attributes.input;
    }
  }
  if (kind === 'RETRIEVER' && typeof attributes.query === 'string' && !('retrieval.query' in attributes)) {
    out['retrieval.query'] = attributes.query;
  }
  return out;
}

/**
 * Convert a `recordEvent` entry into a zero-duration span. OTel does
 * support stand-alone log records, but emitting them as spans keeps the
 * exporter focused on a single signal type for now.
 */
export function eventToOtlp(event: TraceEvent, traceIdHex: string): OtlpSpan {
  const startMs = Date.parse(event.timestamp);
  const kind = inferSpanKind(event.name);
  const enriched = enrichForOpenInference(kind, event.name, event.attributes);
  return {
    traceId: traceIdHex,
    spanId: normalizeOtelId(event.id, 16),
    name: event.name,
    kind: 1,
    startTimeUnixNano: isoToUnixNano(event.timestamp, startMs),
    endTimeUnixNano: isoToUnixNano(event.timestamp, startMs),
    attributes: toAttributes({
      ...enriched,
      'openinference.span.kind': kind,
      'harness.event.name': event.name,
      'harness.event': true,
    }),
    status: { code: 1 },
  };
}

export interface BuildPayloadInput {
  spans: TraceRecord[];
  events?: TraceEvent[];
  traceIdHex: string;
  serviceName?: string;
  serviceVersion?: string;
  /** Extra resource attributes (deployment env, tenant, etc.). */
  resourceAttributes?: Record<string, unknown>;
}

/**
 * Build the full OTLP/HTTP JSON payload. The default export endpoint for
 * OTLP/HTTP is `/v1/traces`; the exporter prepends the configured base URL.
 */
export function buildOtlpPayload(input: BuildPayloadInput): OtlpResourceSpansPayload {
  const spans = input.spans.map((span) => spanToOtlp(span, input.traceIdHex));
  const events = (input.events ?? []).map((event) => eventToOtlp(event, input.traceIdHex));
  return {
    resourceSpans: [
      {
        resource: {
          attributes: toAttributes({
            'service.name': input.serviceName ?? 'harness',
            'service.version': input.serviceVersion ?? '0',
            'telemetry.sdk.name': 'harness-openinference',
            ...(input.resourceAttributes ?? {}),
          }),
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
            spans: [...spans, ...events],
          },
        ],
      },
    ],
  };
}

/**
 * Mint a 32-char hex trace id from a string seed (process id + start
 * time, typically). Stable for the life of the process.
 */
export function mintTraceId(seed: string): string {
  let hash = 0n;
  for (const char of seed) {
    hash = (hash * 1099511628211n) ^ BigInt(char.charCodeAt(0));
    hash &= 0xffffffffffffffffn;
  }
  const lower = hash.toString(16).padStart(16, '0');
  // Mix the seed length and current time into the upper half so two
  // processes with a similar seed don't collide.
  const upperSeed = `${seed.length.toString(16)}${Date.now().toString(16)}`;
  const upper = upperSeed.padStart(16, '0').slice(-16);
  return (upper + lower).slice(0, 32);
}
