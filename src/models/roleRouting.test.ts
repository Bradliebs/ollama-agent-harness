import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadModelsConfig,
  resolveModelByRole,
  LOOP_ROLES,
  type LoopRole,
} from './roleRouting';

function emptyEnv(): NodeJS.ProcessEnv { return {}; }

describe('resolveModelByRole', () => {
  it('returns source=none when nothing matches', () => {
    const r = resolveModelByRole({ role: 'maker', env: emptyEnv(), configLoader: () => undefined });
    expect(r).toEqual({ source: 'none' });
  });

  it('explicit override wins over env and file', () => {
    const env = { HARNESS_MODEL_JUDGE: 'env-model' } as NodeJS.ProcessEnv;
    const r = resolveModelByRole({
      role: 'judge', override: 'caller-model', env,
      configLoader: () => ({ roles: { judge: 'file-model' } }),
    });
    expect(r).toEqual({ model: 'caller-model', source: 'override' });
  });

  it('env wins over file when no override', () => {
    const env = { HARNESS_MODEL_PLANNER: 'env-planner' } as NodeJS.ProcessEnv;
    const r = resolveModelByRole({
      role: 'planner', env,
      configLoader: () => ({ roles: { planner: 'file-planner' } }),
    });
    expect(r).toEqual({ model: 'env-planner', source: 'env' });
  });

  it('file is used when no override and no env', () => {
    const r = resolveModelByRole({
      role: 'readback', env: emptyEnv(),
      configLoader: () => ({ roles: { readback: 'file-rb' } }),
    });
    expect(r).toEqual({ model: 'file-rb', source: 'file' });
  });

  it('judge falls back to maker (env)', () => {
    const env = { HARNESS_MODEL_MAKER: 'env-maker' } as NodeJS.ProcessEnv;
    const r = resolveModelByRole({ role: 'judge', env, configLoader: () => undefined });
    expect(r).toEqual({ model: 'env-maker', source: 'fallback', fellBackFrom: 'judge' });
  });

  it('planner falls back to maker (file)', () => {
    const r = resolveModelByRole({
      role: 'planner', env: emptyEnv(),
      configLoader: () => ({ roles: { maker: 'file-maker' } }),
    });
    expect(r).toEqual({ model: 'file-maker', source: 'fallback', fellBackFrom: 'planner' });
  });

  it('readback falls back to maker', () => {
    const env = { HARNESS_MODEL_MAKER: 'env-maker' } as NodeJS.ProcessEnv;
    const r = resolveModelByRole({ role: 'readback', env, configLoader: () => undefined });
    expect(r.source).toBe('fallback');
    expect(r.model).toBe('env-maker');
  });

  it('maker does NOT fall back (it is the root)', () => {
    const r = resolveModelByRole({ role: 'maker', env: emptyEnv(), configLoader: () => undefined });
    expect(r.source).toBe('none');
  });

  it('empty string env is ignored', () => {
    const env = { HARNESS_MODEL_JUDGE: '' } as NodeJS.ProcessEnv;
    const r = resolveModelByRole({ role: 'judge', env, configLoader: () => undefined });
    expect(r.source).toBe('none');
  });

  it('LOOP_ROLES contains exactly the supported roles', () => {
    expect([...LOOP_ROLES].sort()).toEqual(['judge', 'maker', 'planner', 'readback']);
  });
});

describe('loadModelsConfig', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roleRouting-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('returns undefined when models.config.json is absent', () => {
    expect(loadModelsConfig(tmp)).toBeUndefined();
  });

  it('parses a valid file with role overrides', () => {
    fs.writeFileSync(path.join(tmp, 'models.config.json'), JSON.stringify({
      roles: { maker: 'm1', judge: 'm2', planner: 'm3', readback: 'm4' },
    }));
    const cfg = loadModelsConfig(tmp);
    expect(cfg?.roles).toEqual({ maker: 'm1', judge: 'm2', planner: 'm3', readback: 'm4' });
  });

  it('skips unknown role keys instead of throwing', () => {
    fs.writeFileSync(path.join(tmp, 'models.config.json'), JSON.stringify({
      roles: { maker: 'm1', bogus: 'whatever' },
    }));
    const cfg = loadModelsConfig(tmp);
    expect(cfg?.roles).toEqual({ maker: 'm1' });
  });

  it('throws on invalid JSON', () => {
    fs.writeFileSync(path.join(tmp, 'models.config.json'), '{not json');
    expect(() => loadModelsConfig(tmp)).toThrow(/not valid JSON/);
  });

  it('throws when roles is not an object', () => {
    fs.writeFileSync(path.join(tmp, 'models.config.json'), JSON.stringify({ roles: ['bad'] }));
    expect(() => loadModelsConfig(tmp)).toThrow(/"roles" must be an object/);
  });

  it('throws when a role value is empty/non-string', () => {
    fs.writeFileSync(path.join(tmp, 'models.config.json'), JSON.stringify({ roles: { maker: '' } }));
    expect(() => loadModelsConfig(tmp)).toThrow(/non-empty string/);
  });

  it('throws when top-level is not an object', () => {
    fs.writeFileSync(path.join(tmp, 'models.config.json'), JSON.stringify(['arr']));
    expect(() => loadModelsConfig(tmp)).toThrow(/must be a JSON object/);
  });

  it('end-to-end: resolveModelByRole reads disk via default loader', () => {
    fs.writeFileSync(path.join(tmp, 'models.config.json'), JSON.stringify({
      roles: { judge: 'disk-judge' },
    }));
    const r = resolveModelByRole({ role: 'judge' as LoopRole, projectDir: tmp, env: emptyEnv() });
    expect(r).toEqual({ model: 'disk-judge', source: 'file' });
  });
});
