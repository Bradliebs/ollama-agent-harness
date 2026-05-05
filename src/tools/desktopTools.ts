import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';

// ─── Desktop screenshot tool ────────────────────────────────────────
//
// Captures a screenshot of the current desktop using platform-native
// commands. The result is saved under .harness/desktop/ and the path
// is returned so image_analyze can inspect it.
//
// Capability: desktop-control (gated)
// Risk: medium — read-only screen capture, no input replay

const SCREENSHOT_DIR = '.harness/desktop';
const MAX_SCREENSHOT_AGE_MS = 30 * 60_000;

export const DesktopScreenshotTool: Tool = {
  name: 'desktop_screenshot',
  description: 'Capture a screenshot of the current desktop. Returns the file path so image_analyze can inspect it. Requires a desktop-control capability grant.',
  parameters: {
    type: 'object',
    properties: {
      region: { type: 'string', description: 'Optional: "full" (default) or "active" for the active window only' },
    },
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const region = String(input.region ?? 'full').trim().toLowerCase();
    const projectDir = process.cwd();
    const screenshotDir = path.join(projectDir, SCREENSHOT_DIR);
    await fs.mkdir(screenshotDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `screenshot-${timestamp}.png`;
    const outputPath = path.join(screenshotDir, filename);

    try {
      await captureDesktopScreenshot(outputPath, region === 'active');

      // Verify the file was created
      const stat = await fs.stat(outputPath);
      if (stat.size === 0) {
        return { success: false, output: 'Screenshot was captured but the file is empty.', error: 'empty screenshot' };
      }

      // Clean old screenshots
      await cleanOldScreenshots(screenshotDir);

      const relativePath = path.relative(projectDir, outputPath);
      return {
        success: true,
        output: `Screenshot saved to ${relativePath} (${Math.round(stat.size / 1024)}KB). Use image_analyze to inspect it.`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Screenshot capture failed: ${msg}`, error: msg };
    }
  },
};

export async function captureDesktopScreenshot(outputPath: string, activeWindowOnly: boolean): Promise<void> {
  const platform = os.platform();

  if (platform === 'win32') {
    // Use PowerShell Add-Type to capture screen
    const script = activeWindowOnly
      ? `Add-Type -AssemblyName System.Windows.Forms; $screen = [System.Windows.Forms.Screen]::PrimaryScreen; $bmp = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($screen.Bounds.Location, [System.Drawing.Point]::Empty, $screen.Bounds.Size); $bmp.Save('${outputPath.replace(/'/g, "''")}'); $g.Dispose(); $bmp.Dispose()`
      : `Add-Type -AssemblyName System.Windows.Forms; $screen = [System.Windows.Forms.Screen]::PrimaryScreen; $bmp = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($screen.Bounds.Location, [System.Drawing.Point]::Empty, $screen.Bounds.Size); $bmp.Save('${outputPath.replace(/'/g, "''")}'); $g.Dispose(); $bmp.Dispose()`;
    await execPromise(`powershell -NoProfile -Command "${script}"`, 15_000);
  } else if (platform === 'darwin') {
    const cmd = activeWindowOnly
      ? `screencapture -w "${outputPath}"`
      : `screencapture -x "${outputPath}"`;
    await execPromise(cmd, 15_000);
  } else {
    // Linux: try gnome-screenshot or import (ImageMagick)
    try {
      await execPromise(`gnome-screenshot -f "${outputPath}"`, 15_000);
    } catch {
      await execPromise(`import -window root "${outputPath}"`, 15_000);
    }
  }
}

export function execPromise(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: timeoutMs }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function cleanOldScreenshots(dir: string): Promise<void> {
  try {
    const files = await fs.readdir(dir);
    const now = Date.now();
    for (const file of files) {
      if (!file.startsWith('screenshot-') || !file.endsWith('.png')) continue;
      const filePath = path.join(dir, file);
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs > MAX_SCREENSHOT_AGE_MS) {
        await fs.unlink(filePath).catch(() => {});
      }
    }
  } catch { /* cleanup is best-effort */ }
}
