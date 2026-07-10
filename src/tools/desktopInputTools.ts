import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { evaluateCapabilityGrant, sanitizeCapabilityGrants, type CapabilityGrant } from '../permissions/capabilities';
import * as desktopCapture from './desktopTools';

type MouseButton = 'left' | 'right' | 'middle';

type DesktopInputAction =
  | { type: 'text'; value: string }
  | { type: 'key'; value: string }
  | { type: 'wait'; ms: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'click'; x: number | null; y: number | null; button: MouseButton; count: number }
  | { type: 'drag'; x1: number; y1: number; x2: number; y2: number; button: MouseButton }
  | { type: 'scroll'; x: number | null; y: number | null; amount: number };

type DesktopMouseAction = Extract<DesktopInputAction, { type: 'move' | 'click' | 'drag' | 'scroll' }>;

interface DesktopInputPolicyState {
  killSwitch: { active: boolean; reason: string };
  capabilityGrants: CapabilityGrant[];
}

const MAX_ACTIONS = 10;
const MAX_TEXT_LENGTH = 500;
const MAX_KEY_LENGTH = 80;
const MAX_WAIT_MS = 2_000;
const MAX_COORDINATE = 20_000;
const MAX_SCROLL_AMOUNT = 20;
const MAX_AUDIT_ENTRIES = 50;
const MAX_SCREENSHOT_FILES = 50;
const SETTINGS_PATH = path.join('.harness', 'settings.json');
const DESKTOP_DIR = path.join('.harness', 'desktop');
const AUDIT_FILE = 'desktop-input-audit.jsonl';
const SCREENSHOT_PATTERN = /^desktop-input-(before|after)-[A-Za-z0-9_.-]+\.png$/;

