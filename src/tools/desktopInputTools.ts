import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { evaluateCapabilityGrant, sanitizeCapabilityGrants, type CapabilityGrant } from '../permissions/capabilities';
import * as desktopCapture from './desktopTools';

type DesktopInputAction =
  | { type: 'text'; value: string }
  | { type: 'key'; value: string }
  | { type: 'wait'; ms: number };

interface DesktopInputPolicyState {
  killSwitch: { active: boolean; reason: string };
  capabilityGrants: CapabilityGrant[];
}

const MAX_ACTIONS = 10;
const MAX_TEXT_LENGTH = 500;
const MAX_KEY_LENGTH = 80;
const MAX_WAIT_MS = 2_000;
const SETTINGS_PATH = path.join('.harness', 'settings.json');
const DESKTOP_DIR = path.join('.harness', 'desktop');
const AUDIT_FILE = 'desktop-input-audit.jsonl';

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
            type: { type: 'string', enum: ['text', 'key', 'wait'] },
            value: { type: 'string' },
            ms: { type: 'number' },
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
    }
  }
  return actions;
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
    if (action.type === 'wait') return `${index + 1}. wait ${action.ms}ms`;
    return `${index + 1}. ${action.type} ${JSON.stringify(action.value)}`;
  }).join('\n');
}

async function executeDesktopInputAction(action: DesktopInputAction): Promise<void> {
  if (action.type === 'wait') {
    await new Promise((resolve) => setTimeout(resolve, action.ms));
    return;
  }
  const value = action.type === 'text' ? action.value : action.value;
  const platform = os.platform();
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
}