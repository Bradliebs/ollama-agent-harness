import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { getAgentOutputDir } from './pathResolution';

const MAX_OUTPUT_SIZE = 50_000;
const MAX_COMMAND_LENGTH = 500;

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

/**
 * Detect shell control operators that are NOT inside a quoted string.
 *
 * The bash tool spawns with `shell: false`, so characters inside quoted
 * arguments are passed verbatim to the executable and aren't shell
 * operators at all (`node -e "a; b"` runs `node` with one arg of literal
 * `a; b`). The previous regex-only check rejected those legitimate
 * invocations, which is what triggered the "false positive" Block: lines
 * the model kept hitting on `node -e "...; ..."` invocations.
 *
 * Outside quotes we still reject `;`, `|`, `&&`, `||`, redirects, command
 * substitution, etc. — defense-in-depth in case the spawn is ever
 * accidentally switched to `shell: true`.
 *
 * Quote handling mirrors `parseCommandToArgv`: single quotes are literal
 * (no escaping inside), double quotes honor `\"` and `\\`, and a bare
 * backslash escapes the next character at top level.
 *
 * Returns the offending operator (or `null` when the command is clean).
 */
function findUnquotedShellOperator(command: string): string | null {
  let quote: 'single' | 'double' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === 'single') {
      if (ch === '\'') quote = null;
      continue;
    }
    if (quote === 'double') {
      if (ch === '\\') {
        const next = command[i + 1];
        if (next === '"' || next === '\\') { i++; continue; }
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    // Top level: escape sequences consume the next char.
    if (ch === '\\') { i++; continue; }
    if (ch === '\'') { quote = 'single'; continue; }
    if (ch === '"') { quote = 'double'; continue; }
    // Multi-char operators first.
    if (ch === '|' && command[i + 1] === '|') return '||';
    if (ch === '&' && command[i + 1] === '&') return '&&';
    if (ch === '$' && command[i + 1] === '(') return '$(';
    if (ch === '$' && command[i + 1] === '{') return '${';
    // Single-char operators.
    if (ch === ';' || ch === '|' || ch === '`' || ch === '>' || ch === '<' || ch === '\n' || ch === '\r') {
      return ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch;
    }
  }
  return null;
}

