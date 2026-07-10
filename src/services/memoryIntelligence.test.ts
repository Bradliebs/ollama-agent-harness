import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  appendMemorySection,
  parseMemoryFile,
  renderMemoryFileForPrompt,
  runMemoryGc,
  runMemoryMaintenance,
  searchMemory,
  serializeMemoryFile,
} from './memoryIntelligence';

describe('memoryIntelligence', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mem-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('parses and serializes sections with importance metadata', () => {
    const content = '# Notes\n\n### 2026-05-01: alpha\n<!-- importance: high | created: 2026-05-01 -->\nLine one.\n\n### 2026-05-02: beta\n<!-- importance: low | created: 2026-05-02 -->\nLine two.\n';
    const file = parseMemoryFile(content, '/tmp/x.md');
    expect(file.sections).toHaveLength(2);
    expect(file.sections[0].importance).toBe('high');
    expect(file.sections[1].importance).toBe('low');
    expect(file.sections[0].createdAt).toBe('2026-05-01');
    const round = serializeMemoryFile(file);
    expect(round).toContain('### 2026-05-01: alpha');
    expect(round).toContain('### 2026-05-02: beta');
  });

  it('writes new sections with importance metadata', async () => {
    await appendMemorySection(projectDir, 'notes.md', '### Demo\nFirst.', { importance: 'high' });
    const content = await fs.readFile(path.join(projectDir, '.harness', 'memory', 'notes.md'), 'utf-8');
    expect(content).toContain('### Demo');
    expect(content).toMatch(/<!--\s*importance: high/);
  });

  it('round-trips provenance metadata (source-session, created-by)', async () => {
    await appendMemorySection(projectDir, 'notes.md', '### Provenanced\nBody.', {
      sourceSessionId: 'sess-123',
      createdByTool: 'remember',
    });
    const content = await fs.readFile(path.join(projectDir, '.harness', 'memory', 'notes.md'), 'utf-8');
    const parsed = parseMemoryFile(content, 'notes.md');
    const section = parsed.sections.find((s) => s.title === 'Provenanced');
    expect(section?.sourceSessionId).toBe('sess-123');
    expect(section?.createdByTool).toBe('remember');
  });

  it('omits provenance fields when not supplied (backward compatible)', async () => {
    await appendMemorySection(projectDir, 'notes.md', '### Plain\nBody.');
    const content = await fs.readFile(path.join(projectDir, '.harness', 'memory', 'notes.md'), 'utf-8');
    expect(content).not.toContain('source-session');
    expect(content).not.toContain('created-by');
    const parsed = parseMemoryFile(content, 'notes.md');
    const section = parsed.sections.find((s) => s.title === 'Plain');
    expect(section?.sourceSessionId).toBeUndefined();
    expect(section?.createdByTool).toBeUndefined();
  });

  it('skips duplicate appends with high line overlap', async () => {
    const body = '### Demo\nLine A.\nLine B.\nLine C.';
    const first = await appendMemorySection(projectDir, 'notes.md', body);
    expect(first.written).toBe(true);
    const second = await appendMemorySection(projectDir, 'notes.md', body);
    expect(second.written).toBe(false);
    expect(second.reason).toBe('duplicate-content');
  });

  it('still appends when content differs even if title repeats', async () => {
    await appendMemorySection(projectDir, 'notes.md', '### Demo\nLine A.\nLine B.', { dedup: false });
    const result = await appendMemorySection(projectDir, 'notes.md', '### Demo\nUnrelated.', { dedup: false });
    expect(result.written).toBe(true);
  });

  it('renders with TOC fallback when over budget', async () => {
    for (let i = 0; i < 20; i++) {
      const importance = i < 3 ? 'high' : 'low';
      await appendMemorySection(projectDir, 'notes.md', `### entry-${i}\n${'x'.repeat(400)}`, { importance });
    }
    const rendered = await renderMemoryFileForPrompt(projectDir, 'notes.md', { budgetChars: 4000 });
    expect(rendered).toContain('Table of Contents');
    expect(rendered).toContain('entry-0');
    // The high-importance entries should be expanded.
    expect(rendered.match(/entry-0/g)?.length).toBeGreaterThan(0);
  });

  it('searches across files with relevance ranking', async () => {
    await appendMemorySection(projectDir, 'patterns.md', '### Routing pattern\nUse model router for cost optimization.', { importance: 'high' });
    await appendMemorySection(projectDir, 'notes.md', '### Random\nUnrelated content here.', { importance: 'low' });
    const results = await searchMemory(projectDir, 'router');
    expect(results[0]?.title).toContain('Routing');
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  it('runs gc to drop empty sections and dedup repeated lines', async () => {
    const dir = path.join(projectDir, '.harness', 'memory');
    await fs.mkdir(dir, { recursive: true });
    const content = '# Notes\n\n### Empty\n<!-- importance: low | created: 2026-01-01 -->\n\n### Dup\n<!-- importance: medium | created: 2026-01-02 -->\nLine A.\nLine A.\nLine B.\n';
    await fs.writeFile(path.join(dir, 'notes.md'), content, 'utf-8');
    const summary = await runMemoryGc(projectDir);
    expect(summary.removedSections).toBe(1);
    expect(summary.dedupedLines).toBe(1);
    const after = await fs.readFile(path.join(dir, 'notes.md'), 'utf-8');
    expect(after).not.toContain('### Empty');
    // The duplicate "Line A." should appear only once.
    expect((after.match(/Line A\./g) ?? []).length).toBe(1);
  });

  it('runs maintenance to archive old low-importance sections', async () => {
    const dir = path.join(projectDir, '.harness', 'memory');
    await fs.mkdir(dir, { recursive: true });
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const content = `# Notes\n\n### old-section\n<!-- importance: low | created: ${old} -->\nstale\n\n### keep\n<!-- importance: high | created: 2026-05-01 -->\nkeep this\n`;
    await fs.writeFile(path.join(dir, 'notes.md'), content, 'utf-8');
    const summary = await runMemoryMaintenance(projectDir);
    expect(summary.archivedSections).toBe(1);
    const after = await fs.readFile(path.join(dir, 'notes.md'), 'utf-8');
    expect(after).not.toContain('old-section');
    expect(after).toContain('keep this');
    const archives = await fs.readdir(path.join(projectDir, '.harness', 'memory', '_archive'));
    expect(archives.some((name) => name.includes('week'))).toBe(true);
  });
});
