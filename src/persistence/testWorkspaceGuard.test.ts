import * as os from 'os';
import * as path from 'path';
import { assertTestSafeProjectDir, isTestProcess } from './testWorkspaceGuard';

describe('assertTestSafeProjectDir', () => {
  it('recognises the jest process as a test process', () => {
    expect(isTestProcess()).toBe(true);
  });

  it('allows the harness checkout and its .harness dir', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    expect(assertTestSafeProjectDir(repoRoot)).toBe(repoRoot);
    expect(assertTestSafeProjectDir(path.join(repoRoot, '.harness'))).toBe(path.join(repoRoot, '.harness'));
  });

  it('allows directories under the OS temp dir', () => {
    const dir = path.join(os.tmpdir(), 'harness-guard-test');
    expect(assertTestSafeProjectDir(dir)).toBe(dir);
  });

  it('rejects a real user workspace outside the checkout and temp dir', () => {
    const outside = path.join(path.parse(os.homedir()).root, 'definitely-not-a-test-workspace', 'AI');
    expect(() => assertTestSafeProjectDir(outside)).toThrow(/Refusing to use project dir/);
  });

  it('rejects sibling paths that merely share the checkout prefix', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    expect(() => assertTestSafeProjectDir(`${repoRoot}-evil`)).toThrow(/Refusing to use project dir/);
  });

  it('is a no-op outside test processes', () => {
    const savedEnv = process.env.NODE_ENV;
    const savedWorker = process.env.JEST_WORKER_ID;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.JEST_WORKER_ID;
      const outside = path.join(path.parse(os.homedir()).root, 'definitely-not-a-test-workspace');
      expect(assertTestSafeProjectDir(outside)).toBe(outside);
    } finally {
      process.env.NODE_ENV = savedEnv;
      if (savedWorker === undefined) delete process.env.JEST_WORKER_ID;
      else process.env.JEST_WORKER_ID = savedWorker;
    }
  });
});
