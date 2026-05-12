import * as os from 'os';
import * as path from 'path';
import { getUploadsDir } from './pathResolution';

describe('getUploadsDir', () => {
  let originalUploadsDir: string | undefined;
  let originalGlobalUploads: string | undefined;

  beforeEach(() => {
    originalUploadsDir = process.env.HARNESS_UPLOADS_DIR;
    originalGlobalUploads = process.env.HARNESS_GLOBAL_UPLOADS;
    delete process.env.HARNESS_UPLOADS_DIR;
    delete process.env.HARNESS_GLOBAL_UPLOADS;
  });

  afterEach(() => {
    if (originalUploadsDir === undefined) delete process.env.HARNESS_UPLOADS_DIR;
    else process.env.HARNESS_UPLOADS_DIR = originalUploadsDir;
    if (originalGlobalUploads === undefined) delete process.env.HARNESS_GLOBAL_UPLOADS;
    else process.env.HARNESS_GLOBAL_UPLOADS = originalGlobalUploads;
  });

  it('falls back to <cwd>/.harness/uploads when no env is set', () => {
    expect(getUploadsDir()).toBe(path.join(process.cwd(), '.harness', 'uploads'));
  });

  it('resolves HARNESS_GLOBAL_UPLOADS=1 to ~/.harness/uploads', () => {
    process.env.HARNESS_GLOBAL_UPLOADS = '1';
    expect(getUploadsDir()).toBe(path.join(os.homedir(), '.harness', 'uploads'));
  });

  it('ignores HARNESS_GLOBAL_UPLOADS values other than 1', () => {
    process.env.HARNESS_GLOBAL_UPLOADS = 'true';
    expect(getUploadsDir()).toBe(path.join(process.cwd(), '.harness', 'uploads'));
  });

  it('HARNESS_UPLOADS_DIR (absolute) overrides HARNESS_GLOBAL_UPLOADS', () => {
    process.env.HARNESS_GLOBAL_UPLOADS = '1';
    const explicit = path.join(os.tmpdir(), 'explicit-uploads');
    process.env.HARNESS_UPLOADS_DIR = explicit;
    expect(getUploadsDir()).toBe(explicit);
  });

  it('HARNESS_UPLOADS_DIR (relative) is resolved against cwd', () => {
    process.env.HARNESS_UPLOADS_DIR = 'custom-uploads';
    expect(getUploadsDir()).toBe(path.resolve(process.cwd(), 'custom-uploads'));
  });
});
