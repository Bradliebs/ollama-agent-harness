import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { AutomationJob } from './jobs';
import { evaluateCapabilityGrant, type CapabilityGrant } from '../permissions/capabilities';
import { appendCapabilityAuditEvent } from '../permissions/capabilityAudit';

export interface AutomationRunResult {
  jobId: string;
  prompt: string;
  scriptOutput: string;
  outputPath: string;
}

const MAX_SCRIPT_OUTPUT = 50_000;
const AUTOMATION_SCRIPT_CAPABILITIES = ['arbitrary-shell', 'background-autonomous-jobs'];

export interface ShellCommandPreset {
  id: string;
  label: string;
  pattern: RegExp;
  examples: string[];
}

export const SHELL_COMMAND_ALLOWLIST_PRESETS: ShellCommandPreset[] = [
  { id: 'git-read-status', label: 'Git read-only status and diffs', pattern: /^git\s+(status(?:\s+--short)?|diff\s+(--stat|--name-only)|log\s+--oneline(?:\s+-\d+)?)$/i, examples: ['git status --short', 'git diff --stat', 'git diff --name-only', 'git log --oneline -5'] },
  { id: 'file-discovery', label: 'Read-only file discovery', pattern: /^(rg\s+--files(?:\s+(?!.*\.\.)[-\w./*]+)?|dir(?:\s+(?!.*\.\.)[-\w./*]+)?|Get-ChildItem(?:\s+(?!.*\.\.)[-\w./*]+)?)$/i, examples: ['rg --files', 'dir', 'Get-ChildItem'] },
  { id: 'tool-version', label: 'Tool version checks', pattern: /^(node|npm|git)\s+(--version|-v)$/i, examples: ['node --version', 'npm --version', 'git --version'] },
  { id: 'project-validation', label: 'Project validation scripts', pattern: /^npm\s+run\s+(typecheck|build|smoke:ui)$/i, examples: ['npm run typecheck', 'npm run build', 'npm run smoke:ui'] },
];

export interface AutomationPolicyContext {
  grants?: CapabilityGrant[];
  killSwitchActive?: boolean;
  now?: Date;
}

export async function buildAutomationPrompt(job: AutomationJob, scriptOutput = ''): Promise<string> {
  if (!scriptOutput.trim()) return job.prompt;
  return [
    job.prompt,
    '',
    'Script context:',
    scriptOutput.trim(),
  ].join('\n');
}

export async function runAutomationScript(command: string, cwd: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: MAX_SCRIPT_OUTPUT * 2 }, (error, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('\n').slice(0, MAX_SCRIPT_OUTPUT);
      if (error && !output) resolve(`Script failed: ${error.message}`);
      else resolve(output || '(script produced no output)');
    });
  });
}

export async function prepareAutomationRun(projectDir: string, job: AutomationJob, now = new Date(), policy: AutomationPolicyContext = {}): Promise<AutomationRunResult> {
  const scriptOutput = job.scriptCommand ? await runAutomationScriptWithPolicy(job.scriptCommand, projectDir, job.id, { ...policy, now }) : '';
  const prompt = await buildAutomationPrompt(job, scriptOutput);
  const outputPath = path.join(projectDir, '.harness', 'automations', 'output', job.id, `${safeTimestamp(now)}.md`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `# ${job.name}\n\n${prompt}\n`, 'utf-8');
  return { jobId: job.id, prompt, scriptOutput, outputPath };
}

async function runAutomationScriptWithPolicy(command: string, cwd: string, jobId: string, policy: AutomationPolicyContext): Promise<string> {
  const grants = policy.grants ?? [];
  const denied = AUTOMATION_SCRIPT_CAPABILITIES
    .map((capabilityId) => evaluateCapabilityGrant(capabilityId, grants, { now: policy.now, killSwitchActive: policy.killSwitchActive }))
    .filter((evaluation) => evaluation.decision !== 'allow');
  if (denied.length > 0) {
    const reason = denied.map((evaluation) => `${evaluation.capabilityId}: ${evaluation.reason}`).join('; ');
    await appendCapabilityAuditEvent(cwd, { type: 'automation_script.denied', jobId, command, reason }, policy.now);
    return denied.map((evaluation) => `Script blocked by ${evaluation.capabilityId}: ${evaluation.reason}`).join('\n');
  }
  const preset = matchShellCommandPreset(command);
  if (!preset) {
    const reason = 'Command does not match an allowlist preset.';
    await appendCapabilityAuditEvent(cwd, { type: 'automation_script.denied', jobId, command, reason }, policy.now);
    return `Script blocked by command allowlist: ${reason}`;
  }
  await appendCapabilityAuditEvent(cwd, { type: 'automation_script.allowed', jobId, command, presetId: preset.id }, policy.now);
  return runAutomationScript(command, cwd);
}

export function listShellCommandAllowlistPresets(): Array<Omit<ShellCommandPreset, 'pattern'>> {
  return SHELL_COMMAND_ALLOWLIST_PRESETS.map(({ id, label, examples }) => ({ id, label, examples: [...examples] }));
}

export function matchShellCommandPreset(command: string): ShellCommandPreset | null {
  const normalized = command.trim().replace(/\s+/g, ' ');
  return SHELL_COMMAND_ALLOWLIST_PRESETS.find((preset) => preset.pattern.test(normalized)) ?? null;
}

function safeTimestamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, '-');
}
