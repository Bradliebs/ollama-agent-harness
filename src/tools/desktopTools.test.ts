import * as childProcess from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  exec: jest.fn(),
}));

import { DesktopScreenshotTool } from './desktopTools';
import { getProjectRoot, setProjectRoot } from './pathResolution';

describe('DesktopScreenshotTool project root resolution', () => {
  beforeEach(() => {
    (childProcess.exec as unknown as jest.Mock).mockImplementation((command: string, _options: unknown, cb: (error: Error | null, stdout: string) => void) => {
      const outputPath =
        command.match(/\$bmp\.Save\('([^']+)'\)/)?.[1] ??
        command.match(/-f "([^"]+)"/)?.[1] ??
        command.match(/screencapture (?:-w |-x )"([^"]+)"/)?.[1];
      if (!outputPath) {
        cb(new Error(`could not find output path in ${command}`), '');
        return {};
      }
      fs.mkdir(path.dirname(outputPath), { recursive: true })
        .then(() => fs.writeFile(outputPath, 'fake screenshot', 'utf-8'))
        .then(() => cb(null, ''));
      return {};
    });
  });
  afterEach(() => {
    (childProcess.exec as unknown as jest.Mock).mockReset();
  });

  it('saves screenshots under setProjectRoot when cwd differs', async () => {
    const originalCwd = process.cwd();
    const previousRoot = getProjectRoot();
    const workspace = path.join(originalCwd, '.harness', `test-desktop-root-${Date.now()}`);
    const installDir = path.join(originalCwd, '.harness', `test-desktop-cwd-${Date.now()}`);
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(installDir, { recursive: true });
    setProjectRoot(workspace);
    process.chdir(installDir);
    try {
      const result = await DesktopScreenshotTool.execute({});
      expect(result.success).toBe(true);
      const screenshots = await fs.readdir(path.join(workspace, '.harness', 'desktop'));
      expect(screenshots.some((name) => name.startsWith('screenshot-') && name.endsWith('.png'))).toBe(true);
      await expect(fs.access(path.join(installDir, '.harness', 'desktop'))).rejects.toThrow();
    } finally {
      process.chdir(originalCwd);
      setProjectRoot(previousRoot);
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(installDir, { recursive: true, force: true });
    }
  });
});