function isSafeCommand(command: string): string | null {
  const normalized = command.trim();
  if (!normalized) return 'Blocked: command is empty.';
  if (normalized.length > MAX_COMMAND_LENGTH) {
    return `Blocked: command exceeds ${MAX_COMMAND_LENGTH} characters.`;
  }
  const operator = findUnquotedShellOperator(normalized);
  if (operator) {
    return `Blocked: command contains shell control operator '${operator}' outside quotes. Only single-command invocations are allowed. (Operators INSIDE quoted arguments are fine — e.g. node -e "a; b" — so wrap shell-meaningful chars in quotes.)`;
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

/**
 * Quote a single argv element per Microsoft's CommandLineToArgvW parsing
 * rules so the spawned program (the .cmd shim's downstream executable)
 * receives the argument intact.
 *
 * Rules implemented:
 *   - Empty arg → `""` (so it remains a distinct token).
 *   - Arg with no whitespace, quote, or cmd.exe metachar → unchanged.
 *   - Otherwise enclose in `"..."`. Inside the quotes, escape each `"` as
 *     `\"`, and any run of backslashes immediately preceding a `"` (or
 *     the closing quote) is doubled.
 *
 * Reference: https://learn.microsoft.com/en-us/cpp/c-runtime-library/parsing-cpp-command-line-arguments
 *
 * Known residual exposure: `%FOO%` inside double quotes still triggers
 * cmd.exe env-var expansion (cmd.exe processes `%` even inside quoted
 * strings). The agent's `isSafeCommand` gate runs before this code, so a
 * deliberate `$()` or `` ` `` is already blocked; literal `%X%` is not
 * blocked but is rare in agent-issued commands. Documented and accepted.
 */
export function quoteWindowsArgv(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"%&|<>^()!,;]/.test(arg)) return arg;
  let result = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      // Each backslash before a `"` must itself be doubled (so it stays
      // a literal backslash) plus one extra `\` to escape the quote.
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  // Any backslashes immediately before the closing quote must be doubled.
  result += '\\'.repeat(backslashes * 2) + '"';
  return result;
}

/**
 * Build the command string that `cmd.exe /d /s /c` will execute when
 * routing a .cmd shim invocation. The result must be passed to spawn as
 * a single array element with `windowsVerbatimArguments: true` so Node
 * does not re-quote it.
 */
export function buildWindowsCmdInvocation(executable: string, args: string[]): string {
  return [executable, ...args].map(quoteWindowsArgv).join(' ');
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
  return `Blocked: ${executable} is a Windows shell built-in, but bash runs direct executables only. Use file_read/list_files for inspection, file_write/file_edit for files, make_directory to create folders, or a direct executable such as git, npm, node, or powershell.exe.`;
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

// Script extensions we auto-resolve against agent-outputs/ when the arg
// looks like a bare filename (no separators). Keep this list narrow —
// only files the agent commonly writes via file_write and then runs.
const BARE_SCRIPT_EXTENSIONS = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.sh', '.ps1', '.rb', '.pl', '.lua',
]);

/**
 * Rewrite bare script-filename args to the absolute path under the
 * agent-outputs directory when the file exists there but not in cwd.
 *
 * Motivation: `file_write` redirects bare filenames (e.g.
 * `check_yfinance.py`) into the agent-outputs directory. When the model
 * immediately tries to execute it with `python check_yfinance.py`, the
 * arg resolves against process.cwd() (the project root) and fails with
 * "No such file or directory". The improved file_write message now tells
 * the model to use the full path, but auto-resolving here closes the loop
 * for the case where the model forgets — without changing semantics for
 * scripts that genuinely live in cwd.
 *
 * Rules:
 *   - Skip argv[0] (the executable).
 *   - Skip args starting with `-` (flags).
 *   - Skip args containing `/` or `\` (already path-qualified).
 *   - Skip absolute paths.
 *   - Only rewrite args ending in a known script extension.
 *   - Only rewrite when the file does NOT exist in cwd AND DOES exist in
 *     the agent-outputs directory.
 */
function rewriteBareScriptArgs(args: string[]): {
  args: string[];
  rewrites: Array<{ from: string; to: string }>;
} {
  const rewrites: Array<{ from: string; to: string }> = [];
  const outputDir = (() => {
    try { return getAgentOutputDir(); } catch { return null; }
  })();
  if (!outputDir) return { args, rewrites };

  const rewritten = args.map((arg) => {
    if (!arg || arg.startsWith('-')) return arg;
    if (arg.includes('/') || arg.includes('\\')) return arg;
    if (path.isAbsolute(arg)) return arg;
    const ext = path.extname(arg).toLowerCase();
    if (!BARE_SCRIPT_EXTENSIONS.has(ext)) return arg;

    // If the bare name resolves against cwd, the agent's invocation is
    // already correct — leave it alone.
    try {
      const cwdCandidate = path.resolve(process.cwd(), arg);
      if (fs.existsSync(cwdCandidate)) return arg;
    } catch { /* fall through */ }

    // Probe the agent-outputs directory.
    try {
      const outputCandidate = path.join(outputDir, arg);
      if (fs.existsSync(outputCandidate)) {
        rewrites.push({ from: arg, to: outputCandidate });
        return outputCandidate;
      }
    } catch { /* noop */ }
    return arg;
  });

  return { args: rewritten, rewrites };
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
      const rawArgs = argv.slice(1);
      const { args, rewrites } = rewriteBareScriptArgs(rawArgs);
      const preamble = rewrites.length > 0
        ? rewrites
            .map((r) => `ℹ️ Bash auto-resolved '${r.from}' → '${r.to}' (found in agent-outputs/, not in cwd).`)
            .join('\n') + '\n'
        : '';
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
      // When the cmd-shim path fires we must opt into windowsVerbatimArguments
      // so Node does not re-quote our already-quoted command string and
      // produce a broken nested-quote command line.
      let useVerbatim = false;
      if (useCmdShim) {
        spawnExecutable = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
        spawnArgs = ['/d', '/s', '/c', buildWindowsCmdInvocation(executable, args)];
        useVerbatim = true;
      }

      const child = spawn(spawnExecutable, spawnArgs, {
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: useVerbatim,
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
          const message = `Command '${executable}' timed out after ${timeout}ms`;
          const output = formatOutput(stdout, stderr);
          settle({
            success: false,
            output: preamble + (output === '(no output)' ? message : `${message}\n${output}`),
            error: message,
          });
          return;
        }

        if (code === 0) {
          settle({ success: true, output: preamble + formatOutput(stdout, stderr) });
          return;
        }

        // Include the executable name in the error so callers (and the
        // model's failure-counter) get something more actionable than a
        // bare exit code. When the child wrote nothing, surface a short
        // stderr-shaped hint so the agent can decide whether to retry
        // with different arguments or pivot to another tool.
        const trimmedStderr = stderr.trim();
        const hint = trimmedStderr ? trimmedStderr.split(/\r?\n/)[0]!.slice(0, 200) : '';
        const message = `Command '${executable}' failed with exit code ${code ?? 'unknown'}${hint ? `: ${hint}` : ''}`;
        const output = formatOutput(stdout, stderr);
        settle({
          success: false,
          output: preamble + (output === '(no output)' ? message : `${message}\n${output}`),
          error: message,
        });
      });
    });
  },
};
