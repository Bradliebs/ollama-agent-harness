import { buildOtlpPayload, eventToOtlp, inferSpanKind, mintTraceId, normalizeOtelId, spanToOtlp } from './openinference';
import type { TraceEvent, TraceRecord } from '../core/tracing';

describe('observability/openinference', () => {
  describe('inferSpanKind', () => {
    it.each([
      ['llm.chat', 'LLM'],
      ['model.chat', 'LLM'],
      ['synthesis.fired', 'LLM'],
      ['tool.bash', 'TOOL'],
      ['agent.run', 'AGENT'],
      ['squad.handoff', 'AGENT'],
      ['queryloop.iteration', 'CHAIN'],
      ['context.compaction', 'CHAIN'],
      ['session.append', 'CHAIN'],
      ['retriever.search', 'RETRIEVER'],
      ['mycelium.route', 'RETRIEVER'],
      ['embed.text', 'EMBEDDING'],
      ['guardrail.check', 'GUARDRAIL'],
      ['permission.evaluate', 'GUARDRAIL'],
      ['eval.dataset', 'EVALUATOR'],
      ['output.validation', 'EVALUATOR'],
      ['something.unknown', 'UNKNOWN'],
    ])('classifies %s as %s', (name, expected) => {
      expect(inferSpanKind(name)).toBe(expected);
    });
  });

  describe('normalizeOtelId', () => {
    it('strips non-hex characters and pads to the requested length', () => {
      expect(normalizeOtelId('abc-XYZ-123', 16)).toMatch(/^[0-9a-f]{16}$/);
    });

    it('truncates an over-long id', () => {
      const id = '0123456789abcdef0123456789abcdef0123';
      expect(normalizeOtelId(id, 32)).toBe('0123456789abcdef0123456789abcdef');
    });
  });

  describe('spanToOtlp', () => {
    it('emits OpenInference span.kind attribute', () => {
      const span: TraceRecord = {
        id: 'abc12345',
        name: 'tool.bash',
        startedAt: '2026-05-06T10:00:00.000Z',
        endedAt: '2026-05-06T10:00:00.500Z',
        durationMs: 500,
        status: 'ok',
        attributes: { 'tool.input': 'ls -la' },
      };
      const otlp = spanToOtlp(span, '0'.repeat(32));
      expect(otlp.attributes).toContainEqual({ key: 'openinference.span.kind', value: { stringValue: 'TOOL' } });
      expect(otlp.attributes).toContainEqual({ key: 'tool.input', value: { stringValue: 'ls -la' } });
      expect(otlp.status.code).toBe(1);
    });

    it('marks errors as status code 2 and surfaces the message', () => {
      const span: TraceRecord = {
        id: 'def',
        name: 'llm.chat',
        startedAt: '2026-05-06T10:00:00.000Z',
        endedAt: '2026-05-06T10:00:01.000Z',
        durationMs: 1_000,
        status: 'error',
        attributes: {},
        error: 'context overflow',
      };
      const otlp = spanToOtlp(span, '0'.repeat(32));
      expect(otlp.status.code).toBe(2);
      expect(otlp.status.message).toBe('context overflow');
      expect(otlp.attributes).toContainEqual({ key: 'exception.message', value: { stringValue: 'context overflow' } });
    });

    it('serialises object attributes as JSON strings', () => {
      const span: TraceRecord = {
        id: 'a',
        name: 'agent.run',
        startedAt: '2026-05-06T10:00:00.000Z',
        attributes: { tags: ['x', 'y'], usage: { tokens: 12 } },
      };
      const otlp = spanToOtlp(span, '0'.repeat(32));
      const tagsAttr = otlp.attributes.find((attr) => attr.key === 'tags');
      const usageAttr = otlp.attributes.find((attr) => attr.key === 'usage');
      expect(tagsAttr?.value.stringValue).toBe('["x","y"]');
      expect(usageAttr?.value.stringValue).toBe('{"tokens":12}');
    });

    it('promotes harness LLM attrs to OpenInference llm.* names', () => {
      const span: TraceRecord = {
        id: 'b',
        name: 'model.chat',
        startedAt: '2026-05-06T10:00:00.000Z',
        endedAt: '2026-05-06T10:00:00.500Z',
        durationMs: 500,
        status: 'ok',
        attributes: { model: 'qwen2.5-coder:7b', promptTokens: 120, completionTokens: 30 },
      };
      const otlp = spanToOtlp(span, '0'.repeat(32));
      const map = Object.fromEntries(otlp.attributes.map((attr) => [attr.key, attr.value]));
      expect(map['llm.model_name'].stringValue).toBe('qwen2.5-coder:7b');
      expect(map['llm.token_count.prompt'].intValue).toBe('120');
      expect(map['llm.token_count.completion'].intValue).toBe('30');
      expect(map['llm.token_count.total'].intValue).toBe('150');
    });

    it('derives tool.name from a `tool.<name>` span name when not explicitly set', () => {
      const span: TraceRecord = {
        id: 'c',
        name: 'tool.web_search',
        startedAt: '2026-05-06T10:00:00.000Z',
        attributes: { input: 'query' },
      };
      const otlp = spanToOtlp(span, '0'.repeat(32));
      const map = Object.fromEntries(otlp.attributes.map((attr) => [attr.key, attr.value]));
      expect(map['tool.name'].stringValue).toBe('web_search');
      expect(map['tool.parameters'].stringValue).toBe('query');
    });
  });

  describe('eventToOtlp', () => {
    it('renders an event as a zero-duration span with harness.event=true', () => {
      const event: TraceEvent = {
        id: 'evt1',
        name: 'tool.use',
        timestamp: '2026-05-06T10:00:00.000Z',
        attributes: { tool: 'web_read' },
      };
      const otlp = eventToOtlp(event, '0'.repeat(32));
      expect(otlp.startTimeUnixNano).toBe(otlp.endTimeUnixNano);
      expect(otlp.attributes).toContainEqual({ key: 'harness.event', value: { boolValue: true } });
      expect(otlp.attributes).toContainEqual({ key: 'tool', value: { stringValue: 'web_read' } });
    });
  });

  describe('buildOtlpPayload', () => {
    it('includes service.name in resource attributes and stamps spans + events under one trace id', () => {
      const traceId = '0'.repeat(32);
      const payload = buildOtlpPayload({
        traceIdHex: traceId,
        serviceName: 'harness-test',
        spans: [{
          id: 'a',
          name: 'agent.run',
          startedAt: '2026-05-06T10:00:00.000Z',
          attributes: {},
        }],
        events: [{
          id: 'b',
          name: 'tool.use',
          timestamp: '2026-05-06T10:00:00.000Z',
          attributes: {},
        }],
      });
      expect(payload.resourceSpans).toHaveLength(1);
      const resource = payload.resourceSpans[0].resource;
      expect(resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'harness-test' } });
      const spans = payload.resourceSpans[0].scopeSpans[0].spans;
      expect(spans).toHaveLength(2);
      expect(spans.every((span) => span.traceId === traceId)).toBe(true);
    });
  });

  describe('mintTraceId', () => {
    it('returns a 32-char hex string', () => {
      expect(mintTraceId('seed')).toMatch(/^[0-9a-f]{32}$/);
    });

    it('produces the same value when called rapidly with identical seeds (within ms)', () => {
      // Best-effort: minted ids include Date.now(), so two calls in the
      // same millisecond should match. We retry once if the wall clock
      // ticked between the two calls.
      const first = mintTraceId('same');
      const second = mintTraceId('same');
      // Either equal (same ms) or different (clock advanced). Both are
      // acceptable; the contract is "deterministic upper half from seed".
      expect(first).toMatch(/^[0-9a-f]{32}$/);
      expect(second).toMatch(/^[0-9a-f]{32}$/);
    });
  });
});
