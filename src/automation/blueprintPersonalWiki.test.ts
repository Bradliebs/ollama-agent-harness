/**
 * Tests for the personal-wiki blueprint.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPersonalWiki, type MemoryEntryLike } from '../../cookbook/blueprint-personal-wiki';

const SAMPLE_ENTRIES: MemoryEntryLike[] = [
  { id: 'e1', timestamp: '2026-05-22T09:15:00.000Z', kind: 'decision', text: 'Picked the harness for the cortical brain pipeline.\n\nReasons: local-first, autonomy loop, RAG.', sessionId: 's1', tags: ['architecture', 'pick'] },
  { id: 'e2', timestamp: '2026-05-22T14:00:00.000Z', kind: 'note', text: 'Telegram bridge needs an allowlist before going live.', sessionId: 's1', tags: ['security'] },
  { id: 'e3', timestamp: '2026-05-21T10:00:00.000Z', kind: 'session', text: 'Pair-programmed the kanban bridge.', sessionId: 's2' },
  { id: 'tricky/<id>', timestamp: '2026-05-23T08:00:00.000Z', kind: 'edge', text: 'Body has <b>html</b> & special chars > ok.', tags: ['<test>'] },
];

describe('buildPersonalWiki', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'memwiki-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('creates index.html, per-entry pages, and per-day pages', () => {
    const result = buildPersonalWiki(SAMPLE_ENTRIES, workDir);
    expect(result.totalEntries).toBe(4);
    expect(existsSync(result.indexFile)).toBe(true);
    expect(result.entryFiles).toHaveLength(4);
    for (const f of result.entryFiles) expect(existsSync(f)).toBe(true);
    // Three distinct days
    expect(result.days.sort()).toEqual(['2026-05-21', '2026-05-22', '2026-05-23']);
    expect(result.dayFiles).toHaveLength(3);
  });

  it('index links to every entry page and every day page', () => {
    const result = buildPersonalWiki(SAMPLE_ENTRIES, workDir);
    const indexHtml = readFileSync(result.indexFile, 'utf-8');
    expect(indexHtml).toContain('./entries/e1.html');
    expect(indexHtml).toContain('./entries/e2.html');
    expect(indexHtml).toContain('./entries/e3.html');
    // Tricky id with slash/angle-bracket is safely renamed
    expect(indexHtml).toMatch(/\.\/entries\/tricky_<id>\.html|\.\/entries\/tricky__id_\.html/);
    expect(indexHtml).toContain('./by-day/2026-05-22.html');
    expect(indexHtml).toContain('./by-day/2026-05-21.html');
  });

  it('renders entries newest-first', () => {
    const result = buildPersonalWiki(SAMPLE_ENTRIES, workDir);
    const indexHtml = readFileSync(result.indexFile, 'utf-8');
    const e3Pos = indexHtml.indexOf('./entries/e3.html');
    const e1Pos = indexHtml.indexOf('./entries/e1.html');
    const tricky = indexHtml.search(/\.\/entries\/tricky/);
    // tricky (2026-05-23) < e1 (2026-05-22) < e3 (2026-05-21) in document order
    expect(tricky).toBeLessThan(e1Pos);
    expect(e1Pos).toBeLessThan(e3Pos);
  });

  it('escapes HTML in titles, bodies, ids and tags', () => {
    const result = buildPersonalWiki(SAMPLE_ENTRIES, workDir);
    const trickyFile = result.entryFiles.find((f) => /tricky/.test(f))!;
    const trickyHtml = readFileSync(trickyFile, 'utf-8');
    expect(trickyHtml).not.toContain('<b>html</b>');
    expect(trickyHtml).toContain('&lt;b&gt;html&lt;/b&gt;');
    expect(trickyHtml).toContain('&amp;');
    expect(trickyHtml).toContain('#&lt;test&gt;');
  });

  it('day pages list only their entries', () => {
    const result = buildPersonalWiki(SAMPLE_ENTRIES, workDir);
    const day22 = readFileSync(join(workDir, 'by-day', '2026-05-22.html'), 'utf-8');
    expect(day22).toContain('../entries/e1.html');
    expect(day22).toContain('../entries/e2.html');
    expect(day22).not.toContain('../entries/e3.html');
  });

  it('handles an empty entry list gracefully', () => {
    const result = buildPersonalWiki([], workDir);
    expect(result.totalEntries).toBe(0);
    expect(existsSync(result.indexFile)).toBe(true);
    const indexHtml = readFileSync(result.indexFile, 'utf-8');
    expect(indexHtml).toContain('No entries yet.');
  });

  it('is idempotent over the same input', () => {
    const r1 = buildPersonalWiki(SAMPLE_ENTRIES, workDir);
    const before = readFileSync(r1.indexFile).length;
    const r2 = buildPersonalWiki(SAMPLE_ENTRIES, workDir);
    const after = readFileSync(r2.indexFile).length;
    expect(after).toBe(before);
    expect(r2.entryFiles).toEqual(r1.entryFiles);
  });

  it('respects a custom title', () => {
    const result = buildPersonalWiki(SAMPLE_ENTRIES, workDir, { title: 'Brad’s Brain' });
    const indexHtml = readFileSync(result.indexFile, 'utf-8');
    expect(indexHtml).toContain('Brad’s Brain');
  });
});
