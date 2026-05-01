import * as fs from 'fs/promises';
import * as path from 'path';
import { FileReadTool, FileWriteTool, ListUploadsTool } from './fileTools';
import { drainUploadsFallbacks } from './pathResolution';

describe('file tools bounds and path safety', () => {
  const fixtureDir = path.join(process.cwd(), '.harness', 'test-fixtures', 'file-tools');
  const fixtureFile = path.join(fixtureDir, 'sample.txt');

  beforeEach(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
    await fs.mkdir(fixtureDir, { recursive: true });
    await fs.writeFile(fixtureFile, 'alpha\nbeta\ngamma\ndelta', 'utf-8');
  });

  afterAll(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it('rejects reads outside the project directory', async () => {
    const result = await FileReadTool.execute({ path: path.resolve(process.cwd(), '..', 'outside.txt') });

    expect(result).toMatchObject({ success: false, error: 'path outside project' });
  });

  it('returns requested one-based line ranges', async () => {
    const result = await FileReadTool.execute({ path: fixtureFile, start_line: 2, end_line: 3 });

    expect(result).toMatchObject({ success: true, output: 'beta\ngamma' });
  });

  it('truncates reads by max bytes', async () => {
    const result = await FileReadTool.execute({ path: fixtureFile, max_bytes: 5 });

    expect(result.success).toBe(true);
    expect(result.output).toContain('alpha');
    expect(result.output).toContain('truncated');
  });

  it('rejects oversized writes', async () => {
    const result = await FileWriteTool.execute({ path: path.join(fixtureDir, 'large.txt'), content: 'x'.repeat(5_000_001) });

    expect(result).toMatchObject({ success: false, error: 'write too large' });
  });

  describe('uploads fallback', () => {
    const uploadsDir = path.join(process.cwd(), '.harness', 'uploads');
    const uploadName = 'test-uploads-fallback.csv';
    const uploadPath = path.join(uploadsDir, uploadName);

    beforeEach(async () => {
      await fs.mkdir(uploadsDir, { recursive: true });
      await fs.writeFile(uploadPath, 'one,two\n1,2\n', 'utf-8');
    });

    afterEach(async () => {
      await fs.rm(uploadPath, { force: true });
    });

    it('falls back to .harness/uploads when given a bare filename', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await FileReadTool.execute({ path: uploadName });

        expect(result.success).toBe(true);
        expect(result.output).toContain('one,two');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('does not fall back when the basename is supplied with a different directory', async () => {
      const result = await FileReadTool.execute({ path: path.join('does-not-exist', uploadName) });

      expect(result.success).toBe(false);
    });

    it('emits a warn log when the uploads fallback is used', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await FileReadTool.execute({ path: uploadName });
        expect(result.success).toBe(true);
        expect(warnSpy).toHaveBeenCalled();
        const lines = warnSpy.mock.calls.map((call) => String(call[0]));
        expect(lines.some((line) => line.includes('PathResolution') && line.includes(uploadName))).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('records a drainable uploads-fallback entry per fallback hit', async () => {
      drainUploadsFallbacks();
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await FileReadTool.execute({ path: uploadName });
        const records = drainUploadsFallbacks();
        expect(records.length).toBe(1);
        expect(records[0]).toMatchObject({ requested: uploadName });
        expect(records[0].resolved).toContain(uploadName);
        // Buffer is cleared after draining.
        expect(drainUploadsFallbacks()).toEqual([]);
      } finally {
        (console.warn as jest.Mock).mockRestore();
      }
    });
  });

  describe('list_uploads tool', () => {
    const uploadsDir = path.join(process.cwd(), '.harness', 'uploads');
    const uploadName = 'list-uploads-fixture.txt';
    const uploadPath = path.join(uploadsDir, uploadName);

    beforeEach(async () => {
      await fs.mkdir(uploadsDir, { recursive: true });
      await fs.writeFile(uploadPath, 'hello', 'utf-8');
    });

    afterEach(async () => {
      await fs.rm(uploadPath, { force: true });
    });

    it('lists files in .harness/uploads with size and path', async () => {
      const result = await ListUploadsTool.execute({});

      expect(result.success).toBe(true);
      expect(result.output).toContain(uploadName);
      expect(result.output).toContain('5 bytes');
      expect(result.output).toContain('.harness/uploads/' + uploadName);
    });
  });

  describe('HARNESS_UPLOADS_DIR override', () => {
    const overrideDir = path.join(process.cwd(), '.harness', 'test-uploads-override');
    const overrideUploadName = 'override-upload.csv';
    const overridePath = path.join(overrideDir, overrideUploadName);

    beforeEach(async () => {
      await fs.mkdir(overrideDir, { recursive: true });
      await fs.writeFile(overridePath, 'a,b\n1,2\n', 'utf-8');
      process.env.HARNESS_UPLOADS_DIR = overrideDir;
    });

    afterEach(async () => {
      delete process.env.HARNESS_UPLOADS_DIR;
      await fs.rm(overrideDir, { recursive: true, force: true });
    });

    it('list_uploads reads from the override directory', async () => {
      const result = await ListUploadsTool.execute({});

      expect(result.success).toBe(true);
      expect(result.output).toContain(overrideUploadName);
    });

    it('file_read falls back through the override directory when given a bare filename', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await FileReadTool.execute({ path: overrideUploadName });
        expect(result.success).toBe(true);
        expect(result.output).toContain('a,b');
      } finally {
        (console.warn as jest.Mock).mockRestore();
      }
    });
  });
});