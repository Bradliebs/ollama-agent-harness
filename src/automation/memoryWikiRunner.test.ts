/**
 * Tests for the rebuild-memory-wiki CLI and its adapter.
 *
 * We test the pure adapter directly (shape mapping) and run the CLI as
 * a child process against an empty project to prove it produces an
 * index.html and exits 0 even when the semantic memory store has no
 * entries to render.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { entriesToMemoryEntries } from '../services/memoryWikiAdapter';
import type { SemanticMemoryEntry } from '../persistence/semanticMemory';

describe('entriesToMemoryEntries', () => {
  it('maps the harness semantic entry shape onto the wiki MemoryEntryLike shape', () => {
    const raw: SemanticMemoryEntry[] = [
      {
        id: 'evt-1',
        sessionId: 'sess-a',
        timestamp: '2026-05-22T09:15:00.000Z',
        kind: 'message',
        text: 'Hello, wiki.',
        tokens: ['hello', 'wiki'],
      },
      {
        id: 'evt-2',
        sessionId: 'sess-b',
        timestamp: '2026-05-22T10:00:00.000Z',
        kind: 'tool_result',
        text: 'tool output body',
        tokens: ['tool', 'output', 'body'],
      },
    ];
    const mapped = entriesToMemoryEntries(raw);
    expect(mapped).toEqual([
      { id: 'evt-1', sessionId: 'sess-a', timestamp: '2026-05-22T09:15:00.000Z', kind: 'message', text: 'Hello, wiki.' },
      { id: 'evt-2', sessionId: 'sess-b', timestamp: '2026-05-22T10:00:00.000Z', kind: 'tool_result', text: 'tool output body' },
    ]);
    // tokens are dropped — they only matter to semantic search, not the wiki.
    expect((mapped[0] as unknown as Record<string, unknown>).tokens).toBeUndefined();
  });

  it('returns an empty list for an empty input', () => {
    expect(entriesToMemoryEntries([])).toEqual([]);
  });
});

describe('scripts/rebuild-memory-wiki.js (smoke)', () => {
  let projectDir: string;
  let outDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'memwiki-proj-'));
    outDir = mkdtempSync(join(tmpdir(), 'memwiki-out-'));
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  it('exits 0 and writes index.html on an empty project (zero entries)', () => {
    const script = resolve(__dirname, '..', '..', 'scripts', 'rebuild-memory-wiki.js');
    execFileSync(process.execPath, [script, '--project', projectDir, '--out', outDir], {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    const indexFile = join(outDir, 'index.html');
    expect(existsSync(indexFile)).toBe(true);
    const html = readFileSync(indexFile, 'utf-8');
    expect(html).toContain('Personal Memory Wiki');
    expect(html).toContain('No entries yet.');
  }, 60_000);
});
