// Personal Knowledge Graph — append-only entity + edge store.
//
// Stores three kinds of facts as JSONL lines under
// `.harness/jarvis/knowledge.jsonl`:
//
//   { kind: 'entity', id, type, name, attributes, source, observedAt }
//   { kind: 'edge',   id, from, to, relation, weight, source, observedAt }
//   { kind: 'fact',   id, subject, predicate, object, confidence, source, observedAt }
//
// Append-only matches the codebase pattern (sessions, learning candidates).
// Recall is in-memory after one full read; for production volume swap the
// reader for a SQLite or DuckDB layer behind the same interface.
//
// Entity types kept intentionally open-string so callers can grow the schema
// without forcing migrations: 'person', 'project', 'file', 'session',
// 'tool', 'deadline', 'decision', 'topic'.

import * as fs from 'fs/promises';
import * as path from 'path';

export type GraphRecordKind = 'entity' | 'edge' | 'fact';

export interface GraphEntity {
  kind: 'entity';
  id: string;
  type: string;
  name: string;
  attributes?: Record<string, unknown>;
  source: string;
  observedAt: string;
}

export interface GraphEdge {
  kind: 'edge';
  id: string;
  from: string;
  to: string;
  relation: string;
  weight?: number;
  source: string;
  observedAt: string;
}

export interface GraphFact {
  kind: 'fact';
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  source: string;
  observedAt: string;
}

export type GraphRecord = GraphEntity | GraphEdge | GraphFact;

export interface RecallResult {
  entities: GraphEntity[];
  edges: GraphEdge[];
  facts: GraphFact[];
  query: string;
}

function graphPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'jarvis', 'knowledge.jsonl');
}

function makeId(kind: GraphRecordKind): string {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export type AppendableEntity = Omit<GraphEntity, 'id' | 'observedAt'> & { id?: string; observedAt?: string };
export type AppendableEdge = Omit<GraphEdge, 'id' | 'observedAt'> & { id?: string; observedAt?: string };
export type AppendableFact = Omit<GraphFact, 'id' | 'observedAt'> & { id?: string; observedAt?: string };
export type AppendableRecord = AppendableEntity | AppendableEdge | AppendableFact;

export async function appendRecord(projectDir: string, record: AppendableRecord): Promise<GraphRecord> {
  const filePath = graphPath(projectDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const enriched: GraphRecord = {
    ...record,
    id: record.id ?? makeId(record.kind),
    observedAt: record.observedAt ?? new Date().toISOString(),
  } as GraphRecord;
  await fs.appendFile(filePath, JSON.stringify(enriched) + '\n', 'utf8');
  return enriched;
}

export async function readAll(projectDir: string): Promise<GraphRecord[]> {
  try {
    const raw = await fs.readFile(graphPath(projectDir), 'utf8');
    const out: GraphRecord[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as GraphRecord);
      } catch {
        // Tolerate truncated trailing lines, matching session storage convention
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Lightweight token-overlap recall. Replace with embeddings when volume warrants. */
export async function recall(projectDir: string, query: string, limit = 20): Promise<RecallResult> {
  const records = await readAll(projectDir);
  const tokens = tokenize(query);
  const scored: Array<{ record: GraphRecord; score: number }> = [];
  for (const record of records) {
    const haystack = recordHaystack(record);
    const score = scoreOverlap(tokens, haystack);
    if (score > 0) scored.push({ record, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit).map((s) => s.record);
  return {
    query,
    entities: top.filter((r): r is GraphEntity => r.kind === 'entity'),
    edges: top.filter((r): r is GraphEdge => r.kind === 'edge'),
    facts: top.filter((r): r is GraphFact => r.kind === 'fact'),
  };
}

/** Resolve an entity by name (case-insensitive exact match), most recent wins. */
export async function findEntityByName(projectDir: string, name: string, type?: string): Promise<GraphEntity | undefined> {
  const records = await readAll(projectDir);
  const matches = records.filter(
    (r): r is GraphEntity => r.kind === 'entity' && r.name.toLowerCase() === name.toLowerCase() && (!type || r.type === type),
  );
  // Most recent wins. On equal observedAt (two writes in the same millisecond,
  // common under fast CI), the later-appended record is the newer write, so
  // ties break toward file order via >= while iterating append-order records.
  return matches.reduce<GraphEntity | undefined>(
    (best, r) => (!best || r.observedAt >= best.observedAt ? r : best),
    undefined,
  );
}

/** Merge an entity by name+type, returning the existing id if found, else creating. */
export async function upsertEntity(
  projectDir: string,
  type: string,
  name: string,
  attributes: Record<string, unknown>,
  source: string,
): Promise<GraphEntity> {
  const existing = await findEntityByName(projectDir, name, type);
  if (existing) {
    // Append a delta record so history is preserved
    await appendRecord(projectDir, {
      kind: 'entity',
      id: existing.id,
      type,
      name,
      attributes: { ...(existing.attributes ?? {}), ...attributes },
      source,
    });
    return { ...existing, attributes: { ...(existing.attributes ?? {}), ...attributes } };
  }
  const created = await appendRecord(projectDir, { kind: 'entity', type, name, attributes, source });
  return created as GraphEntity;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

function recordHaystack(record: GraphRecord): string {
  if (record.kind === 'entity') return `${record.type} ${record.name} ${JSON.stringify(record.attributes ?? {})}`;
  if (record.kind === 'edge') return `${record.relation} ${record.from} ${record.to}`;
  return `${record.subject} ${record.predicate} ${record.object}`;
}

function scoreOverlap(query: Set<string>, haystack: string): number {
  const haystackTokens = tokenize(haystack);
  let hits = 0;
  for (const t of query) if (haystackTokens.has(t)) hits++;
  return hits;
}

export interface KnowledgeGraphStatus {
  records: number;
  entities: number;
  edges: number;
  facts: number;
  lastObservedAt?: string;
}

export async function getKnowledgeGraphStatus(projectDir: string): Promise<KnowledgeGraphStatus> {
  const records = await readAll(projectDir);
  return {
    records: records.length,
    entities: records.filter((r) => r.kind === 'entity').length,
    edges: records.filter((r) => r.kind === 'edge').length,
    facts: records.filter((r) => r.kind === 'fact').length,
    lastObservedAt: records.length ? records[records.length - 1].observedAt : undefined,
  };
}
