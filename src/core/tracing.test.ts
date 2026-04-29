import { RuntimeTracer } from './tracing';

describe('RuntimeTracer', () => {
  it('records completed spans and events', () => {
    const tracer = new RuntimeTracer();
    const span = tracer.startSpan('unit.work', { phase: 'start' });

    tracer.recordEvent('unit.event', { seen: true });
    span.end('ok', { phase: 'done' });

    const snapshot = tracer.snapshot();
    expect(snapshot.spans[0]).toMatchObject({ name: 'unit.work', status: 'ok', attributes: { phase: 'done' } });
    expect(snapshot.spans[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.events[0]).toMatchObject({ name: 'unit.event', attributes: { seen: true } });
  });

  it('records span failures without throwing', () => {
    const tracer = new RuntimeTracer();
    const span = tracer.startSpan('unit.fail');

    span.fail(new Error('boom'));

    expect(tracer.snapshot().spans[0]).toMatchObject({ name: 'unit.fail', status: 'error', error: 'boom' });
  });

  it('trims old records to the configured maximum', () => {
    const tracer = new RuntimeTracer(2);

    tracer.recordEvent('first');
    tracer.recordEvent('second');
    tracer.recordEvent('third');

    expect(tracer.snapshot().events.map((event) => event.name)).toEqual(['second', 'third']);
  });
});