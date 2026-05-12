import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { appendRunEvidence, clearEvidenceAppendHooks, readRunEvidence, setEvidenceAppendHook, type StoredRunEvidence } from './evidenceStore';

function makeEvidence(overrides: Partial<StoredRunEvidence> = {}): StoredRunEvidence {
  return {
    id: `test-${Date.now()}`,
    kind: 'automation',
    mode: 'build',
    createdAt: new Date().toISOString(),
    request: 'test evidence',
    tools: [],
    files: [],
    commands: [],
    artifacts: [],
    ...overrides,
  };
}

describe('evidenceStore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when evidence file is missing', async () => {
    const result = await readRunEvidence(tmpDir);
    expect(result).toEqual([]);
  });

  it('appends and reads a single evidence card', async () => {
    const card = makeEvidence({ id: 'single', runName: 'test-run' });
    await appendRunEvidence(tmpDir, card);
    const result = await readRunEvidence(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('single');
    expect(result[0].runName).toBe('test-run');
  });

  it('appends multiple cards and returns them in reverse chronological order', async () => {
    await appendRunEvidence(tmpDir, makeEvidence({ id: 'first' }));
    await appendRunEvidence(tmpDir, makeEvidence({ id: 'second' }));
    await appendRunEvidence(tmpDir, makeEvidence({ id: 'third' }));
    const result = await readRunEvidence(tmpDir);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('third');
    expect(result[2].id).toBe('first');
  });

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await appendRunEvidence(tmpDir, makeEvidence({ id: `card-${i}` }));
    }
    const result = await readRunEvidence(tmpDir, 2);
    expect(result).toHaveLength(2);
    // Should get the last 2 written, reversed
    expect(result[0].id).toBe('card-4');
    expect(result[1].id).toBe('card-3');
  });

  it('creates the evidence directory if it does not exist', async () => {
    const nested = path.join(tmpDir, 'deep', 'nested');
    await appendRunEvidence(nested, makeEvidence({ id: 'nested-card' }));
    const result = await readRunEvidence(nested);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('nested-card');
  });

  it('tolerates a corrupt line in the evidence file', async () => {
    const filePath = path.join(tmpDir, '.harness', 'evidence', 'runs.jsonl');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const good = JSON.stringify(makeEvidence({ id: 'good' }));
    await fs.writeFile(filePath, good + '\n{bad json\n', 'utf-8');
    const result = await readRunEvidence(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('good');
  });

  it('handles an empty evidence file', async () => {
    const filePath = path.join(tmpDir, '.harness', 'evidence', 'runs.jsonl');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '', 'utf-8');
    const result = await readRunEvidence(tmpDir);
    expect(result).toEqual([]);
  });

  it('handles a file with only whitespace lines', async () => {
    const filePath = path.join(tmpDir, '.harness', 'evidence', 'runs.jsonl');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '\n  \n\n', 'utf-8');
    const result = await readRunEvidence(tmpDir);
    expect(result).toEqual([]);
  });

  it('streams large files without reading everything into memory', async () => {
    // Write more entries than the default limit to verify the ring-buffer trim.
    for (let i = 0; i < 150; i++) {
      await appendRunEvidence(tmpDir, makeEvidence({ id: `bulk-${i}` }));
    }
    const result = await readRunEvidence(tmpDir, 10);
    expect(result).toHaveLength(10);
    expect(result[0].id).toBe('bulk-149');
    expect(result[9].id).toBe('bulk-140');
  });

  it('prunes stored evidence to the latest entries on append', async () => {
    const filePath = path.join(tmpDir, '.harness', 'evidence', 'runs.jsonl');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const seeded = Array.from({ length: 1000 }, (_, i) => JSON.stringify(makeEvidence({ id: `retained-${i}` }))).join('\n') + '\n';
    await fs.writeFile(filePath, seeded, 'utf-8');

    await appendRunEvidence(tmpDir, makeEvidence({ id: 'retained-1000' }));

    const lines = (await fs.readFile(filePath, 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(1000);
    expect(JSON.parse(lines[0]).id).toBe('retained-1');
    expect(JSON.parse(lines[999]).id).toBe('retained-1000');
  });

  describe('append hooks', () => {
    afterEach(() => clearEvidenceAppendHooks());

    it('fires registered hooks after append', async () => {
      const seen: string[] = [];
      setEvidenceAppendHook((_dir, evidence) => { seen.push(evidence.id); });
      await appendRunEvidence(tmpDir, makeEvidence({ id: 'hook-1' }));
      expect(seen).toEqual(['hook-1']);
    });

    it('isolates hook errors from the append result', async () => {
      setEvidenceAppendHook(() => { throw new Error('boom'); });
      await expect(appendRunEvidence(tmpDir, makeEvidence({ id: 'hook-2' }))).resolves.toMatch(/runs\.jsonl$/);
    });

    it('clearEvidenceAppendHooks removes all hooks', async () => {
      let count = 0;
      setEvidenceAppendHook(() => { count++; });
      clearEvidenceAppendHooks();
      await appendRunEvidence(tmpDir, makeEvidence({ id: 'hook-3' }));
      expect(count).toBe(0);
    });
  });
});
