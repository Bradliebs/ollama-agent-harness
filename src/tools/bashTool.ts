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

const WINDOWS_SHELL_BUILTINS = new Set([
  'assoc', 'break', 'call', 'cd', 'chdir', 'cls', 'color', 'copy',
  'date', 'del', 'dir', 'echo', 'endlocal', 'erase', 'exit', 'for',
  'ftype', 'goto', 'if', 'md', 'mkdir', 'mklink', 'move', 'path',
  'pause', 'popd', 'prompt', 'pushd', 'rd', 'rem', 'ren', 'rename',
  'rmdir', 'set', 'setlocal', 'shift', 'start', 'time', 'title', 'type',
  'ver', 'verify', 'vol',
]);

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

// Windows: these JS-toolchain shims are .cmd files which Node 20.12+ /
// 18.20.2+ refuses to spawn directly (CVE-2024-27980). Direct spawn
// returns ENOENT. Routing through cmd.exe /d /s /c lets PATHEXT
// resolution pick up the .cmd and run it normally.
const WINDOWS_CMD_SHIM_NAMES = new Set([
  'npm', 'npx', 'yarn', 'pnpm', 'pnpx', 'bun', 'bunx',
  'tsx', 'tsc', 'eslint', 'prettier', 'jest', 'vitest',
  'next', 'vite', 'webpack', 'rollup', 'parcel', 'esbuild',
  'nodemon', 'pm2', 'serve', 'http-server',
]);
const WINDOWS_NATIVE_EXT_PATTERN = /\.(?:exe|com)$/i;

function needsWindowsCmdShim(executable: string): boolean {
  if (process.platform !== 'win32') return false;
  // Already-resolved native binaries: spawn directly. Includes paths like
  // "C:\\Program Files\\nodejs\\node.exe" and bare "node" / "git" which
  // resolve to .exe via PATHEXT without needing cmd.exe help.
  if (WINDOWS_NATIVE_EXT_PATTERN.test(executable)) return false;
  // Anything containing a path separator points at a specific file —
  // assume the agent picked it deliberately and let the OS resolve it.
  if (executable.includes('\\') || executable.includes('/')) return false;
  // Bare command: route through cmd.exe when it's a known shim. Limiting
  // to the allowlist keeps the fast path for native tools (node, git,
  // python, ollama, etc.) and avoids surprising behaviour for unfamiliar
  // commands the agent might spawn.
  return WINDOWS_CMD_SHIM_NAMES.has(executable.toLowerCase());
}

function parseCommandToArgv(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;

  const pushCurrent = (): void => {
    if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  };

  for (let index = 0; index < command.length; index++) {
    const ch = command[index]!;

    if (quote === 'single') {
      if (ch === '\'') quote = null;
      else current += ch;
      continue;
    }

    if (ch === '\\') {
      const next = command[index + 1];
      const escapable = quote === 'double'
        ? next === '"' || next === '\\'
        : next === '"' || next === '\'' || next === '\\' || (next !== undefined && /\s/.test(next));
      if (escapable && next !== undefined) {
        current += next;
        index++;
      } else {
        current += ch;
      }
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

  if (quote !== null) {
    throw new Error('Blocked: command has unmatched quotes.');
  }
  pushCurrent();

  if (tokens.length === 0) {
    throw new Error('Blocked: command is empty.');
  }
  return tokens;
}

function unsupportedWindowsBuiltin(executable: string): string | null {
  if (process.platform !== 'win32') return null;
  const normalized = executable.toLowerCase();
  if (!WINDOWS_SHELL_BUILTINS.has(normalized)) return null;
  return `Blocked: ${executable} is a Windows shell built-in, but bash runs direct executables only. Use file_read/list_files for inspection, file_write/file_edit for files, or a direct executable such as git, npm, node, or powershell.exe.`;
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
      const blockedBuiltin = unsupportedWindowsBuiltin(executable);
      if (blockedBuiltin) {
        resolve({ success: false, output: blockedBuiltin, error: blockedBuiltin });
        return;
      }
      const args = argv.slice(1);
      let settled = false;
      let timedOut = false;
      let stdout = '';
      let stderr = '';

      // Windows .cmd shim workaround: Node 20.12+ / 18.20.2+ refuses to
      // spawn .bat / .cmd files directly without shell:true (CVE-2024-27980),
      // and shell:true with array args is deprecated (DEP0190). On Windows
      // the common shims (npx, npm, yarn, pnpm, tsx) are .cmd files, so a
      // direct spawn returns ENOENT. Mirror the autonomy spawner's pattern:
      // route through cmd.exe /d /s /c when the executable is a known shim
      // or has no extension. Native .exe targets keep the direct fast path.
      const useCmdShim = process.platform === 'win32' && needsWindowsCmdShim(executable);
      let spawnExecutable = executable;
      let spawnArgs = args;
      if (useCmdShim) {
        spawnExecutable = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
        spawnArgs = ['/d', '/s', '/c', [executable, ...args].join(' ')];
      }

      const child = spawn(spawnExecutable, spawnArgs, {
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
