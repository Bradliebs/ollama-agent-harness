// docker_exec — run code inside a sandboxed Docker container.
//
// This tool gives the agent a way to execute untrusted code without exposing
// the host filesystem. The container runs with:
//   - --rm                 : removed after the run
//   - --network=none       : no network access
//   - --read-only          : root filesystem is read-only (use /tmp/work for writes)
//   - --memory + --cpus    : hard caps
//   - timeout              : the host kills the container if it overruns
//
// The tool is disabled by default. Enable it from settings or the registry
// configuration; the runtime additionally requires `docker` on the PATH.
//
// Tests mock the spawn function, so this module is fully covered without
// requiring a real Docker installation.

import { spawn } from 'node:child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';

export interface DockerExecOptions {
  /** Image presets keyed by language. The agent picks one of these by name. */
  images?: Record<string, string>;
  /** Default container memory limit (e.g. "256m"). */
  memoryLimit?: string;
  /** Default cpu limit (decimal, e.g. 0.5). */
  cpuLimit?: number;
  /** Timeout in ms before the container is killed. */
  timeoutMs?: number;
  /** Override of the spawn function (test seam). */
  spawn?: DockerSpawnFn;
}

export type DockerSpawnFn = (command: string, args: string[], options: { input?: string; timeoutMs: number }) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>;

const DEFAULT_IMAGES: Record<string, string> = {
  python: 'python:3.12-slim',
  node: 'node:20-slim',
  bash: 'alpine:3.19',
  ruby: 'ruby:3.3-slim',
};

const COMMAND_BUILDERS: Record<string, (scriptPath: string) => string[]> = {
  python: (scriptPath) => ['python', scriptPath],
  node: (scriptPath) => ['node', scriptPath],
  bash: (scriptPath) => ['sh', scriptPath],
  ruby: (scriptPath) => ['ruby', scriptPath],
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY = '256m';
const DEFAULT_CPUS = 0.5;

export function createDockerExecTool(options: DockerExecOptions = {}): Tool {
  const images = { ...DEFAULT_IMAGES, ...(options.images ?? {}) };
  const memoryLimit = options.memoryLimit ?? DEFAULT_MEMORY;
  const cpuLimit = options.cpuLimit ?? DEFAULT_CPUS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = options.spawn ?? defaultSpawnFn;

  return {
    name: 'docker_exec',
    description: 'Execute a snippet of code inside a sandboxed Docker container. Supports python, node, bash, ruby. The container has no network, a read-only root filesystem, hard memory and cpu caps, and is removed after the run.',
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', description: 'One of: python, node, bash, ruby' },
        code: { type: 'string', description: 'Source code to run' },
        timeout_ms: { type: 'number', description: 'Optional timeout override in milliseconds (max 5 minutes)' },
      },
      required: ['language', 'code'],
    },
    isReadOnly: false,
    riskLevel: 'high',
    permissionCategory: 'shell',
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const language = typeof input.language === 'string' ? input.language.toLowerCase() : '';
      const code = typeof input.code === 'string' ? input.code : '';
      const explicitTimeout = typeof input.timeout_ms === 'number' ? input.timeout_ms : undefined;
      if (!language || !images[language]) {
        const supported = Object.keys(images).join(', ');
        return fail(`Unknown language "${language}". Supported: ${supported}.`);
      }
      if (!code.trim()) return fail('code is required');
      const effectiveTimeout = clamp(explicitTimeout ?? timeoutMs, 100, 5 * 60_000);

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-docker-'));
      const scriptName = scriptFileName(language);
      const scriptPath = path.join(tempDir, scriptName);
      await fs.writeFile(scriptPath, code, 'utf-8');
      try {
        const command = (COMMAND_BUILDERS[language] ?? COMMAND_BUILDERS.bash)(`/work/${scriptName}`);
        const args = [
          'run', '--rm',
          '--network=none',
          '--read-only',
          '--tmpfs', '/tmp:rw,size=64m',
          '--memory', memoryLimit,
          '--cpus', String(cpuLimit),
          '-v', `${tempDir}:/work:ro`,
          '-w', '/work',
          images[language],
          ...command,
        ];
        const result = await spawnFn('docker', args, { timeoutMs: effectiveTimeout });
        if (result.timedOut) {
          return fail(`docker_exec timed out after ${effectiveTimeout}ms`);
        }
        const success = result.exitCode === 0;
        const output = formatOutput(result);
        return { success, output, error: success ? undefined : `Exited with code ${result.exitCode ?? 'null'}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`docker_exec failed: ${message}`);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

function fail(message: string): ToolResult {
  return { success: false, output: message, error: message };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function scriptFileName(language: string): string {
  switch (language) {
    case 'python': return 'main.py';
    case 'node': return 'main.js';
    case 'ruby': return 'main.rb';
    case 'bash': return 'main.sh';
    default: return 'main.txt';
  }
}

function formatOutput({ exitCode, stdout, stderr }: { exitCode: number | null; stdout: string; stderr: string }): string {
  const parts: string[] = [];
  parts.push(`exit_code: ${exitCode ?? 'null'}`);
  if (stdout.trim()) parts.push(`stdout:\n${stdout.trimEnd()}`);
  if (stderr.trim()) parts.push(`stderr:\n${stderr.trimEnd()}`);
  return parts.join('\n');
}

const defaultSpawnFn: DockerSpawnFn = (command, args, options) => new Promise((resolve) => {
  const child = spawn(command, args, { shell: false });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGKILL'); } catch { /* best-effort */ }
  }, options.timeoutMs);
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
  child.on('error', (error) => {
    clearTimeout(timer);
    stderr += '\n' + (error instanceof Error ? error.message : String(error));
    resolve({ exitCode: 1, stdout, stderr, timedOut });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve({ exitCode: code, stdout, stderr, timedOut });
  });
});
