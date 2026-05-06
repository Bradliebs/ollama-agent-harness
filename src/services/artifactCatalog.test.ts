import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { listArtifacts, readArtifact } from './artifactCatalog';

describe('artifactCatalog', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-artifacts-'));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('returns an empty list when the root does not exist', async () => {
    const records = await listArtifacts(path.join(rootDir, 'missing'));
    expect(records).toEqual([]);
  });

  it('lists files with auto-tagged categories', async () => {
    await fs.writeFile(path.join(rootDir, 'report.md'), '# Hello\n');
    await fs.writeFile(path.join(rootDir, 'data.json'), '{}');
    await fs.writeFile(path.join(rootDir, 'plot.png'), Buffer.from([0]));
    const records = await listArtifacts(rootDir);
    expect(records).toHaveLength(3);
    const byName = Object.fromEntries(records.map((record) => [record.name, record]));
    expect(byName['report.md'].category).toBe('document');
    expect(byName['report.md'].tags).toEqual(expect.arrayContaining(['document', 'md', 'report']));
    expect(byName['data.json'].category).toBe('data');
    expect(byName['plot.png'].category).toBe('image');
  });

  it('walks nested directories and reports relative paths with forward slashes', async () => {
    const sub = path.join(rootDir, 'reports', '2026');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, 'q1.md'), 'q1');
    const records = await listArtifacts(rootDir);
    expect(records).toHaveLength(1);
    expect(records[0].relativePath).toBe('reports/2026/q1.md');
  });

  it('honours category and search filters', async () => {
    await fs.writeFile(path.join(rootDir, 'a.md'), 'a');
    await fs.writeFile(path.join(rootDir, 'b.json'), '{}');
    await fs.writeFile(path.join(rootDir, 'monthly-report.md'), 'r');
    const docs = await listArtifacts(rootDir, { category: 'document' });
    expect(docs.map((record) => record.name).sort()).toEqual(['a.md', 'monthly-report.md']);
    const reports = await listArtifacts(rootDir, { search: 'report' });
    expect(reports.map((record) => record.name)).toEqual(['monthly-report.md']);
  });

  it('readArtifact returns content within the byte cap', async () => {
    const fp = path.join(rootDir, 'doc.md');
    await fs.writeFile(fp, 'a'.repeat(100));
    const result = await readArtifact(rootDir, 'doc.md', 50);
    expect(result.truncated).toBe(true);
    expect(result.content).toHaveLength(50);
    expect(result.size).toBe(100);
  });

  it('readArtifact rejects path traversal', async () => {
    await expect(readArtifact(rootDir, '../etc/passwd')).rejects.toThrow(/Invalid|escapes/);
  });

  it('readArtifact rejects absolute paths that escape the root', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-outside-'));
    const outsideFile = path.join(outside, 'evil.txt');
    await fs.writeFile(outsideFile, 'nope');
    await expect(readArtifact(rootDir, outsideFile)).rejects.toThrow(/escapes/);
    await fs.rm(outside, { recursive: true, force: true });
  });
});
