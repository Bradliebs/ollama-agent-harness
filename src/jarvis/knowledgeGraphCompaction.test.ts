import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { appendRecord, getKnowledgeGraphStatus, upsertEntity } from './knowledgeGraph';
import { compactKnowledgeGraph, compactRecords } from './knowledgeGraphCompaction';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harness-kg-compact-'));
}

describe('knowledge graph compaction', () => {
  it('merges duplicate entity deltas', () => {
    const records = [
      { kind: 'entity' as const, id: 'e1', type: 'file', name: 'a.ts', attributes: { owner: 'alice' }, source: 't', observedAt: '2026-05-12T00:00:00Z' },
      { kind: 'entity' as const, id: 'e1', type: 'file', name: 'a.ts', attributes: { team: 'x' }, source: 't', observedAt: '2026-05-12T01:00:00Z' },
    ];
    const { records: out, stats } = compactRecords(records);
    expect(stats.entitiesMerged).toBe(1);
    expect(out).toHaveLength(1);
    expect((out[0] as { attributes?: Record<string, unknown> }).attributes).toMatchObject({ owner: 'alice', team: 'x' });
  });

  it('dedupes edges with the same triple, summing weight', () => {
    const records = [
      { kind: 'edge' as const, id: 'e1', from: 'r', to: 't', relation: 'used', weight: 1, source: 'x', observedAt: '2026-05-12T00:00:00Z' },
      { kind: 'edge' as const, id: 'e2', from: 'r', to: 't', relation: 'used', weight: 1, source: 'x', observedAt: '2026-05-12T01:00:00Z' },
    ];
    const { records: out, stats } = compactRecords(records);
    expect(stats.edgesDeduped).toBe(1);
    expect(out).toHaveLength(1);
    expect((out[0] as { weight?: number }).weight).toBe(2);
  });

  it('retains all facts', () => {
    const records = [
      { kind: 'fact' as const, id: 'f1', subject: 'a', predicate: 'is', object: 'b', confidence: 1, source: 'x', observedAt: '2026-05-12T00:00:00Z' },
      { kind: 'fact' as const, id: 'f2', subject: 'a', predicate: 'is', object: 'b', confidence: 1, source: 'x', observedAt: '2026-05-12T01:00:00Z' },
    ];
    const { stats } = compactRecords(records);
    expect(stats.factsRetained).toBe(2);
  });

  it('compactKnowledgeGraph rewrites the file in place', async () => {
    const dir = await tmpDir();
    await upsertEntity(dir, 'file', 'b.ts', { a: 1 }, 'test');
    await upsertEntity(dir, 'file', 'b.ts', { b: 2 }, 'test');
    await appendRecord(dir, { kind: 'edge', from: '1', to: '2', relation: 'used', source: 'x' });
    await appendRecord(dir, { kind: 'edge', from: '1', to: '2', relation: 'used', source: 'x' });
    const stats = await compactKnowledgeGraph(dir);
    expect(stats.before).toBeGreaterThan(stats.after);
    const status = await getKnowledgeGraphStatus(dir);
    expect(status.entities).toBe(1);
    expect(status.edges).toBe(1);
  });
});
