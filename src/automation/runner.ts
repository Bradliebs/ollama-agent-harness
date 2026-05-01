import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { AutomationJob } from './jobs';

export interface AutomationRunResult {
  jobId: string;
  prompt: string;
  scriptOutput: string;
  outputPath: string;
}

const MAX_SCRIPT_OUTPUT = 50_000;

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

export async function prepareAutomationRun(projectDir: string, job: AutomationJob, now = new Date()): Promise<AutomationRunResult> {
  const scriptOutput = job.scriptCommand ? await runAutomationScript(job.scriptCommand, projectDir) : '';
  const prompt = await buildAutomationPrompt(job, scriptOutput);
  const outputPath = path.join(projectDir, '.harness', 'automations', 'output', job.id, `${safeTimestamp(now)}.md`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `# ${job.name}\n\n${prompt}\n`, 'utf-8');
  return { jobId: job.id, prompt, scriptOutput, outputPath };
}

function safeTimestamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, '-');
}
