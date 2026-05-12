import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { EvidenceCard } from '../types/evidence';
import { ingestEvidenceCard } from './evidenceIngester';
import { findEntityByName, getKnowledgeGraphStatus, recall } from './knowledgeGraph';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harness-ingest-'));
}

function card(overrides: Partial<EvidenceCard> = {}): EvidenceCard {
  return {
    id: 'card-1', kind: 'chat', mode: 'build', createdAt: '2026-05-12T10:00:00Z',
    request: 'edit payment file', model: 'llama3.2', tools: [{ name: 'file_edit', success: true }],
    files: [{ path: 'src/payment.ts', action: 'edit' }], commands: [], artifacts: [],
    ...overrides,
  };
}

describe('evidence ingester', () => {
  it('writes run, tool, file entities and edges', async () => {
    const dir = await tmpDir();
    const result = await ingestEvidenceCard(dir, card());
    expect(result.written).toBeGreaterThan(3);
    const status = await getKnowledgeGraphStatus(dir);
    expect(status.entities).toBeGreaterThanOrEqual(3); // run + tool + file (each upsert appends)
    expect(status.edges).toBeGreaterThanOrEqual(2);
    expect(status.facts).toBeGreaterThanOrEqual(2);
  });

  it('stores file entities recallable by name', async () => {
    const dir = await tmpDir();
    await ingestEvidenceCard(dir, card());
    const file = await findEntityByName(dir, 'src/payment.ts', 'file');
    expect(file).toBeDefined();
  });

  it('recall query surfaces ingested run', async () => {
    const dir = await tmpDir();
    await ingestEvidenceCard(dir, card({ request: 'fix the failing checkout test' }));
    const result = await recall(dir, 'checkout test');
    expect(result.entities.length + result.facts.length).toBeGreaterThan(0);
  });

  it('handles cards with no files or tools', async () => {
    const dir = await tmpDir();
    const result = await ingestEvidenceCard(dir, card({ tools: [], files: [] }));
    expect(result.written).toBeGreaterThanOrEqual(2); // run entity + used_model fact
  });
});
