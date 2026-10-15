import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildMentionedFilesBlock, extractFileMentions, searchProjectFiles } from './fileMentions';

describe('@ file mentions', () => {
  let projectDir: string;
  const resolveIn = (dir: string) => (value: string): string | null => {
    const resolved = path.resolve(dir, value);
    const rel = path.relative(dir, resolved);
    return rel.startsWith('..') || path.isAbsolute(rel) ? null : resolved;
  };

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentions-'));
    fs.mkdirSync(path.join(projectDir, 'src', 'utils'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'utils', 'date.ts'), 'export const a = 1;\nexport const b = 2;\n');
    fs.writeFileSync(path.join(projectDir, 'src', 'app.ts'), 'import { a } from "./utils/date";\n');
    fs.writeFileSync(path.join(projectDir, 'node_modules', 'pkg', 'date.js'), 'x');
    fs.writeFileSync(path.join(projectDir, '.harness', 'api-keys.json'), '{"OPENAI_API_KEY":"secret"}');
    fs.writeFileSync(path.join(projectDir, 'logo.bin'), Buffer.from([1, 0, 2, 3]));
  });

  afterEach(() => fs.rmSync(projectDir, { recursive: true, force: true }));

  it('extracts @paths without trailing punctuation, emails or duplicates', () => {
    expect(extractFileMentions('Fix @src/app.ts, then @src/app.ts again (see @README.md). Mail me@example.com'))
      .toEqual(['src/app.ts', 'README.md']);
  });

  it('inlines mentioned files and skips non-files, binaries, harness state and paths outside the project', async () => {
    const { block, included, notFound } = await buildMentionedFilesBlock(
      'Compare @src/utils/date.ts with @src and @logo.bin and @.harness/api-keys.json and @../outside.txt and @someone',
      { projectDir, resolvePath: resolveIn(projectDir), maxTotalChars: 10_000 },
    );
    expect(block).toContain('### src/utils/date.ts');
    expect(block).toContain('export const b = 2;');
    expect(block).not.toContain('secret');
    expect(block).not.toContain('logo.bin');
    expect(block).not.toContain('### src\n');
    expect(included).toEqual([{ path: 'src/utils/date.ts', truncated: false }]);
    expect(notFound).toEqual(expect.arrayContaining(['.harness/api-keys.json', '../outside.txt']));
    expect(notFound).not.toContain('someone');
  });

  it('blocks harness state however the path is cased', async () => {
    const { block, notFound } = await buildMentionedFilesBlock('see @.HARNESS/api-keys.json and @.Harness./api-keys.json', { projectDir, resolvePath: resolveIn(projectDir), maxTotalChars: 10_000 });
    expect(block).toBeNull();
    expect(notFound).toEqual(['.HARNESS/api-keys.json', '.Harness./api-keys.json']);
  });

  it('cuts long files at a whole line and says where to continue', async () => {
    fs.writeFileSync(path.join(projectDir, 'big.txt'), Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n'));
    const { block } = await buildMentionedFilesBlock('read @big.txt', { projectDir, resolvePath: resolveIn(projectDir), maxTotalChars: 300 });
    expect(block).toMatch(/showing lines 1-\d+ of 200; read the rest with file_read start_line=\d+/);
    expect(block).not.toContain('line 200');
  });

  it('reads only the start of a huge file', async () => {
    fs.writeFileSync(path.join(projectDir, 'huge.log'), Array.from({ length: 400_000 }, (_, i) => `entry ${i + 1}`).join('\n'));
    const { block, included } = await buildMentionedFilesBlock('look at @huge.log', { projectDir, resolvePath: resolveIn(projectDir), maxTotalChars: 2_000 });
    expect(block).toMatch(/showing lines 1-\d+; the file is \d+ bytes, read the rest with file_read start_line=\d+/);
    expect(block!.length).toBeLessThan(2_500);
    expect(included).toEqual([{ path: 'huge.log', truncated: true }]);
  });

  it('returns null when nothing mentioned is a readable file', async () => {
    expect((await buildMentionedFilesBlock('ping @team about it', { projectDir, resolvePath: resolveIn(projectDir), maxTotalChars: 1000 })).block).toBeNull();
  });

  it('searches project files by name first, skipping dependency and dot folders', async () => {
    const files = await searchProjectFiles(projectDir, 'date');
    expect(files[0]).toBe('src/utils/date.ts');
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.includes('.harness'))).toBe(false);
  });
});
