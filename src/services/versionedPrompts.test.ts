import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  savePromptVersion,
  loadRegistry,
  listRegistries,
  getActivePrompt,
  setActiveVersion,
  rollback,
  diffVersions,
  getVersion,
  renderPromptHistory,
  PromptRegistry,
} from './versionedPrompts';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── savePromptVersion ──────────────────────────────────────────────

describe('savePromptVersion', () => {
  it('creates first version with version=1', async () => {
    const v = await savePromptVersion(tmpDir, 'test', 'Hello prompt');
    expect(v.version).toBe(1);
  });

  it('auto-increments version numbers', async () => {
    await savePromptVersion(tmpDir, 'test', 'v1 content');
    const v2 = await savePromptVersion(tmpDir, 'test', 'v2 content');
    const v3 = await savePromptVersion(tmpDir, 'test', 'v3 content');
    expect(v2.version).toBe(2);
    expect(v3.version).toBe(3);
  });

  it('sets new version as active', async () => {
    await savePromptVersion(tmpDir, 'test', 'v1');
    await savePromptVersion(tmpDir, 'test', 'v2');
    const reg = await loadRegistry(tmpDir, 'test');
    expect(reg?.activeVersion).toBe(2);
  });

  it('persists to disk (round-trip with loadRegistry)', async () => {
    await savePromptVersion(tmpDir, 'test', 'persisted', {
      label: 'persist-label',
      author: 'tester',
      changelog: 'initial',
      tags: ['alpha'],
    });
    const reg = await loadRegistry(tmpDir, 'test');
    expect(reg).toBeDefined();
    expect(reg!.versions).toHaveLength(1);
    expect(reg!.versions[0].content).toBe('persisted');
    expect(reg!.versions[0].label).toBe('persist-label');
    expect(reg!.versions[0].author).toBe('tester');
    expect(reg!.versions[0].changelog).toBe('initial');
    expect(reg!.versions[0].tags).toEqual(['alpha']);
  });

  it('uses default label when none provided', async () => {
    const v = await savePromptVersion(tmpDir, 'test', 'content');
    expect(v.label).toBe('v1');
  });

  it('stores createdAt as ISO string', async () => {
    const v = await savePromptVersion(tmpDir, 'test', 'content');
    expect(() => new Date(v.createdAt)).not.toThrow();
    expect(v.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ─── loadRegistry ───────────────────────────────────────────────────

describe('loadRegistry', () => {
  it('returns undefined for missing name', async () => {
    const result = await loadRegistry(tmpDir, 'nonexistent');
    expect(result).toBeUndefined();
  });

  it('returns full registry after multiple saves', async () => {
    await savePromptVersion(tmpDir, 'multi', 'a');
    await savePromptVersion(tmpDir, 'multi', 'b');
    const reg = await loadRegistry(tmpDir, 'multi');
    expect(reg!.versions).toHaveLength(2);
    expect(reg!.name).toBe('multi');
  });
});

// ─── listRegistries ─────────────────────────────────────────────────

describe('listRegistries', () => {
  it('lists all registries on disk', async () => {
    await savePromptVersion(tmpDir, 'alpha', 'a');
    await savePromptVersion(tmpDir, 'beta', 'b');
    const names = await listRegistries(tmpDir);
    expect(names.sort()).toEqual(['alpha', 'beta']);
  });

  it('returns [] when dir is empty/missing', async () => {
    const names = await listRegistries(tmpDir);
    expect(names).toEqual([]);
  });
});

// ─── getActivePrompt ────────────────────────────────────────────────

describe('getActivePrompt', () => {
  it('returns the active version', async () => {
    await savePromptVersion(tmpDir, 'test', 'first');
    await savePromptVersion(tmpDir, 'test', 'second');
    const active = await getActivePrompt(tmpDir, 'test');
    expect(active?.content).toBe('second');
    expect(active?.version).toBe(2);
  });

  it('returns undefined for missing registry', async () => {
    const result = await getActivePrompt(tmpDir, 'nope');
    expect(result).toBeUndefined();
  });
});

// ─── setActiveVersion ───────────────────────────────────────────────

describe('setActiveVersion', () => {
  it('changes active version', async () => {
    await savePromptVersion(tmpDir, 'test', 'v1');
    await savePromptVersion(tmpDir, 'test', 'v2');
    const ok = await setActiveVersion(tmpDir, 'test', 1);
    expect(ok).toBe(true);
    const active = await getActivePrompt(tmpDir, 'test');
    expect(active?.version).toBe(1);
  });

  it('returns false for nonexistent version', async () => {
    await savePromptVersion(tmpDir, 'test', 'v1');
    const ok = await setActiveVersion(tmpDir, 'test', 99);
    expect(ok).toBe(false);
  });

  it('returns false for missing registry', async () => {
    const ok = await setActiveVersion(tmpDir, 'missing', 1);
    expect(ok).toBe(false);
  });
});

// ─── rollback ───────────────────────────────────────────────────────

describe('rollback', () => {
  it('reverts to previous version', async () => {
    await savePromptVersion(tmpDir, 'test', 'v1');
    await savePromptVersion(tmpDir, 'test', 'v2');
    const result = await rollback(tmpDir, 'test');
    expect(result?.version).toBe(1);
    expect(result?.content).toBe('v1');
    const active = await getActivePrompt(tmpDir, 'test');
    expect(active?.version).toBe(1);
  });

  it('returns undefined when only one version exists', async () => {
    await savePromptVersion(tmpDir, 'test', 'only');
    const result = await rollback(tmpDir, 'test');
    expect(result).toBeUndefined();
  });

  it('returns undefined for missing registry', async () => {
    const result = await rollback(tmpDir, 'nope');
    expect(result).toBeUndefined();
  });
});

// ─── diffVersions ───────────────────────────────────────────────────

describe('diffVersions', () => {
  const makeRegistry = (...contents: string[]): PromptRegistry => ({
    name: 'diff-test',
    versions: contents.map((c, i) => ({
      version: i + 1,
      label: `v${i + 1}`,
      content: c,
      createdAt: new Date().toISOString(),
    })),
    activeVersion: contents.length,
  });

  it('computes diff between two versions', () => {
    const reg = makeRegistry('line1\nline2\nline3', 'line1\nchanged\nline3');
    const diff = diffVersions(reg, 1, 2);
    expect(diff).toBeDefined();
    expect(diff!.fromVersion).toBe(1);
    expect(diff!.toVersion).toBe(2);
    expect(diff!.removed).toContain('-line2');
    expect(diff!.added).toContain('+changed');
    expect(diff!.totalChanges).toBe(2);
  });

  it('returns undefined for missing version', () => {
    const reg = makeRegistry('a');
    expect(diffVersions(reg, 1, 99)).toBeUndefined();
    expect(diffVersions(reg, 99, 1)).toBeUndefined();
  });

  it('identical versions yield similarity 1.0 and totalChanges 0', () => {
    const reg = makeRegistry('same\ncontent', 'same\ncontent');
    const diff = diffVersions(reg, 1, 2);
    expect(diff!.totalChanges).toBe(0);
    expect(diff!.similarity).toBe(1.0);
    expect(diff!.added).toHaveLength(0);
    expect(diff!.removed).toHaveLength(0);
  });

  it('completely different versions', () => {
    const reg = makeRegistry('aaa\nbbb', 'ccc\nddd');
    const diff = diffVersions(reg, 1, 2);
    expect(diff!.totalChanges).toBe(4);
    expect(diff!.similarity).toBe(0);
    expect(diff!.added).toHaveLength(2);
    expect(diff!.removed).toHaveLength(2);
  });
});

// ─── getVersion ─────────────────────────────────────────────────────

describe('getVersion', () => {
  it('finds specific version', () => {
    const reg: PromptRegistry = {
      name: 'test',
      versions: [
        { version: 1, label: 'v1', content: 'a', createdAt: '' },
        { version: 2, label: 'v2', content: 'b', createdAt: '' },
      ],
      activeVersion: 2,
    };
    expect(getVersion(reg, 1)?.content).toBe('a');
    expect(getVersion(reg, 2)?.label).toBe('v2');
  });

  it('returns undefined for missing version', () => {
    const reg: PromptRegistry = {
      name: 'test',
      versions: [{ version: 1, label: 'v1', content: 'a', createdAt: '' }],
      activeVersion: 1,
    };
    expect(getVersion(reg, 5)).toBeUndefined();
  });
});

// ─── renderPromptHistory ────────────────────────────────────────────

describe('renderPromptHistory', () => {
  it('includes all version labels and dates', () => {
    const reg: PromptRegistry = {
      name: 'history-test',
      versions: [
        { version: 1, label: 'init', content: 'a', createdAt: '2024-01-01T00:00:00Z', author: 'alice', changelog: 'first' },
        { version: 2, label: 'update', content: 'b', createdAt: '2024-02-01T00:00:00Z', tags: ['prod'] },
      ],
      activeVersion: 2,
    };
    const md = renderPromptHistory(reg);
    expect(md).toContain('# Prompt History: history-test');
    expect(md).toContain('## v1 — init');
    expect(md).toContain('## v2 — update');
    expect(md).toContain('2024-01-01');
    expect(md).toContain('2024-02-01');
    expect(md).toContain('alice');
    expect(md).toContain('first');
    expect(md).toContain('prod');
    expect(md).toContain('**(active)**');
  });

  it('handles single version', () => {
    const reg: PromptRegistry = {
      name: 'solo',
      versions: [{ version: 1, label: 'only', content: 'x', createdAt: '2024-06-01T00:00:00Z' }],
      activeVersion: 1,
    };
    const md = renderPromptHistory(reg);
    expect(md).toContain('## v1 — only');
    expect(md).toContain('**(active)**');
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles empty content', async () => {
    const v = await savePromptVersion(tmpDir, 'empty', '');
    expect(v.content).toBe('');
    const active = await getActivePrompt(tmpDir, 'empty');
    expect(active?.content).toBe('');
  });

  it('sanitizes special characters in name', async () => {
    await savePromptVersion(tmpDir, 'foo bar/baz!@#', 'content');
    const names = await listRegistries(tmpDir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[a-zA-Z0-9\-_]+$/);
    // Can still load via original name
    const reg = await loadRegistry(tmpDir, 'foo bar/baz!@#');
    expect(reg).toBeDefined();
    expect(reg!.versions[0].content).toBe('content');
  });

  it('diffVersions with empty content', () => {
    const reg: PromptRegistry = {
      name: 'e',
      versions: [
        { version: 1, label: 'a', content: '', createdAt: '' },
        { version: 2, label: 'b', content: 'new', createdAt: '' },
      ],
      activeVersion: 2,
    };
    const diff = diffVersions(reg, 1, 2);
    expect(diff).toBeDefined();
    expect(diff!.added.length).toBeGreaterThan(0);
  });
});
