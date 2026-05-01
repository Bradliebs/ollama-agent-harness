import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { previewBuild, build, search, TEXT_EXTENSIONS } from './ragIndex';

describe('ragIndex previewBuild', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-rag-preview-'));
    await fs.mkdir(path.join(projectDir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(projectDir, 'docs', 'guide.md'), '# Guide\n\nSome text.', 'utf-8');
    await fs.writeFile(path.join(projectDir, 'docs', 'notes.txt'), 'plain notes', 'utf-8');
    await fs.writeFile(path.join(projectDir, 'README.md'), '# Project', 'utf-8');
    await fs.mkdir(path.join(projectDir, 'images'), { recursive: true });
    await fs.writeFile(path.join(projectDir, 'images', 'logo.bin'), 'binary', 'utf-8');
    await fs.writeFile(path.join(projectDir, 'photo.png'), 'fake-png', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('reports matched directories with sample files and counts', async () => {
    const preview = await previewBuild(projectDir, ['docs', 'README.md']);
    expect(preview.totalFiles).toBe(3);
    expect(preview.paths).toHaveLength(2);
    const docs = preview.paths.find((p) => p.input === 'docs');
    expect(docs?.status).toBe('matched');
    expect(docs?.kind).toBe('directory');
    expect(docs?.fileCount).toBe(2);
    expect(docs?.sampleFiles).toEqual(expect.arrayContaining([expect.stringContaining('guide.md'), expect.stringContaining('notes.txt')]));
    const readme = preview.paths.find((p) => p.input === 'README.md');
    expect(readme?.status).toBe('matched');
    expect(readme?.kind).toBe('file');
    expect(readme?.fileCount).toBe(1);
  });

  it('flags missing paths, empty directories, and unsupported extensions', async () => {
    const preview = await previewBuild(projectDir, ['missing-folder', 'images', 'photo.png']);
    expect(preview.totalFiles).toBe(0);
    const missing = preview.paths.find((p) => p.input === 'missing-folder');
    expect(missing?.status).toBe('missing');
    const images = preview.paths.find((p) => p.input === 'images');
    expect(images?.status).toBe('empty-directory');
    const photo = preview.paths.find((p) => p.input === 'photo.png');
    expect(photo?.status).toBe('unsupported-extension');
  });

  it('exposes supported extensions and skipped directories for the UI hint', async () => {
    const preview = await previewBuild(projectDir, ['README.md']);
    expect(preview.supportedExtensions).toEqual(expect.arrayContaining(['.md', '.ts', '.py']));
    expect(preview.skippedDirectories).toEqual(expect.arrayContaining(['node_modules', '.git', 'dist', '.harness']));
    expect(TEXT_EXTENSIONS.has('.md')).toBe(true);
  });

  it('returns preview diagnostics from build alongside chunk counts', async () => {
    const result = await build(projectDir, 'preview-test', ['docs', 'missing-folder'], { backend: 'hash', ollamaHost: 'http://127.0.0.1:1' });
    expect(result.files).toBe(2);
    expect(result.preview.totalFiles).toBe(2);
    expect(result.preview.paths.find((p) => p.input === 'missing-folder')?.status).toBe('missing');
    const hits = await search(projectDir, 'preview-test', 'guide', { k: 5, ollamaHost: 'http://127.0.0.1:1' });
    expect(hits.length).toBeGreaterThan(0);
  });
});
