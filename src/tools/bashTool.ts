import { spawn } from 'child_process';
import type { Tool, ToolResult } from '../types';

const MAX_OUTPUT_SIZE = 50_000;
const MAX_COMMAND_LENGTH = 500;
const SHELL_CONTROL_PATTERN = /(\|\||&&|[;|`]|\$\(|\$\{|\n|\r|>|<)/;

const BLOCKED_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*)?r[a-zA-Z]*f\b.*\/\s*$/,   // rm -rf /
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  /\b:(){ :|:& };:/,                               // fork bomb
  /\bchmod\s+(-[a-zA-Z]+ )*777\s+\//,
  /\bformat\b.*[cCdD]:/,
];

function isSafeCommand(command: string): string | null {
  const normalized = command.trim();
  if (!normalized) return 'Blocked: command is empty.';
  if (normalized.length > MAX_COMMAND_LENGTH) {
    return `Blocked: command exceeds ${MAX_COMMAND_LENGTH} characters.`;
  }
  if (SHELL_CONTROL_PATTERN.test(normalized)) {
    return 'Blocked: command contains shell control operators. Only single-command invocations are allowed.';
  }
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(normalized)) {
      return `Blocked: command matches dangerous pattern (${pattern.source})`;
    }
  }
  return null;
}

function parseCommandToArgv(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaped = false;

  const pushCurrent = (): void => {
    if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  };

  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && quote !== 'single') {
      escaped = true;
      continue;
    }

    if (quote === 'single') {
      if (ch === '\'') quote = null;
      else current += ch;
      continue;
    }

    if (quote === 'double') {
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }

    if (ch === '\'') {
      quote = 'single';
      continue;
    }
    if (ch === '"') {
      quote = 'double';
      continue;
    }

    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    current += ch;
  }

  if (escaped) {
    throw new Error('Blocked: command ends with an unfinished escape sequence.');
  }
  if (quote !== null) {
    throw new Error('Blocked: command has unmatched quotes.');
  }
  pushCurrent();

  if (tokens.length === 0) {
    throw new Error('Blocked: command is empty.');
  }
  return tokens;
}

function formatOutput(stdout: string, stderr: string): string {
  const output = [
    stdout ? `STDOUT:\n${stdout.slice(0, MAX_OUTPUT_SIZE)}` : '',
    stderr ? `STDERR:\n${stderr.slice(0, MAX_OUTPUT_SIZE)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return output || '(no output)';
}

export const BashTool: Tool = {
  name: 'bash',
  description: 'Execute a single executable with arguments and return stdout/stderr. Shell control operators and shell built-ins are not supported.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Single executable invocation to run without a shell' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
    },
    required: ['command'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const command = String(input.command ?? '');
    const timeoutRaw = Number(input.timeout ?? 30_000);
    const timeout = Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.floor(timeoutRaw)
      : 30_000;

    const blocked = isSafeCommand(command);
    if (blocked) {
      return { success: false, output: blocked, error: blocked };
    }

    let argv: string[] = [];
    try {
      argv = parseCommandToArgv(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: message, error: message };
    }

    return new Promise((resolve) => {
      const executable = argv[0]!;
      const args = argv.slice(1);
      let settled = false;
      let timedOut = false;
      let stdout = '';
      let stderr = '';

      const child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
      });

      const appendLimited = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
        const text = chunk.toString();
        if (target === 'stdout') stdout = (stdout + text).slice(0, MAX_OUTPUT_SIZE + 1_000);
        else stderr = (stderr + text).slice(0, MAX_OUTPUT_SIZE + 1_000);
      };

      const settle = (result: ToolResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(result);
      };

      const timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeout);

      child.stdout?.on('data', (chunk) => appendLimited('stdout', chunk));
      child.stderr?.on('data', (chunk) => appendLimited('stderr', chunk));

      child.on('error', (err) => {
        settle({
          success: false,
          output: `Failed to execute command: ${err.message}`,
          error: err.message,
        });
      });

      child.on('close', (code) => {
        if (timedOut) {
          const message = `Command timed out after ${timeout}ms`;
          const output = formatOutput(stdout, stderr);
          settle({
            success: false,
            output: output === '(no output)' ? message : output,
            error: message,
          });
          return;
        }

        if (code === 0) {
          settle({ success: true, output: formatOutput(stdout, stderr) });
          return;
        }

        const message = `Command failed with exit code ${code ?? 'unknown'}`;
        const output = formatOutput(stdout, stderr);
        settle({
          success: false,
          output: output === '(no output)' ? message : output,
          error: message,
        });
      });
    });
  },
};
