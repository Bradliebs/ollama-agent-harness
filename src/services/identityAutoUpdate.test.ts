import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { readIdentityFile, writeIdentityFile } from './identity';
import {
  readIdentityAutoUpdateConfig,
  runIdentityAutoUpdateTick,
  writeIdentityAutoUpdateConfig,
} from './identityAutoUpdate';

describe('identity auto-update — config', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-autoupdate-cfg-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('returns defaults (both off) when no config file exists', async () => {
    const cfg = await readIdentityAutoUpdateConfig(projectDir);
    expect(cfg).toEqual({ version: 1, user: false, soul: false });
  });

  it('returns defaults when the config file is malformed', async () => {
    const fp = path.join(projectDir, '.harness', 'identity', 'auto-update.json');
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, '{not valid json', 'utf-8');
    const cfg = await readIdentityAutoUpdateConfig(projectDir);
    expect(cfg).toEqual({ version: 1, user: false, soul: false });
  });

  it('returns defaults when the version is unknown', async () => {
    const fp = path.join(projectDir, '.harness', 'identity', 'auto-update.json');
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, JSON.stringify({ version: 99, user: true, soul: true }), 'utf-8');
    const cfg = await readIdentityAutoUpdateConfig(projectDir);
    expect(cfg).toEqual({ version: 1, user: false, soul: false });
  });

  it('round-trips a written config', async () => {
    await writeIdentityAutoUpdateConfig(projectDir, { version: 1, user: true, soul: false });
    const cfg = await readIdentityAutoUpdateConfig(projectDir);
    expect(cfg).toEqual({ version: 1, user: true, soul: false });
  });
});

describe('identity auto-update — tick', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-autoupdate-tick-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('skips both targets when config is the default (off)', async () => {
    const callModel = jest.fn(async () => 'unused');
    const getObservations = jest.fn(async () => 'unused');
    const result = await runIdentityAutoUpdateTick(projectDir, { callModel, getObservations });
    expect(result.user.status).toBe('disabled');
    expect(result.soul.status).toBe('disabled');
    expect(callModel).not.toHaveBeenCalled();
    expect(getObservations).not.toHaveBeenCalled();
  });

  it('reports no-change when USER is enabled and the model says NO_CHANGE', async () => {
    await writeIdentityAutoUpdateConfig(projectDir, { version: 1, user: true, soul: false });
    await writeIdentityFile(projectDir, 'USER.md', '# Current');
    const callModel = jest.fn(async () => 'NO_CHANGE');
    const getObservations = jest.fn(async () => 'recent observations');
    const result = await runIdentityAutoUpdateTick(projectDir, { callModel, getObservations });
    expect(result.user.status).toBe('no-change');
    expect(result.soul.status).toBe('disabled');
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it('auto-applies USER proposals with a snapshot when USER is enabled', async () => {
    await writeIdentityAutoUpdateConfig(projectDir, { version: 1, user: true, soul: false });
    await writeIdentityFile(projectDir, 'USER.md', '# Old');
    const callModel = jest.fn(async () => '```identity\n# New\n```');
    const getObservations = jest.fn(async () => 'obs');
    const result = await runIdentityAutoUpdateTick(projectDir, { callModel, getObservations });
    expect(result.user.status).toBe('applied');
    expect(result.user.snapshotId).toBeDefined();
    expect(result.user.proposal!.after).toBe('# New');
    expect(await readIdentityFile(projectDir, 'USER.md')).toBe('# New');
  });

  it('writes a SOUL proposal when SOUL is enabled, leaving SOUL.md unchanged', async () => {
    await writeIdentityAutoUpdateConfig(projectDir, { version: 1, user: false, soul: true });
    await writeIdentityFile(projectDir, 'SOUL.md', '# Soul');
    const callModel = jest.fn(async () => '```identity\n# New soul\n```');
    const getObservations = jest.fn(async () => 'obs');
    const result = await runIdentityAutoUpdateTick(projectDir, { callModel, getObservations });
    expect(result.soul.status).toBe('proposed');
    expect(result.soul.proposal!.after).toBe('# New soul');
    expect(await readIdentityFile(projectDir, 'SOUL.md')).toBe('# Soul');
    const proposalPath = path.join(projectDir, '.harness', 'identity', 'SOUL.proposed.md');
    await expect(fs.access(proposalPath)).resolves.toBeUndefined();
  });

  it('runs both targets when both are enabled', async () => {
    await writeIdentityAutoUpdateConfig(projectDir, { version: 1, user: true, soul: true });
    await writeIdentityFile(projectDir, 'USER.md', '# U');
    await writeIdentityFile(projectDir, 'SOUL.md', '# S');
    const callModel = jest.fn(async (prompt: string) => {
      if (prompt.includes('USER.md')) return '```identity\n# U-new\n```';
      if (prompt.includes('SOUL.md')) return '```identity\n# S-new\n```';
      return 'NO_CHANGE';
    });
    const getObservations = jest.fn(async () => 'obs');
    const result = await runIdentityAutoUpdateTick(projectDir, { callModel, getObservations });
    expect(result.user.status).toBe('applied');
    expect(result.soul.status).toBe('proposed');
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(getObservations).toHaveBeenCalledTimes(1);
  });

  it('marks both as error when getObservations throws', async () => {
    await writeIdentityAutoUpdateConfig(projectDir, { version: 1, user: true, soul: true });
    const callModel = jest.fn(async () => 'unused');
    const getObservations = jest.fn(async () => {
      throw new Error('no log available');
    });
    const result = await runIdentityAutoUpdateTick(projectDir, { callModel, getObservations });
    expect(result.user.status).toBe('error');
    expect(result.user.error).toMatch(/no log available/);
    expect(result.soul.status).toBe('error');
    expect(result.soul.error).toMatch(/no log available/);
    expect(callModel).not.toHaveBeenCalled();
  });

  it('isolates per-target failures: USER error does not stop SOUL', async () => {
    await writeIdentityAutoUpdateConfig(projectDir, { version: 1, user: true, soul: true });
    await writeIdentityFile(projectDir, 'SOUL.md', '# S');
    const callModel = jest.fn(async (prompt: string) => {
      if (prompt.includes('USER.md')) throw new Error('user model exploded');
      return '```identity\n# S-new\n```';
    });
    const getObservations = jest.fn(async () => 'obs');
    const result = await runIdentityAutoUpdateTick(projectDir, { callModel, getObservations });
    expect(result.user.status).toBe('error');
    expect(result.user.error).toMatch(/user model exploded/);
    expect(result.soul.status).toBe('proposed');
  });
});
