/**
 * Defensive-input coverage for the ReflectTool.
 *
 * Live autonomy runs surfaced a class of NPEs where models call `reflect`
 * with a synonym key (issue, reason, message, details) or with a non-string
 * value. The original implementation read `input.observation` and called
 * `.slice()` on it without checking, which threw on every malformed call.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ReflectTool } from './learningTools';

describe('ReflectTool defensive input handling', () => {
  const originalCwd = process.cwd();
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reflect-tool-'));
    process.chdir(workDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('saves a normal observation', async () => {
    const result = await ReflectTool.execute({ observation: 'noticed a pattern in the loop' });
    expect(result.success).toBe(true);
    const notes = await fs.readFile(path.join(workDir, '.harness', 'memory', 'notes.md'), 'utf-8');
    expect(notes).toContain('noticed a pattern in the loop');
  });

  it('returns a structured failure when observation is missing entirely', async () => {
    const result = await ReflectTool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toBe('missing observation');
    expect(result.output).toMatch(/observation/);
  });

  it.each(['issue', 'reason', 'message', 'details', 'note', 'text'])(
    'accepts %s as a synonym for observation',
    async (key) => {
      const result = await ReflectTool.execute({ [key]: 'fallback content' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('fallback content');
    },
  );

  it('coerces non-string observation values to JSON without throwing', async () => {
    const result = await ReflectTool.execute({ observation: { foo: 1, bar: [2, 3] } as unknown as string });
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/foo/);
  });

  it('rejects an empty-string observation', async () => {
    const result = await ReflectTool.execute({ observation: '   ' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('empty observation');
  });

  it('writes pattern reflections to patterns.md', async () => {
    const result = await ReflectTool.execute({ observation: 'reusable approach', category: 'pattern' });
    expect(result.success).toBe(true);
    const patterns = await fs.readFile(path.join(workDir, '.harness', 'memory', 'patterns.md'), 'utf-8');
    expect(patterns).toContain('reusable approach');
  });
});
