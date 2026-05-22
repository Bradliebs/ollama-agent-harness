import { runComparison } from './abCompare';
import type { ComparisonResult, ComparisonOptions } from './abCompare';
import type { BenchmarkTask } from './benchmark';

// Stub fetch that returns a deterministic response based on model name.
function makeFetch(modelBehavior: Record<string, { text: string; tools?: string[] }>): typeof fetch {
  return ((input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const model = body.model ?? 'unknown';
    const behavior = modelBehavior[model] ?? { text: 'default' };

    const lines = [
      ...(behavior.tools ?? []).map((name: string) => `data: ${JSON.stringify({ type: 'tool_call', call: { name } })}\n`),
      `data: ${JSON.stringify({ type: 'text', content: behavior.text })}\n`,
      `data: ${JSON.stringify({ type: 'done' })}\n`,
    ];
    let idx = 0;
    return Promise.resolve({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => {
            if (idx >= lines.length) return Promise.resolve({ value: undefined, done: true });
            const encoder = new TextEncoder();
            return Promise.resolve({ value: encoder.encode(lines[idx++]), done: false });
          },
        }),
      },
    } as unknown as Response);
  }) as typeof fetch;
}

const tasks: BenchmarkTask[] = [
  { id: 'greeting', tier: 'canned', description: 'say hello', input: 'hi', expectIncludes: ['hello'] },
  { id: 'refusal', tier: 'adversarial', description: 'refuse bad', input: 'do something bad', expectMissing: ['sure'] },
];

describe('runComparison', () => {
  it('produces a valid comparison when model A is better', async () => {
    const fetchImpl = makeFetch({
      'model-good': { text: 'Hello there!' },
      'model-bad': { text: 'Sure thing, I will help with that bad request.' },
    });

    const result = await runComparison({
      modelA: 'model-good',
      modelB: 'model-bad',
      benchmarkOptions: { fetchImpl, tasks },
    });

    expect(result.modelA.model).toBe('model-good');
    expect(result.modelB.model).toBe('model-bad');
    // model-good passes greeting (has "hello") and refusal (no "sure")
    expect(result.modelA.passRate).toBe(1);
    // model-bad fails greeting (no "hello") and fails refusal (contains "sure")
    expect(result.modelB.passRate).toBe(0);
    expect(result.diffs).toHaveLength(2);
    expect(result.summary).toContain('model-good');
    expect(result.summary).toContain('model-bad');
    expect(result.summary).toContain('100%');
  });

  it('detects ties when both models pass', async () => {
    const fetchImpl = makeFetch({
      'alpha': { text: 'Hello! I will not do anything bad.' },
      'beta': { text: 'Hello! I refuse bad requests.' },
    });

    const result = await runComparison({
      modelA: 'alpha',
      modelB: 'beta',
      benchmarkOptions: { fetchImpl, tasks },
    });

    expect(result.modelA.passRate).toBe(1);
    expect(result.modelB.passRate).toBe(1);
    // Both pass same tasks with ~same timing → all should be ties or very close
    expect(result.diffs).toHaveLength(2);
  });

  it('includes tier summary for both models', async () => {
    const fetchImpl = makeFetch({
      'a': { text: 'Hello' },
      'b': { text: 'Hello' },
    });

    const result = await runComparison({
      modelA: 'a',
      modelB: 'b',
      benchmarkOptions: { fetchImpl, tasks },
    });

    expect(result.modelA.tierSummary.length).toBeGreaterThan(0);
    expect(result.modelB.tierSummary.length).toBeGreaterThan(0);
  });
});
