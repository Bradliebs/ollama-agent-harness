import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteFile, withFileLock, _resetFileLocksForTest } from './atomicFile';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'atomic-file-test-'));
}

async function cleanup(dir: string): Promise<void> {
  try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('atomicWriteFile', () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await cleanup(dir); });

  it('writes the file contents to the destination', async () => {
    const target = path.join(dir, 'out.json');
    await atomicWriteFile(target, '{"hello":"world"}');
    expect(await fs.readFile(target, 'utf-8')).toBe('{"hello":"world"}');
  });

  it('creates parent directories as needed', async () => {
    const target = path.join(dir, 'nested', 'deep', 'out.json');
    await atomicWriteFile(target, 'ok');
    expect(await fs.readFile(target, 'utf-8')).toBe('ok');
  });

  it('rejects relative paths', async () => {
    await expect(atomicWriteFile('relative/out.json', 'x')).rejects.toThrow(/absolute path/i);
  });

  it('preserves the file mode option when provided', async () => {
    if (process.platform === 'win32') return; // mode bits are not meaningful on Windows
    const target = path.join(dir, 'secret.json');
    await atomicWriteFile(target, 'shh', { mode: 0o600 });
    const stat = await fs.stat(target);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('leaves no orphan temp file after a successful write', async () => {
    const target = path.join(dir, 'out.json');
    await atomicWriteFile(target, 'hello');
    const entries = await fs.readdir(dir);
    const orphans = entries.filter((name) => name.startsWith('.out.json.tmp.'));
    expect(orphans).toEqual([]);
    expect(entries).toContain('out.json');
  });

  it('overwrites an existing file atomically', async () => {
    const target = path.join(dir, 'out.json');
    await fs.writeFile(target, 'original');
    await atomicWriteFile(target, 'replaced');
    expect(await fs.readFile(target, 'utf-8')).toBe('replaced');
  });
});

describe('withFileLock', () => {
  beforeEach(() => { _resetFileLocksForTest(); });

  it('runs serial calls in order', async () => {
    const target = path.resolve('/tmp/withFileLock-test-path-1');
    const order: number[] = [];
    await withFileLock(target, async () => { order.push(1); });
    await withFileLock(target, async () => { order.push(2); });
    expect(order).toEqual([1, 2]);
  });

  it('serializes concurrent calls for the same path', async () => {
    const target = path.resolve('/tmp/withFileLock-test-path-2');
    const events: string[] = [];
    const a = withFileLock(target, async () => {
      events.push('a-start');
      await new Promise((r) => setTimeout(r, 40));
      events.push('a-end');
      return 'a';
    });
    const b = withFileLock(target, async () => {
      events.push('b-start');
      events.push('b-end');
      return 'b';
    });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe('a');
    expect(rb).toBe('b');
    expect(events).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('allows concurrent calls for different paths to interleave', async () => {
    const p1 = path.resolve('/tmp/withFileLock-test-path-a');
    const p2 = path.resolve('/tmp/withFileLock-test-path-b');
    const events: string[] = [];
    const a = withFileLock(p1, async () => {
      events.push('a-start');
      await new Promise((r) => setTimeout(r, 40));
      events.push('a-end');
    });
    const b = withFileLock(p2, async () => {
      events.push('b-start');
      await new Promise((r) => setTimeout(r, 10));
      events.push('b-end');
    });
    await Promise.all([a, b]);
    // b should complete before a because they're on different paths.
    expect(events.indexOf('b-end')).toBeLessThan(events.indexOf('a-end'));
  });

  it('does not poison the chain when fn throws', async () => {
    const target = path.resolve('/tmp/withFileLock-test-path-3');
    await expect(withFileLock(target, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // Next caller must still get to run.
    const result = await withFileLock(target, async () => 42);
    expect(result).toBe(42);
  });

  it('returns the value produced by fn', async () => {
    const target = path.resolve('/tmp/withFileLock-test-path-4');
    const result = await withFileLock(target, async () => ({ ok: true }));
    expect(result).toEqual({ ok: true });
  });

  it('rejects relative paths', async () => {
    await expect(withFileLock('relative', async () => 1)).rejects.toThrow(/absolute path/i);
  });
});

describe('atomicWriteFile + withFileLock together (race regression)', () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempDir(); _resetFileLocksForTest(); });
  afterEach(async () => { await cleanup(dir); });

  it('serializes read-modify-write cycles so no update is lost', async () => {
    // Without the lock, parallel RMW interleaves and one of the writes
    // overwrites the other's mutation. With the lock, both updates must
    // be visible in the final file.
    const target = path.join(dir, 'state.json');
    await atomicWriteFile(target, JSON.stringify({ items: [] as string[] }));
    const append = (label: string) => withFileLock(target, async () => {
      const raw = await fs.readFile(target, 'utf-8');
      const state = JSON.parse(raw) as { items: string[] };
      state.items.push(label);
      await atomicWriteFile(target, JSON.stringify(state));
    });
    await Promise.all([append('one'), append('two'), append('three')]);
    const final = JSON.parse(await fs.readFile(target, 'utf-8')) as { items: string[] };
    expect(final.items.sort()).toEqual(['one', 'three', 'two']);
  });
});
