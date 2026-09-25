import * as path from 'path';
import { expandShortPath, isHarnessCheckout, resolveProjectDir } from './projectDir';

const checkout = path.resolve('/work/harness');
const markers = new Set([
  path.join(checkout, 'src', 'web', 'server.ts'),
  path.join(checkout, 'src', 'tools', 'dispatcher.ts'),
]);
const exists = (p: string): boolean => markers.has(p);

describe('resolveProjectDir', () => {
  it('prefers HARNESS_PROJECT_DIR', () => {
    expect(resolveProjectDir({ env: { HARNESS_PROJECT_DIR: '/data/ai' }, cwd: checkout, exists })).toBe(path.resolve('/data/ai'));
  });

  it('uses cwd outside the harness checkout', () => {
    expect(resolveProjectDir({ env: {}, cwd: path.resolve('/work/app'), exists })).toBe(path.resolve('/work/app'));
  });

  it('keeps cwd for tests run inside the checkout', () => {
    expect(resolveProjectDir({ env: { NODE_ENV: 'test' }, cwd: checkout, exists })).toBe(checkout);
  });

  it('redirects a checkout launch to ~/apex-workspace and creates it', () => {
    const made: string[] = [];
    const logs: string[] = [];
    const dir = resolveProjectDir({ env: {}, cwd: checkout, homedir: path.resolve('/home/u'), exists, mkdir: (p) => made.push(p), log: (m) => logs.push(m) });
    expect(dir).toBe(path.join(path.resolve('/home/u'), 'apex-workspace'));
    expect(made).toEqual([dir]);
    expect(logs[0]).toContain('redirecting');
  });

  it('detects the checkout only when both marker files exist', () => {
    expect(isHarnessCheckout(checkout, exists)).toBe(true);
    expect(isHarnessCheckout(checkout, (p) => p.endsWith('server.ts'))).toBe(false);
  });
});

describe('expandShortPath', () => {
  const longForm = (p: string): string => p.replace('RUNNER~1', 'runneradmin');

  it('expands Windows 8.3 short segments so fs.watch does not abort', () => {
    expect(expandShortPath('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\ws', 'win32', longForm)).toBe('C:\\Users\\runneradmin\\AppData\\Local\\Temp\\ws');
  });

  it('leaves long paths, other platforms and unresolvable paths alone', () => {
    const fail = (): string => { throw new Error('ENOENT'); };
    expect(expandShortPath('D:\\Brad\\Downloads\\AI', 'win32', fail)).toBe('D:\\Brad\\Downloads\\AI');
    expect(expandShortPath('/home/u/RUNNER~1', 'linux', longForm)).toBe('/home/u/RUNNER~1');
    expect(expandShortPath('C:\\Users\\RUNNER~1\\missing', 'win32', fail)).toBe('C:\\Users\\RUNNER~1\\missing');
  });

  it('is applied to HARNESS_PROJECT_DIR', () => {
    const dir = resolveProjectDir({ env: { HARNESS_PROJECT_DIR: 'C:\\Users\\RUNNER~1\\ws' }, platform: 'win32', realpath: longForm });
    expect(dir).toBe(longForm(path.resolve('C:\\Users\\RUNNER~1\\ws')));
  });
});
