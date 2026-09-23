import { applyMemoryIndexRetention, MEMORY_INDEX_RETENTION_LIMITS, type RetainableMemoryIndexEntry } from './memoryIndexRetention';

function entry(id: string, timestamp: string, text = id, tokens: string[] = [id]): RetainableMemoryIndexEntry {
  return { id, timestamp, text, tokens };
}

describe('memoryIndexRetention', () => {
  it('keeps the most recent entries when the index exceeds the entry cap', () => {
    const entries = [
      entry('old', '2026-01-01T00:00:00.000Z'),
      entry('newest', '2026-01-03T00:00:00.000Z'),
      entry('middle', '2026-01-02T00:00:00.000Z'),
    ];

    const retained = applyMemoryIndexRetention(entries, { ...MEMORY_INDEX_RETENTION_LIMITS, maxEntries: 2 });

    expect(retained.map((item) => item.id)).toEqual(['newest', 'middle']);
  });

  it('truncates stored text and token lists without mutating the source entries', () => {
    const longText = 'x'.repeat(MEMORY_INDEX_RETENTION_LIMITS.maxTextChars + 10);
    const tokens = Array.from({ length: MEMORY_INDEX_RETENTION_LIMITS.maxTokens + 10 }, (_, index) => `token-${index}`);
    const entries = [entry('long', '2026-01-01T00:00:00.000Z', longText, tokens)];

    const [retained] = applyMemoryIndexRetention(entries);

    expect(retained.text).toHaveLength(MEMORY_INDEX_RETENTION_LIMITS.maxTextChars);
    expect(retained.tokens).toHaveLength(MEMORY_INDEX_RETENTION_LIMITS.maxTokens);
    expect(entries[0].text).toHaveLength(MEMORY_INDEX_RETENTION_LIMITS.maxTextChars + 10);
    expect(entries[0].tokens).toHaveLength(MEMORY_INDEX_RETENTION_LIMITS.maxTokens + 10);
  });
});
