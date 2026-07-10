/**
 * memoryWikiAdapter — small shape translator between the harness's
 * semantic-memory store and the cookbook personal-wiki blueprint.
 *
 * Kept tiny and pure so the rebuild-memory-wiki CLI stays a thin shell
 * and the adapter can be unit-tested without spinning up real sessions.
 */
import type { SemanticMemoryEntry } from '../persistence/semanticMemory';

// Structural copy of cookbook/blueprint-personal-wiki's MemoryEntryLike.
// Duplicated here so this adapter stays inside the tsconfig rootDir.
export interface MemoryEntryLike {
  id: string;
  timestamp: string;
  kind: string;
  text: string;
  sessionId?: string;
  tags?: string[];
}

export function entriesToMemoryEntries(rawEntries: SemanticMemoryEntry[]): MemoryEntryLike[] {
  return rawEntries.map((entry) => ({
    id: entry.id,
    timestamp: entry.timestamp,
    kind: entry.kind,
    text: entry.text,
    sessionId: entry.sessionId,
  }));
}
