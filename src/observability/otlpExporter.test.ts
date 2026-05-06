import { attachOtlpExporter, createOtlpExporter } from './otlpExporter';
import { RuntimeTracer } from '../core/tracing';

function jsonResponse(status = 200): Response {
  return new Response('{}', { status, headers: { 'content-type': 'application/json' } });
}

describe('observability/otlpExporter', () => {
  it('is a no-op when no endpoint is configured', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const exporter = createOtlpExporter({ fetchImpl });
    exporter.enqueueSpan({ id: 'a', name: 'tool.bash', startedAt: new Date().toISOString(), attributes: {} });
    const result = await exporter.flush();
    expect(result.exported).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    await exporter.shutdown();
  });

  it('flushes queued spans to the OTLP endpoint as JSON', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200)) as unknown as typeof fetch;
    const exporter = createOtlpExporter({
      endpoint: 'http://collector.example',
      fetchImpl,
      flushIntervalMs: 0,
      flushThreshold: 1000,
      traceIdHex: '0'.repeat(32),
      logger: { warn: () => { /* mute */ } },
    });
    exporter.enqueueSpan({ id: 'a', name: 'tool.bash', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 5, status: 'ok', attributes: {} });
    const result = await exporter.flush();
    expect(result.ok).toBe(true);
    expect(result.exported).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe('http://collector.example/v1/traces');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.resourceSpans).toBeTruthy();
    await exporter.shutdown();
  });

  it('eagerly flushes when the queue passes flushThreshold', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200)) as unknown as typeof fetch;
    const exporter = createOtlpExporter({
      endpoint: 'http://collector.example',
      fetchImpl,
      flushIntervalMs: 0,
      flushThreshold: 2,
      traceIdHex: '0'.repeat(32),
      logger: { warn: () => { /* mute */ } },
    });
    exporter.enqueueSpan({ id: 'a', name: 'tool.bash', startedAt: new Date().toISOString(), attributes: {} });
    exporter.enqueueSpan({ id: 'b', name: 'tool.bash', startedAt: new Date().toISOString(), attributes: {} });
    // Allow the eager flush to settle.
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await exporter.shutdown();
  });

  it('re-queues spans when the endpoint returns a non-2xx', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(503)) as unknown as typeof fetch;
    const exporter = createOtlpExporter({
      endpoint: 'http://collector.example',
      fetchImpl,
      flushIntervalMs: 0,
      flushThreshold: 1000,
      traceIdHex: '0'.repeat(32),
      logger: { warn: () => { /* mute */ } },
    });
    exporter.enqueueSpan({ id: 'a', name: 'tool.bash', startedAt: new Date().toISOString(), attributes: {} });
    const result = await exporter.flush();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTTP 503/);
    expect(exporter.status().queued).toBe(1);
    await exporter.shutdown();
  });

  it('captures the failure message when fetch throws', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    const exporter = createOtlpExporter({
      endpoint: 'http://collector.example',
      fetchImpl,
      flushIntervalMs: 0,
      flushThreshold: 1000,
      traceIdHex: '0'.repeat(32),
      logger: { warn: () => { /* mute */ } },
    });
    exporter.enqueueSpan({ id: 'a', name: 'tool.bash', startedAt: new Date().toISOString(), attributes: {} });
    const result = await exporter.flush();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
    expect(exporter.status().lastError).toMatch(/ECONNREFUSED/);
    await exporter.shutdown();
  });
});

describe('attachOtlpExporter', () => {
  it('forwards span end + recordEvent to the exporter', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200)) as unknown as typeof fetch;
    const tracer = new RuntimeTracer();
    const handle = attachOtlpExporter(tracer, {
      endpoint: 'http://collector.example',
      fetchImpl,
      flushIntervalMs: 0,
      flushThreshold: 1000,
      traceIdHex: '0'.repeat(32),
      logger: { warn: () => { /* mute */ } },
    });
    const span = tracer.startSpan('tool.bash', {});
    span.end('ok');
    tracer.recordEvent('tool.use', {});
    const result = await handle.exporter.flush();
    expect(result.exported).toBeGreaterThanOrEqual(2);
    await handle.detach();
  });

  it('detach() restores the original startSpan/recordEvent methods', async () => {
    const tracer = new RuntimeTracer();
    const handle = attachOtlpExporter(tracer, {
      endpoint: 'http://collector.example',
      fetchImpl: jest.fn().mockResolvedValue(jsonResponse(200)) as unknown as typeof fetch,
      flushIntervalMs: 0,
      logger: { warn: () => { /* mute */ } },
    });
    const wrapped = tracer.startSpan;
    await handle.detach();
    // After detach the wrapper is no longer in place. We can't compare to
    // the original prototype reference because attachOtlpExporter binds
    // it; instead, verify the wrapped reference is gone.
    expect(tracer.startSpan).not.toBe(wrapped);
  });
});
