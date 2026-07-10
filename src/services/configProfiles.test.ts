import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BUILTIN_PROFILES,
  applyProfile,
  getProfile,
  listProfiles,
  loadCustomProfiles,
  saveCustomProfiles,
  filterToolsByProfile,
  type ConfigProfile,
} from './configProfiles';
import type { LoopConfig } from '../types/loop';
import type { Tool } from '../types/tool';

// ─── Helpers ──────────────────────────────────────────────────────────

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cfgp-'));
}

function baseConfig(): LoopConfig {
  return {
    model: 'llama3',
    systemPrompt: 'You are a helpful assistant.',
    maxTurns: 8,
  };
}

function makeTool(name: string, isReadOnly = true): Tool {
  return {
    name,
    description: `test ${name}`,
    parameters: { type: 'object', properties: {} },
    isReadOnly,
    execute: async () => ({ success: true, output: '' }),
  };
}

// ─── BUILTIN_PROFILES ─────────────────────────────────────────────────

describe('BUILTIN_PROFILES', () => {
  it('has 6 built-in profiles', () => {
    expect(BUILTIN_PROFILES).toHaveLength(6);
  });

  it('all profiles have name and description', () => {
    for (const p of BUILTIN_PROFILES) {
      expect(typeof p.name).toBe('string');
      expect(p.name.length).toBeGreaterThan(0);
      expect(typeof p.description).toBe('string');
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  it('profile names are unique', () => {
    const names = BUILTIN_PROFILES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('includes expected profiles', () => {
    const names = new Set(BUILTIN_PROFILES.map((p) => p.name));
    expect(names.has('code_patch')).toBe(true);
    expect(names.has('safe_readonly')).toBe(true);
    expect(names.has('local_only')).toBe(true);
    expect(names.has('research')).toBe(true);
    expect(names.has('fast_draft')).toBe(true);
    expect(names.has('full_auto')).toBe(true);
  });
});

// ─── applyProfile ─────────────────────────────────────────────────────

describe('applyProfile', () => {
  it('overrides maxTurns when profile specifies it', () => {
    const profile = BUILTIN_PROFILES.find((p) => p.name === 'code_patch')!;
    const result = applyProfile(baseConfig(), profile);
    expect(result.maxTurns).toBe(profile.maxTurns);
  });

  it('preserves base fields not set by the profile', () => {
    const profile = BUILTIN_PROFILES.find((p) => p.name === 'local_only')!;
    const base = baseConfig();
    const result = applyProfile(base, profile);
    expect(result.model).toBe(base.model);
    expect(result.systemPrompt).toBe(base.systemPrompt);
    expect(result.maxTurns).toBe(base.maxTurns);
  });

  it('does not mutate the input config', () => {
    const base = baseConfig();
    const snapshot = { ...base };
    const profile = BUILTIN_PROFILES.find((p) => p.name === 'full_auto')!;
    applyProfile(base, profile);
    expect(base.maxTurns).toBe(snapshot.maxTurns);
  });

  it('applies readBeforeWrite from code_patch', () => {
    const profile = BUILTIN_PROFILES.find((p) => p.name === 'code_patch')!;
    const result = applyProfile(baseConfig(), profile);
    expect(result.readBeforeWrite?.mode).toBe('enforce');
  });

  it('applies verify from code_patch', () => {
    const profile = BUILTIN_PROFILES.find((p) => p.name === 'code_patch')!;
    const result = applyProfile(baseConfig(), profile);
    expect(result.verify?.enabled).toBe(true);
  });

  it('applies autoContinue from full_auto', () => {
    const profile = BUILTIN_PROFILES.find((p) => p.name === 'full_auto')!;
    const result = applyProfile(baseConfig(), profile);
    expect(result.autoContinue).toBe(true);
    expect(result.autoContinueLimit).toBe(10);
  });

  it('applies outputValidation from code_patch', () => {
    const profile = BUILTIN_PROFILES.find((p) => p.name === 'code_patch')!;
    const result = applyProfile(baseConfig(), profile);
    expect(result.outputValidation?.enabled).toBe(true);
  });

  it('merges costTracking instead of replacing', () => {
    const base = { ...baseConfig(), costTracking: { enabled: true, budgetUsd: 5.0 } };
    const profile: ConfigProfile = {
      name: 'test',
      description: 'test',
      costTracking: { budgetUsd: 1.0 },
    };
    const result = applyProfile(base, profile);
    expect(result.costTracking?.enabled).toBe(true);
    expect(result.costTracking?.budgetUsd).toBe(1.0);
  });
});

// ─── filterToolsByProfile ─────────────────────────────────────────────

describe('filterToolsByProfile', () => {
  const tools = [
    makeTool('file_read'),
    makeTool('file_write', false),
    makeTool('file_edit', false),
    makeTool('bash', false),
    makeTool('web_search'),
    makeTool('grep'),
  ];

  it('returns all tools when no filter is set', () => {
    const profile: ConfigProfile = { name: 'open', description: 'no restrictions' };
    expect(filterToolsByProfile(tools, profile)).toHaveLength(tools.length);
  });

  it('filters to allowedTools only', () => {
    const profile: ConfigProfile = {
      name: 'limited',
      description: 'only read',
      allowedTools: ['file_read', 'grep'],
    };
    const result = filterToolsByProfile(tools, profile);
    expect(result.map((t) => t.name).sort()).toEqual(['file_read', 'grep']);
  });

  it('removes blockedTools', () => {
    const profile = BUILTIN_PROFILES.find((p) => p.name === 'safe_readonly')!;
    const result = filterToolsByProfile(tools, profile);
    expect(result.find((t) => t.name === 'file_write')).toBeUndefined();
    expect(result.find((t) => t.name === 'file_edit')).toBeUndefined();
    expect(result.find((t) => t.name === 'bash')).toBeUndefined();
    expect(result.find((t) => t.name === 'file_read')).toBeDefined();
  });

  it('applies allowedTools then blockedTools', () => {
    const profile: ConfigProfile = {
      name: 'dual',
      description: 'both',
      allowedTools: ['file_read', 'file_write', 'grep'],
      blockedTools: ['file_write'],
    };
    const result = filterToolsByProfile(tools, profile);
    expect(result.map((t) => t.name).sort()).toEqual(['file_read', 'grep']);
  });

  it('does not mutate the input array', () => {
    const clone = [...tools];
    const profile: ConfigProfile = {
      name: 'blocked',
      description: 'test',
      blockedTools: ['bash'],
    };
    filterToolsByProfile(tools, profile);
    expect(tools).toEqual(clone);
  });
});

// ─── getProfile ───────────────────────────────────────────────────────

describe('getProfile', () => {
  it('returns a built-in profile by name', async () => {
    const p = await getProfile('code_patch');
    expect(p).toBeDefined();
    expect(p!.name).toBe('code_patch');
  });

  it('returns undefined for unknown name', async () => {
    const p = await getProfile('nonexistent');
    expect(p).toBeUndefined();
  });

  it('returns a custom profile from disk', async () => {
    const tmpDir = makeDir();
    try {
      const custom: ConfigProfile = {
        name: 'my_custom',
        description: 'Custom test profile',
        maxTurns: 99,
      };
      await saveCustomProfiles(tmpDir, [custom]);
      const p = await getProfile('my_custom', tmpDir);
      expect(p).toBeDefined();
      expect(p!.maxTurns).toBe(99);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('merges custom profile on top of built-in with same name', async () => {
    const tmpDir = makeDir();
    try {
      const custom: ConfigProfile = {
        name: 'code_patch',
        description: 'Custom code_patch with higher turn budget',
        maxTurns: 50,
      };
      await saveCustomProfiles(tmpDir, [custom]);
      const p = await getProfile('code_patch', tmpDir);
      expect(p).toBeDefined();
      expect(p!.maxTurns).toBe(50);
      // readBeforeWrite should come from the built-in base
      expect(p!.readBeforeWrite?.mode).toBe('enforce');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── listProfiles ─────────────────────────────────────────────────────

describe('listProfiles', () => {
  it('lists all built-ins when no projectDir given', async () => {
    const profiles = await listProfiles();
    expect(profiles.length).toBe(BUILTIN_PROFILES.length);
  });

  it('includes custom profiles from disk', async () => {
    const tmpDir = makeDir();
    try {
      const custom: ConfigProfile = {
        name: 'extra',
        description: 'Extra',
        maxTurns: 3,
      };
      await saveCustomProfiles(tmpDir, [custom]);
      const profiles = await listProfiles(tmpDir);
      expect(profiles.length).toBe(BUILTIN_PROFILES.length + 1);
      expect(profiles.find((p) => p.name === 'extra')).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('custom profiles shadow built-ins with the same name', async () => {
    const tmpDir = makeDir();
    try {
      const custom: ConfigProfile = {
        name: 'code_patch',
        description: 'My override',
        maxTurns: 42,
      };
      await saveCustomProfiles(tmpDir, [custom]);
      const profiles = await listProfiles(tmpDir);
      // Should not have two "code_patch" entries
      const matches = profiles.filter((p) => p.name === 'code_patch');
      expect(matches).toHaveLength(1);
      expect(matches[0].maxTurns).toBe(42);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── loadCustomProfiles / saveCustomProfiles ──────────────────────────

describe('loadCustomProfiles / saveCustomProfiles', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('round-trips custom profiles through disk', async () => {
    const profiles: ConfigProfile[] = [
      { name: 'alpha', description: 'Alpha profile', maxTurns: 5 },
      { name: 'beta', description: 'Beta profile', maxTurns: 10 },
    ];
    await saveCustomProfiles(tmpDir, profiles);
    const loaded = await loadCustomProfiles(tmpDir);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].name).toBe('alpha');
    expect(loaded[1].name).toBe('beta');
  });

  it('returns [] when file is absent', async () => {
    const loaded = await loadCustomProfiles(tmpDir);
    expect(loaded).toEqual([]);
  });

  it('returns [] when file is corrupt', async () => {
    const dir = path.join(tmpDir, '.harness');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'profiles.json'), 'not json');
    const loaded = await loadCustomProfiles(tmpDir);
    expect(loaded).toEqual([]);
  });

  it('filters out invalid entries that lack name or description', async () => {
    const dir = path.join(tmpDir, '.harness');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'profiles.json'),
      JSON.stringify([
        { name: 'valid', description: 'ok', maxTurns: 5 },
        { description: 'missing name' },
        { name: 'missing_desc' },
        'not an object',
      ]),
    );
    const loaded = await loadCustomProfiles(tmpDir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('valid');
  });

  it('creates .harness directory when it does not exist', async () => {
    await saveCustomProfiles(tmpDir, [{ name: 'x', description: 'x' }]);
    expect(fs.existsSync(path.join(tmpDir, '.harness', 'profiles.json'))).toBe(true);
  });
});
