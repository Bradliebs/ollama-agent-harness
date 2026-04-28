import { exec } from 'child_process';
import type { Tool, ToolResult } from '../types';

const MAX_OUTPUT_SIZE = 50_000;

const BLOCKED_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*)?r[a-zA-Z]*f\b.*\/\s*$/,   // rm -rf /
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  /\b:(){ :|:& };:/,                               // fork bomb
  /\bchmod\s+(-[a-zA-Z]+ )*777\s+\//,
  /\bformat\b.*[cCdD]:/,
];

function isSafeCommand(command: string): string | null {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked: command matches dangerous pattern (${pattern.source})`;
    }
  }
  return null;
}

export const BashTool: Tool = {
  name: 'bash',
  description: 'Execute a shell command and return stdout/stderr',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
    },
    required: ['command'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const command = input.command as string;
    const timeout = (input.timeout as number) ?? 30_000;

    const blocked = isSafeCommand(command);
    if (blocked) {
      return { success: false, output: blocked, error: blocked };
    }

    return new Promise((resolve) => {
      const child = exec(command, { timeout, maxBuffer: MAX_OUTPUT_SIZE * 2 }, (error, stdout, stderr) => {
        const output = [
          stdout ? `STDOUT:\n${stdout.slice(0, MAX_OUTPUT_SIZE)}` : '',
          stderr ? `STDERR:\n${stderr.slice(0, MAX_OUTPUT_SIZE)}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');

        if (error) {
          resolve({
            success: false,
            output: output || `Command failed: ${error.message}`,
            error: error.message,
          });
        } else {
          resolve({
            success: true,
            output: output || '(no output)',
          });
        }
      });

      child.on('error', (err) => {
        resolve({
          success: false,
          output: `Failed to execute command: ${err.message}`,
          error: err.message,
        });
      });
    });
  },
};
