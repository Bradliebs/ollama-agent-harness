import { mineNextActions, suggestNextAfter, type ActionEvent } from './predictiveEngine';

function ev(key: string, n: number, capability?: string): ActionEvent {
  return { key, at: new Date(2026, 0, 1, 0, 0, n).toISOString(), capability };
}

describe('predictive engine', () => {
  it('detects a strong sequential pattern', () => {
    const events: ActionEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(ev('grep', i * 2));
      events.push(ev('file_read', i * 2 + 1));
    }
    const suggestions = mineNextActions(events, { minSamples: 3, minConfidence: 0.5 });
    const grepFollowup = suggestNextAfter('grep', suggestions);
    expect(grepFollowup?.predicted).toBe('file_read');
    expect(grepFollowup?.sampleSize).toBeGreaterThanOrEqual(3);
  });

  it('respects minSamples threshold', () => {
    const events: ActionEvent[] = [ev('a', 1), ev('b', 2), ev('a', 3), ev('b', 4)];
    const suggestions = mineNextActions(events, { minSamples: 5 });
    expect(suggestions).toHaveLength(0);
  });

  it('ignores self-loops', () => {
    const events: ActionEvent[] = [ev('write', 1), ev('write', 2), ev('write', 3), ev('write', 4)];
    const suggestions = mineNextActions(events, { minSamples: 1, minConfidence: 0 });
    expect(suggestions.find((s) => s.predicted === 'write')).toBeUndefined();
  });

  it('attaches capability when the predicted action carries one', () => {
    const events: ActionEvent[] = [
      ev('plan', 1),
      ev('bash', 2, 'shell'),
      ev('plan', 3),
      ev('bash', 4, 'shell'),
      ev('plan', 5),
      ev('bash', 6, 'shell'),
    ];
    const suggestions = mineNextActions(events, { minSamples: 3 });
    expect(suggestions[0]?.predicted).toBe('bash');
    expect(suggestions[0]?.capability).toBe('shell');
  });

  it('ranks by confidence × sample size', () => {
    const events: ActionEvent[] = [];
    // Strong pattern A→B (5 of 5)
    for (let i = 0; i < 5; i++) { events.push(ev('A', i * 2)); events.push(ev('B', i * 2 + 1)); }
    // Weak pattern C→D (3 of 6)
    for (let i = 0; i < 3; i++) { events.push(ev('C', 100 + i * 4)); events.push(ev('D', 101 + i * 4)); events.push(ev('C', 102 + i * 4)); events.push(ev('E', 103 + i * 4)); }
    const suggestions = mineNextActions(events, { minSamples: 3, minConfidence: 0.3 });
    expect(suggestions[0].trigger).toBe('A');
  });
});
