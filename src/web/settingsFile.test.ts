import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { isTransientSettingsRenameError, renameSettingsFileWithRetry, writeSettingsFile } from './settingsFile';

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

describe('settingsFile', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-settings-file-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('merges over fields already on disk and leaves no temp file', async () => {
    const file = path.join(dir, '.harness', 'settings.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ unmanaged: 'keep', model: 'old' }));

    await expect(writeSettingsFile(file, { model: 'new' })).resolves.toBe(true);

    expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual({ unmanaged: 'keep', model: 'new' });
    await expect(fs.access(`${file}.tmp`)).rejects.toThrow();
  });

  it('creates the directory and file when missing', async () => {
    const file = path.join(dir, 'nested', 'settings.json');
    await writeSettingsFile(file, { a: 1 });
    expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual({ a: 1 });
  });

  it('treats only Windows sharing errors as transient', () => {
    expect(isTransientSettingsRenameError(errno('EBUSY'), 'win32')).toBe(true);
    expect(isTransientSettingsRenameError(errno('EPERM'), 'win32')).toBe(true);
    expect(isTransientSettingsRenameError(errno('ENOENT'), 'win32')).toBe(false);
    expect(isTransientSettingsRenameError(errno('EBUSY'), 'linux')).toBe(false);
  });

  it('retries transient rename failures and then succeeds', async () => {
    const rename = jest.fn()
      .mockRejectedValueOnce(errno('EBUSY'))
      .mockRejectedValueOnce(errno('EPERM'))
      .mockResolvedValueOnce(undefined);
    await renameSettingsFileWithRetry('a', 'b', { rename, platform: 'win32', retryDelaysMs: [0, 0, 0] });
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it('gives up after the last retry and on non-transient errors', async () => {
    const always = jest.fn().mockRejectedValue(errno('EBUSY'));
    await expect(renameSettingsFileWithRetry('a', 'b', { rename: always, platform: 'win32', retryDelaysMs: [0, 0] })).rejects.toThrow('EBUSY');
    expect(always).toHaveBeenCalledTimes(3);
    const fatal = jest.fn().mockRejectedValue(errno('ENOENT'));
    await expect(renameSettingsFileWithRetry('a', 'b', { rename: fatal, platform: 'win32', retryDelaysMs: [0, 0] })).rejects.toThrow('ENOENT');
    expect(fatal).toHaveBeenCalledTimes(1);
  });
});