export const DesktopInputReplayTool: Tool = {
  name: 'desktop_input_replay',
  description: 'Preview or execute a bounded desktop input replay plan. Execution requires confirm=true, an active desktop-control grant, kill-switch checks before every input, and before/after screenshot evidence.',
  parameters: {
    type: 'object',
    properties: {
      confirm: { type: 'boolean', description: 'Must be true to execute. Omit or false to preview only.' },
      actions: {
        type: 'array',
        maxItems: MAX_ACTIONS,
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['text', 'key', 'wait', 'move', 'click', 'drag', 'scroll'] },
            value: { type: 'string', description: 'Text to type (text) or key chord such as {ENTER} (key).' },
            ms: { type: 'number', description: 'Wait duration in milliseconds (wait).' },
            x: { type: 'number', description: 'Target x coordinate (move/click/drag start/scroll).' },
            y: { type: 'number', description: 'Target y coordinate (move/click/drag start/scroll).' },
            x2: { type: 'number', description: 'Drag end x coordinate (drag).' },
            y2: { type: 'number', description: 'Drag end y coordinate (drag).' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (click/drag). Defaults to left.' },
            count: { type: 'number', description: 'Click count 1-3 for single/double/triple (click). Defaults to 1.' },
            amount: { type: 'number', description: 'Scroll amount; positive scrolls up, negative scrolls down (scroll).' },
          },
          required: ['type'],
        },
      },
    },
    required: ['actions'],
  },
  isReadOnly: false,
  riskLevel: 'high',
  permissionCategory: 'desktop',
  canDryRun: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const projectDir = process.cwd();
    const actions = sanitizeDesktopInputActions(input.actions);
    if (actions.length === 0) return { success: false, output: 'No valid desktop input actions were provided.', error: 'no valid actions' };
    const preview = renderDesktopInputPreview(actions);
    if (input.confirm !== true) {
      return { success: true, output: `Preview only. Set confirm=true with an active desktop-control grant to execute.\n${preview}` };
    }

    const policy = await readDesktopInputPolicyState(projectDir);
    const evaluation = evaluateCapabilityGrant('desktop-control', policy.capabilityGrants, { killSwitchActive: policy.killSwitch.active });
    if (evaluation.decision !== 'allow') {
      await appendDesktopInputAudit(projectDir, { outcome: 'blocked', reason: evaluation.reason, actionCount: actions.length });
      return { success: false, output: `Desktop input blocked: ${evaluation.reason}`, error: evaluation.reason };
    }

    const evidenceDir = path.join(projectDir, DESKTOP_DIR);
    await fs.mkdir(evidenceDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const beforePath = path.join(evidenceDir, `desktop-input-before-${timestamp}.png`);
    const afterPath = path.join(evidenceDir, `desktop-input-after-${timestamp}.png`);

    try {
      await desktopCapture.captureDesktopScreenshot(beforePath, false);
      for (let i = 0; i < actions.length; i++) {
        const currentPolicy = await readDesktopInputPolicyState(projectDir);
        if (currentPolicy.killSwitch.active) {
          await appendDesktopInputAudit(projectDir, { outcome: 'stopped', reason: currentPolicy.killSwitch.reason || 'kill switch active', actionCount: actions.length, stoppedBeforeAction: i + 1 });
          return { success: false, output: `Desktop input stopped before action ${i + 1}: kill switch active (${currentPolicy.killSwitch.reason || 'no reason'}).`, error: 'kill switch active' };
        }
        await executeDesktopInputAction(actions[i]);
      }
      await desktopCapture.captureDesktopScreenshot(afterPath, false);
      await appendDesktopInputAudit(projectDir, { outcome: 'executed', actionCount: actions.length, before: path.relative(projectDir, beforePath), after: path.relative(projectDir, afterPath) });
      return {
        success: true,
        output: `Executed ${actions.length} desktop input action(s).\n${preview}\nEvidence before: ${path.relative(projectDir, beforePath)}\nEvidence after: ${path.relative(projectDir, afterPath)}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendDesktopInputAudit(projectDir, { outcome: 'failed', reason: message, actionCount: actions.length });
      return { success: false, output: `Desktop input replay failed: ${message}`, error: message };
    }
  },
};

export function sanitizeDesktopInputActions(value: unknown): DesktopInputAction[] {
  if (!Array.isArray(value)) return [];
  const actions: DesktopInputAction[] = [];
  for (const item of value.slice(0, MAX_ACTIONS)) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const type = String(raw.type ?? '').trim().toLowerCase();
    if (type === 'text') {
      const text = String(raw.value ?? '').slice(0, MAX_TEXT_LENGTH);
      if (text) actions.push({ type, value: text });
    } else if (type === 'key') {
      const key = String(raw.value ?? '').trim().slice(0, MAX_KEY_LENGTH);
      if (key) actions.push({ type, value: key });
    } else if (type === 'wait') {
      const ms = Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(Number(raw.ms ?? 0))));
      actions.push({ type, ms });
    } else if (type === 'move') {
      const x = clampCoordinate(raw.x);
      const y = clampCoordinate(raw.y);
      if (x !== null && y !== null) actions.push({ type, x, y });
    } else if (type === 'click') {
      const x = clampCoordinate(raw.x);
      const y = clampCoordinate(raw.y);
      const hasPoint = x !== null && y !== null;
      const count = Math.max(1, Math.min(3, Math.floor(Number(raw.count ?? 1)) || 1));
      actions.push({ type, x: hasPoint ? x : null, y: hasPoint ? y : null, button: parseMouseButton(raw.button), count });
    } else if (type === 'drag') {
      const x1 = clampCoordinate(raw.x);
      const y1 = clampCoordinate(raw.y);
      const x2 = clampCoordinate(raw.x2);
      const y2 = clampCoordinate(raw.y2);
      if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
        actions.push({ type, x1, y1, x2, y2, button: parseMouseButton(raw.button) });
      }
    } else if (type === 'scroll') {
      const amount = Math.max(-MAX_SCROLL_AMOUNT, Math.min(MAX_SCROLL_AMOUNT, Math.floor(Number(raw.amount ?? 0)) || 0));
      if (amount !== 0) {
        const x = clampCoordinate(raw.x);
        const y = clampCoordinate(raw.y);
        const hasPoint = x !== null && y !== null;
        actions.push({ type, x: hasPoint ? x : null, y: hasPoint ? y : null, amount });
      }
    }
  }
  return actions;
}

function clampCoordinate(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(MAX_COORDINATE, Math.floor(n)));
}

function parseMouseButton(value: unknown): MouseButton {
  const button = String(value ?? '').trim().toLowerCase();
  return button === 'right' || button === 'middle' ? button : 'left';
}

async function readDesktopInputPolicyState(projectDir: string): Promise<DesktopInputPolicyState> {
  try {
    const raw = await fs.readFile(path.join(projectDir, SETTINGS_PATH), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const killSwitch = parsed.killSwitch && typeof parsed.killSwitch === 'object' ? parsed.killSwitch as Record<string, unknown> : {};
    return {
      killSwitch: {
        active: Boolean(killSwitch.active),
        reason: typeof killSwitch.reason === 'string' ? killSwitch.reason.slice(0, 500) : '',
      },
      capabilityGrants: sanitizeCapabilityGrants(parsed.capabilityGrants),
    };
  } catch {
    return { killSwitch: { active: false, reason: '' }, capabilityGrants: [] };
  }
}

function renderDesktopInputPreview(actions: DesktopInputAction[]): string {
  return actions.map((action, index) => {
    const n = index + 1;
    switch (action.type) {
      case 'wait': return `${n}. wait ${action.ms}ms`;
      case 'text':
      case 'key': return `${n}. ${action.type} ${JSON.stringify(action.value)}`;
      case 'move': return `${n}. move to (${action.x}, ${action.y})`;
      case 'click': return `${n}. ${action.count > 1 ? `${action.count}x ` : ''}${action.button} click${action.x !== null ? ` at (${action.x}, ${action.y})` : ''}`;
      case 'drag': return `${n}. ${action.button} drag (${action.x1}, ${action.y1}) -> (${action.x2}, ${action.y2})`;
      case 'scroll': return `${n}. scroll ${action.amount > 0 ? 'up' : 'down'} ${Math.abs(action.amount)}${action.x !== null ? ` at (${action.x}, ${action.y})` : ''}`;
    }
  }).join('\n');
}

async function executeDesktopInputAction(action: DesktopInputAction): Promise<void> {
  if (action.type === 'wait') {
    await new Promise((resolve) => setTimeout(resolve, action.ms));
    return;
  }
  const platform = os.platform();
  if (action.type === 'text' || action.type === 'key') {
    const value = action.value;
    if (platform === 'win32') {
      const psLiteral = `'${value.replace(/'/g, "''")}'`;
      const encoded = Buffer.from(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psLiteral})`, 'utf16le').toString('base64');
      await desktopCapture.execPromise(`powershell -NoProfile -EncodedCommand ${encoded}`, 10_000);
    } else if (platform === 'darwin') {
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await desktopCapture.execPromise(`osascript -e "tell application \"System Events\" to keystroke \"${escaped}\""`, 10_000);
    } else {
      await desktopCapture.execPromise(`xdotool type --delay 0 ${shellQuote(value)}`, 10_000);
    }
    return;
  }
  if (platform === 'win32') {
    const encoded = Buffer.from(buildWindowsMouseScript(action), 'utf16le').toString('base64');
    await desktopCapture.execPromise(`powershell -NoProfile -EncodedCommand ${encoded}`, 10_000);
  } else if (platform === 'darwin') {
    await desktopCapture.execPromise(buildMacMouseCommand(action), 10_000);
  } else {
    await desktopCapture.execPromise(buildLinuxMouseCommand(action), 10_000);
  }
}

function windowsMouseFlags(button: MouseButton): { down: string; up: string } {
  if (button === 'right') return { down: '0x0008', up: '0x0010' };
  if (button === 'middle') return { down: '0x0020', up: '0x0040' };
  return { down: '0x0002', up: '0x0004' };
}

function windowsMovePoint(x: number, y: number): string {
  return `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y});`;
}

export function buildWindowsMouseScript(action: DesktopMouseAction): string {
  const header = 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e);\' -Name MouseNative -Namespace HarnessWin;';
  const parts = [header];
  if (action.type === 'move') {
    parts.push(windowsMovePoint(action.x, action.y));
  } else if (action.type === 'click') {
    if (action.x !== null && action.y !== null) parts.push(windowsMovePoint(action.x, action.y));
    const { down, up } = windowsMouseFlags(action.button);
    for (let i = 0; i < action.count; i++) {
      parts.push(`[HarnessWin.MouseNative]::mouse_event(${down},0,0,0,0); [HarnessWin.MouseNative]::mouse_event(${up},0,0,0,0);`);
    }
  } else if (action.type === 'drag') {
    const { down, up } = windowsMouseFlags(action.button);
    parts.push(windowsMovePoint(action.x1, action.y1));
    parts.push(`[HarnessWin.MouseNative]::mouse_event(${down},0,0,0,0); Start-Sleep -Milliseconds 60;`);
    parts.push(windowsMovePoint(action.x2, action.y2));
    parts.push(`[HarnessWin.MouseNative]::mouse_event(${up},0,0,0,0);`);
  } else {
    if (action.x !== null && action.y !== null) parts.push(windowsMovePoint(action.x, action.y));
    parts.push(`[HarnessWin.MouseNative]::mouse_event(0x0800,0,0,${action.amount * 120},0);`);
  }
  return parts.join(' ');
}

function linuxButtonNumber(button: MouseButton): string {
  return button === 'right' ? '3' : button === 'middle' ? '2' : '1';
}

export function buildLinuxMouseCommand(action: DesktopMouseAction): string {
  if (action.type === 'move') return `xdotool mousemove ${action.x} ${action.y}`;
  if (action.type === 'click') {
    const pos = action.x !== null && action.y !== null ? `mousemove ${action.x} ${action.y} ` : '';
    return `xdotool ${pos}click --repeat ${action.count} ${linuxButtonNumber(action.button)}`;
  }
  if (action.type === 'drag') {
    const b = linuxButtonNumber(action.button);
    return `xdotool mousemove ${action.x1} ${action.y1} mousedown ${b} mousemove ${action.x2} ${action.y2} mouseup ${b}`;
  }
  const pos = action.x !== null && action.y !== null ? `mousemove ${action.x} ${action.y} ` : '';
  return `xdotool ${pos}click --repeat ${Math.abs(action.amount)} ${action.amount > 0 ? '4' : '5'}`;
}

export function buildMacMouseCommand(action: DesktopMouseAction): string {
  if (action.type === 'move') return `cliclick m:${action.x},${action.y}`;
  if (action.type === 'click') {
    const pos = action.x !== null && action.y !== null ? `${action.x},${action.y}` : '.';
    if (action.count >= 2) return `cliclick dc:${pos}`;
    return `cliclick ${action.button === 'right' ? 'rc' : 'c'}:${pos}`;
  }
  if (action.type === 'drag') {
    return `cliclick dd:${action.x1},${action.y1} du:${action.x2},${action.y2}`;
  }
  throw new Error('scroll is not supported on macOS (cliclick has no scroll verb)');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function appendDesktopInputAudit(projectDir: string, event: Record<string, unknown>): Promise<void> {
  const dir = path.join(projectDir, DESKTOP_DIR);
  await fs.mkdir(dir, { recursive: true });
  const entry = {
    timestamp: new Date().toISOString(),
    tool: DesktopInputReplayTool.name,
    ...event,
  };
  await fs.appendFile(path.join(dir, AUDIT_FILE), `${JSON.stringify(entry)}\n`, 'utf-8');
  await pruneDesktopInputEvidence(projectDir);
}

async function pruneDesktopInputEvidence(projectDir: string): Promise<void> {
  const dir = path.join(projectDir, DESKTOP_DIR);
  const auditPath = path.join(dir, AUDIT_FILE);
  try {
    const auditRaw = await fs.readFile(auditPath, 'utf-8');
    const lines = auditRaw.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length > MAX_AUDIT_ENTRIES) {
      await fs.writeFile(auditPath, `${lines.slice(-MAX_AUDIT_ENTRIES).join('\n')}\n`, 'utf-8');
    }
  } catch {
    // Missing audit files are fine; the next append will create one.
  }

  const files = await fs.readdir(dir).catch(() => []);
  const screenshots = files.filter((name) => SCREENSHOT_PATTERN.test(name)).sort();
  const staleScreenshots = screenshots.slice(0, Math.max(0, screenshots.length - MAX_SCREENSHOT_FILES));
  await Promise.all(staleScreenshots.map((name) => fs.rm(path.join(dir, name), { force: true })));
}