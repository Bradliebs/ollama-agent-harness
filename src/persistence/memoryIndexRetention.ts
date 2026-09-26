export interface MemoryIndexRetentionLimits {
  maxEntries: number;
  maxTextChars: number;
  maxTokens: number;
}

export interface RetainableMemoryIndexEntry {
  id: string;
  timestamp: string;
  text: string;
  tokens: string[];
}

export const MEMORY_INDEX_RETENTION_LIMITS: MemoryIndexRetentionLimits = {
  maxEntries: 5000,
  maxTextChars: 3000,
  maxTokens: 384,
};

export function applyMemoryIndexRetention<T extends RetainableMemoryIndexEntry>(
  entries: T[],
  limits: MemoryIndexRetentionLimits = MEMORY_INDEX_RETENTION_LIMITS,
): T[] {
  const kept = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => compareEntriesByRecency(a.entry, b.entry, a.index, b.index))
    .slice(0, limits.maxEntries)
    .sort((a, b) => a.index - b.index);

  return kept.map(({ entry }) => ({
    ...entry,
    text: entry.text.length > limits.maxTextChars ? entry.text.slice(0, limits.maxTextChars) : entry.text,
    tokens: entry.tokens.length > limits.maxTokens ? entry.tokens.slice(0, limits.maxTokens) : entry.tokens,
  }));
}

function compareEntriesByRecency(
  a: RetainableMemoryIndexEntry,
  b: RetainableMemoryIndexEntry,
  aIndex: number,
  bIndex: number,
): number {
  const byTimestamp = b.timestamp.localeCompare(a.timestamp);
  if (byTimestamp !== 0) return byTimestamp;
  return aIndex - bIndex;
}
