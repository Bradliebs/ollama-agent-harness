import * as os from 'os';
import * as path from 'path';
import { getWorkspaceDataRoot, setProjectRoot } from './pathResolution';

describe('getWorkspaceDataRoot', () => {
  it('uses HARNESS_PROJECT_DIR before cwd when the server has not set an override, then prefers the override', () => {
    const envDir = path.join(os.tmpdir(), 'harness-ws-env');
    const overrideDir = path.join(os.tmpdir(), 'harness-ws-override');
    expect(getWorkspaceDataRoot()).toBe(process.cwd());
    process.env.HARNESS_PROJECT_DIR = envDir;
    try {
      expect(getWorkspaceDataRoot()).toBe(envDir);
      setProjectRoot(overrideDir);
      expect(getWorkspaceDataRoot()).toBe(path.resolve(overrideDir));
    } finally {
      delete process.env.HARNESS_PROJECT_DIR;
    }
  });
});
