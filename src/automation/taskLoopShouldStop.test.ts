/**
 * Coverage for cookbook/task-loop.ts shouldStop().
 *
 * The autonomy loop is a cookbook recipe rather than a src/ module, but the
 * stop-signal contract is load-bearing for unattended runs. This test
 * exercises both supported channels: the .forge-stop sentinel file and the
 * FORGE_STOP environment variable.
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { shouldStop } from '../../cookbook/task-loop';

describe('cookbook/task-loop shouldStop()', () => {
  const originalCwd = process.cwd();
  const originalEnv = process.env.FORGE_STOP;
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'forge-stop-'));
    process.chdir(workDir);
    delete process.env.FORGE_STOP;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(workDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.FORGE_STOP;
    else process.env.FORGE_STOP = originalEnv;
  });

  it('returns false when no stop signal is present', () => {
    expect(shouldStop()).toBe(false);
  });

  it('returns true when the .forge-stop sentinel file exists', () => {
    writeFileSync(join(workDir, '.forge-stop'), 'stop');
    expect(shouldStop()).toBe(true);
    unlinkSync(join(workDir, '.forge-stop'));
    expect(shouldStop()).toBe(false);
  });

  it('returns true when FORGE_STOP="1"', () => {
    process.env.FORGE_STOP = '1';
    expect(shouldStop()).toBe(true);
  });

  it('returns true when FORGE_STOP="true"', () => {
    process.env.FORGE_STOP = 'true';
    expect(shouldStop()).toBe(true);
  });

  it('does not falsely trip on unrelated env values', () => {
    process.env.FORGE_STOP = 'no';
    expect(shouldStop()).toBe(false);
    process.env.FORGE_STOP = '0';
    expect(shouldStop()).toBe(false);
  });

  it('prefers the file signal even when env is unset', () => {
    expect(existsSync(join(workDir, '.forge-stop'))).toBe(false);
    writeFileSync(join(workDir, '.forge-stop'), '');
    expect(shouldStop()).toBe(true);
  });
});
