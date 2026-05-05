import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createCapabilityGrant, type CapabilityGrant } from '../permissions/capabilities';
import * as desktopCapture from './desktopTools';
import { DesktopInputReplayTool, sanitizeDesktopInputActions } from './desktopInputTools';

describe('DesktopInputReplayTool', () => {
  let projectDir: string;
  let originalCwd: string;
  let screenshotSpy: jest.SpiedFunction<typeof desktopCapture.captureDesktopScreenshot>;

  beforeEach(async () => {
    originalCwd = process.cwd();
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-desktop-input-'));
    process.chdir(projectDir);
    screenshotSpy = jest.spyOn(desktopCapture, 'captureDesktopScreenshot').mockImplementation(async (outputPath) => {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, 'fake screenshot', 'utf-8');
    });
  });

  afterEach(async () => {
    screenshotSpy.mockRestore();
    process.chdir(originalCwd);
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('previews actions unless confirm is true', async () => {
    const result = await DesktopInputReplayTool.execute({ actions: [{ type: 'text', value: 'hello' }] });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Preview only');
    expect(result.output).toContain('1. text "hello"');
    expect(screenshotSpy).not.toHaveBeenCalled();
  });

  it('requires an active desktop-control grant before execution', async () => {
    const result = await DesktopInputReplayTool.execute({ confirm: true, actions: [{ type: 'wait', ms: 1 }] });

    expect(result.success).toBe(false);
    expect(result.output).toContain('Desktop input blocked');
    expect(screenshotSpy).not.toHaveBeenCalled();
  });

  it('captures before and after evidence when executing a granted bounded plan', async () => {
    await writeSettings({
      capabilityGrants: [makeDesktopGrant()],
      killSwitch: { active: false, reason: '' },
    });

    const result = await DesktopInputReplayTool.execute({ confirm: true, actions: [{ type: 'wait', ms: 1 }] });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Evidence before:');
    expect(result.output).toContain('Evidence after:');
    expect(screenshotSpy).toHaveBeenCalledTimes(2);
  });

  it('blocks execution when the kill switch is active', async () => {
    await writeSettings({
      capabilityGrants: [makeDesktopGrant()],
      killSwitch: { active: true, reason: 'stop now' },
    });

    const result = await DesktopInputReplayTool.execute({ confirm: true, actions: [{ type: 'wait', ms: 1 }] });

    expect(result.success).toBe(false);
    expect(result.output).toContain('Kill switch active');
    expect(screenshotSpy).not.toHaveBeenCalled();
  });

  it('sanitizes action count and wait duration', () => {
    const actions = sanitizeDesktopInputActions(Array.from({ length: 20 }, () => ({ type: 'wait', ms: 999999 })));

    expect(actions).toHaveLength(10);
    expect(actions[0]).toEqual({ type: 'wait', ms: 2000 });
  });

  async function writeSettings(settings: Record<string, unknown>): Promise<void> {
    await fs.mkdir(path.join(projectDir, '.harness'), { recursive: true });
    await fs.writeFile(path.join(projectDir, '.harness', 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
  }

  function makeDesktopGrant(): CapabilityGrant {
    const result = createCapabilityGrant({
      id: 'desktop-test-grant',
      capabilityId: 'desktop-control',
      controls: ['explicit-grant', 'time-limit', 'audit-log', 'kill-switch', 'human-confirmation'],
      now: new Date('2026-05-05T00:00:00.000Z'),
      expiresInMinutes: 24 * 60,
    });
    if (!result.grant) throw new Error('failed to create desktop grant');
    return result.grant;
  }
});