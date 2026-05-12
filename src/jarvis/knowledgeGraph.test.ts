import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { appendRecord, findEntityByName, getKnowledgeGraphStatus, recall, upsertEntity } from './knowledgeGraph';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harness-kg-'));
}

describe('knowledge graph', () => {
  it('appends an entity and reads it back', async () => {
    const dir = await tmpDir();
    await appendRecord(dir, { kind: 'entity', type: 'project', name: 'Apollo', source: 'test' });
    const found = await findEntityByName(dir, 'Apollo', 'project');
    expect(found?.name).toBe('Apollo');
  });

  it('upserts entity attributes by merging deltas', async () => {
    const dir = await tmpDir();
    await upsertEntity(dir, 'person', 'Alice', { role: 'engineer' }, 'test');
    await upsertEntity(dir, 'person', 'Alice', { team: 'platform' }, 'test');
    const found = await findEntityByName(dir, 'Alice', 'person');
    expect(found?.attributes).toMatchObject({ role: 'engineer', team: 'platform' });
  });

  it('recall returns token-overlap matches sorted by score', async () => {
    const dir = await tmpDir();
    await appendRecord(dir, { kind: 'fact', subject: 'release', predicate: 'depends_on', object: 'changelog', confidence: 0.9, source: 'test' });
    await appendRecord(dir, { kind: 'fact', subject: 'login', predicate: 'depends_on', object: 'session', confidence: 0.9, source: 'test' });
    const result = await recall(dir, 'release changelog');
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.facts[0].subject).toBe('release');
  });

  it('tolerates a truncated trailing JSONL line', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, '.harness', 'jarvis', 'knowledge.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{"kind":"entity","id":"e1","type":"file","name":"a.ts","source":"x","observedAt":"2026-05-12T00:00:00Z"}\n{"kind":"entity","id":"e2"', 'utf8');
    const status = await getKnowledgeGraphStatus(dir);
    expect(status.records).toBe(1);
  });

  it('reports empty status for a fresh project', async () => {
    const dir = await tmpDir();
    const status = await getKnowledgeGraphStatus(dir);
    expect(status).toMatchObject({ records: 0, entities: 0, edges: 0, facts: 0 });
  });
});
