// Knowledge graph compaction.
//
// `appendRecord` is append-only by design (matches sessions / learning
// candidates / evidence cards). Over time the JSONL grows: every entity
// upsert appends a delta, every edge appends, every fact appends. This
// module reads the full log and rewrites it as a smaller, semantically
// equivalent snapshot:
//
//   * Entities of the same id+type+name are merged into one record with
//     the union of attributes (last write wins per key).
//   * Edges deduped by (from, to, relation). Weight sums.
//   * Facts kept whole — they are by design historical observations.
//
// Pure function over readAll → returns the compacted record list. Caller
// writes back to disk with a single atomic rewrite.

import * as fs from 'fs/promises';
import * as path from 'path';
import { readAll, type GraphEdge, type GraphEntity, type GraphFact, type GraphRecord } from './knowledgeGraph';

export interface CompactionStats {
  before: number;
  after: number;
  entitiesMerged: number;
  edgesDeduped: number;
  factsRetained: number;
}

export interface CompactionResult {
  records: GraphRecord[];
  stats: CompactionStats;
}

export function compactRecords(records: GraphRecord[]): CompactionResult {
  // Entities by stable key
  const entityByKey = new Map<string, GraphEntity>();
  let entitiesIn = 0;

  // Edges deduped by triple
  const edgeByKey = new Map<string, GraphEdge>();
  let edgesIn = 0;

  const facts: GraphFact[] = [];

  for (const record of records) {
    if (record.kind === 'entity') {
      entitiesIn++;
      const key = `${record.type}::${record.name.toLowerCase()}`;
      const prev = entityByKey.get(key);
      if (prev) {
        entityByKey.set(key, {
          ...prev,
          attributes: { ...(prev.attributes ?? {}), ...(record.attributes ?? {}) },
          observedAt: record.observedAt > prev.observedAt ? record.observedAt : prev.observedAt,
        });
      } else {
        entityByKey.set(key, { ...record });
      }
    } else if (record.kind === 'edge') {
      edgesIn++;
      const key = `${record.from}->${record.to}::${record.relation}`;
      const prev = edgeByKey.get(key);
      if (prev) {
        edgeByKey.set(key, { ...prev, weight: (prev.weight ?? 1) + (record.weight ?? 1), observedAt: record.observedAt });
      } else {
        edgeByKey.set(key, { ...record });
      }
    } else if (record.kind === 'fact') {
      facts.push(record);
    }
  }

  const compacted: GraphRecord[] = [
    ...entityByKey.values(),
    ...edgeByKey.values(),
    ...facts,
  ];

  return {
    records: compacted,
    stats: {
      before: records.length,
      after: compacted.length,
      entitiesMerged: entitiesIn - entityByKey.size,
      edgesDeduped: edgesIn - edgeByKey.size,
      factsRetained: facts.length,
    },
  };
}

export async function compactKnowledgeGraph(projectDir: string): Promise<CompactionStats> {
  const records = await readAll(projectDir);
  const { records: out, stats } = compactRecords(records);
  const filePath = path.join(projectDir, '.harness', 'jarvis', 'knowledge.jsonl');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, out.map((r) => JSON.stringify(r)).join('\n') + (out.length ? '\n' : ''), 'utf-8');
  return stats;
}
