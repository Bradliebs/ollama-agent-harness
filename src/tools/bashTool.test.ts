import { promises as fsp } from 'fs';
import * as path from 'path';
import { BashTool } from './bashTool';

describe('BashTool safety guardrails', () => {
  it('allows a simple single-command invocation', async () => {
    const result = await BashTool.execute({ command: 'node --version' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('STDOUT:');
  });

  it('rejects Windows shell built-ins before spawn', async () => {
    if (process.platform !== 'win32') return;

    const result = await BashTool.execute({ command: 'type package.json' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Windows shell built-in');
    expect(result.error).toContain('direct executables only');
    expect(result.error).toContain('file_read/list_files');
  });

  it('blocks shell control operators', async () => {
    const result = await BashTool.execute({ command: 'echo safe && whoami' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('shell control operator');
  });

  it('blocks command substitution patterns', async () => {
    const result = await BashTool.execute({ command: 'echo $(whoami)' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('shell control operator');
  });

  it('blocks known destructive patterns', async () => {
    const result = await BashTool.execute({ command: 'rm -rf /' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('dangerous pattern');
  });

  it('supports quoted arguments with spaces', async () => {
    const result = await BashTool.execute({ command: 'node -e "console.log(process.argv[1])" "hello world"' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('hello world');
  });

  it('preserves quoted Windows path backslashes', async () => {
    const result = await BashTool.execute({ command: 'node -e "console.log(process.argv[1])" "C:\\AI\\Harness"' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('C:\\AI\\Harness');
  });

  it('preserves unquoted Windows path backslashes', async () => {
    const result = await BashTool.execute({ command: 'node -e "console.log(process.argv[1])" C:\\AI\\Harness' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('C:\\AI\\Harness');
  });

  it('rejects unmatched quotes before execution', async () => {
    const result = await BashTool.execute({ command: 'node -e "console.log(1)' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('unmatched quotes');
  });

  it('routes Windows .cmd shims like npx through cmd.exe so they actually run', async () => {
    // Pin the Windows ENOENT regression: Node 20.12+ refuses to spawn .cmd
    // files directly, so a bare `npx --version` used to fail with
    // ENOENT. The bash tool now wraps known shims via cmd.exe /d /s /c.
    // Skip on non-Windows because the workaround only fires there.
    if (process.platform !== 'win32') return;

    const result = await BashTool.execute({ command: 'npx --version' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('STDOUT:');
    expect(result.error).toBeUndefined();
  });

  it('includes the executable name in the error when a command exits non-zero', async () => {
    // node -e "process.exit(7)" exits with status 7. Verify the error
    // message names the executable so the agent's failure-counter and
    // the UI both have something more useful than "exit code 7".
    const result = await BashTool.execute({ command: 'node -e "process.exit(7)"' });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Command 'node' failed with exit code 7");
  });

  it('allows shell-meaningful characters when they are inside a quoted argument', async () => {
    // Regression: previously rejected because ';' in the quoted JS body
    // matched the global SHELL_CONTROL_PATTERN. With shell:false the ';'
    // is just literal text inside argv[2] — no shell interpretation
    // happens, so the agent legitimately needs this for one-off node -e
    // and python -c invocations.
    const result = await BashTool.execute({
      command: 'node -e "const x = 1; console.log(x + 2)"',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('3');
  });

  it('still blocks shell control operators that appear OUTSIDE quotes', async () => {
    // Sanity check: the quote-aware scanner must still catch the
    // dangerous case. Bare `;` (not in quotes) would chain commands
    // if shell:true were ever flipped on by mistake.
    const result = await BashTool.execute({ command: 'echo hello ; whoami' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('shell control operator');
    expect(result.error).toContain("';'");
  });

  it('still blocks unquoted redirects', async () => {
    const result = await BashTool.execute({ command: 'dir /b 2>nul' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('shell control operator');
    expect(result.error).toContain("'>'");
  });

  it('allows angle brackets and pipes when quoted (e.g. inside a JSON arg)', async () => {
    const result = await BashTool.execute({
      command: `node -e "console.log('a > b | c')"`,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('a > b | c');
  });
});

describe('BashTool bare-script auto-resolve against agent-outputs', () => {
  // Mirrors the file_write redirect: when the model writes a bare script
  // filename (which gets routed to agent-outputs/) and immediately tries
  // to execute it by name, bash should rewrite the bare arg to the
  // absolute path under agent-outputs/ rather than failing with
  // "No such file or directory".
  const overrideDir = path.join(process.cwd(), '.harness', 'test-agent-outputs-bash');

  beforeEach(async () => {
    await fsp.rm(overrideDir, { recursive: true, force: true });
    await fsp.mkdir(overrideDir, { recursive: true });
    process.env.HARNESS_AGENT_OUTPUT_DIR = overrideDir;
  });

  afterEach(async () => {
    delete process.env.HARNESS_AGENT_OUTPUT_DIR;
    await fsp.rm(overrideDir, { recursive: true, force: true });
  });

  it('rewrites a bare .js arg to the absolute path under agent-outputs/ and runs it', async () => {
    const scriptName = `_bash-resolve-${Date.now()}.js`;
    const scriptPath = path.join(overrideDir, scriptName);
    await fsp.writeFile(scriptPath, 'console.log("hello-from-agent-outputs");\n', 'utf-8');

    // Guard: the bare name must NOT exist in cwd, otherwise the rewriter
    // correctly leaves it alone.
    const cwdStray = path.resolve(process.cwd(), scriptName);
    await fsp.rm(cwdStray, { force: true });

    const result = await BashTool.execute({ command: `node ${scriptName}` });

    expect(result.success).toBe(true);
    expect(result.output).toContain('hello-from-agent-outputs');
    // The preamble surfaces the rewrite so the agent can see what happened
    // and use the full path going forward.
    expect(result.output).toContain('Bash auto-resolved');
    expect(result.output).toContain(scriptName);
    expect(result.output).toContain(scriptPath);
  });

  it('does NOT rewrite when the bare script also exists in cwd (cwd wins)', async () => {
    const scriptName = `_bash-cwd-wins-${Date.now()}.js`;
    const cwdPath = path.resolve(process.cwd(), scriptName);
    const outputPath = path.join(overrideDir, scriptName);
    await fsp.writeFile(cwdPath, 'console.log("from-cwd");\n', 'utf-8');
    await fsp.writeFile(outputPath, 'console.log("from-output-dir");\n', 'utf-8');

    try {
      const result = await BashTool.execute({ command: `node ${scriptName}` });
      expect(result.success).toBe(true);
      expect(result.output).toContain('from-cwd');
      expect(result.output).not.toContain('Bash auto-resolved');
    } finally {
      await fsp.rm(cwdPath, { force: true });
    }
  });

  it('does NOT rewrite args that already contain a path separator', async () => {
    // If the model passes an explicit relative path like `./foo.py` or
    // `subdir/foo.py`, treat it as deliberate and do not silently retarget.
    const scriptName = `_bash-explicit-${Date.now()}.js`;
    await fsp.writeFile(path.join(overrideDir, scriptName), 'console.log("agent-outputs");\n', 'utf-8');

    // Use an explicit ./ path that DOES NOT exist in cwd. Node will fail.
    const result = await BashTool.execute({ command: `node ./${scriptName}` });

    expect(result.success).toBe(false);
    expect(result.output).not.toContain('Bash auto-resolved');
  });

  it('does NOT rewrite flag-like args ending in a script extension', async () => {
    // Defensive: a flag like `--config=foo.py` happens to end in `.py` but
    // is not a positional script arg. The rewriter must skip leading-dash
    // args entirely. We don't care whether `node` accepts the unknown
    // option — only that the rewriter never touches the arg.
    const flagLike = `--out=irrelevant-${Date.now()}.js`;
    await fsp.writeFile(path.join(overrideDir, flagLike), 'noop', 'utf-8').catch(() => {});

    const result = await BashTool.execute({ command: `node --version ${flagLike}` });

    // The rewrite preamble must not appear regardless of node's exit code.
    expect(result.output).not.toContain('Bash auto-resolved');
  });
});

import { quoteWindowsArgv, buildWindowsCmdInvocation } from './bashTool';

describe('quoteWindowsArgv', () => {
  it('leaves bare alphanumeric args unquoted', () => {
    expect(quoteWindowsArgv('eslint')).toBe('eslint');
    expect(quoteWindowsArgv('--version')).toBe('--version');
    expect(quoteWindowsArgv('src/index.ts')).toBe('src/index.ts');
  });

  it('represents an empty arg as a pair of quotes so it stays distinct', () => {
    expect(quoteWindowsArgv('')).toBe('""');
  });

  it('wraps args containing whitespace', () => {
    expect(quoteWindowsArgv('hello world')).toBe('"hello world"');
    expect(quoteWindowsArgv('tab\there')).toBe('"tab\there"');
  });

  it('escapes embedded double quotes as backslash-quote', () => {
    expect(quoteWindowsArgv('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('doubles backslashes that immediately precede an embedded quote', () => {
    // Microsoft argv rule: every `\` before a `"` must be doubled, plus one
    // more `\` to escape the quote itself.
    expect(quoteWindowsArgv('a\\"b')).toBe('"a\\\\\\"b"');
    expect(quoteWindowsArgv('a\\\\"b')).toBe('"a\\\\\\\\\\"b"');
  });

  it('doubles trailing backslashes before the closing quote', () => {
    // Trailing `\` before the auto-added closing `"` would otherwise be
    // interpreted by CommandLineToArgvW as escaping that quote.
    expect(quoteWindowsArgv('path with space\\')).toBe('"path with space\\\\"');
  });

  it('preserves interior backslashes that are NOT next to a quote', () => {
    // `C:\path\file.ts` has no quote-adjacent backslashes, so each is
    // kept as a single literal backslash inside the quoted form.
    expect(quoteWindowsArgv('C:\\path with space\\file.ts')).toBe('"C:\\path with space\\file.ts"');
  });

  it('wraps args containing cmd.exe metacharacters', () => {
    // Each of these would be re-interpreted by cmd.exe if left unquoted.
    for (const ch of ['&', '|', '<', '>', '^', '(', ')', '!', ';', ',']) {
      const arg = `pre${ch}post`;
      const quoted = quoteWindowsArgv(arg);
      expect(quoted.startsWith('"')).toBe(true);
      expect(quoted.endsWith('"')).toBe(true);
      expect(quoted).toContain(ch);
    }
  });
});

describe('buildWindowsCmdInvocation', () => {
  it('produces a single-token command for simple invocations', () => {
    expect(buildWindowsCmdInvocation('npx', ['--version'])).toBe('npx --version');
  });

  it('quotes args with spaces and leaves bare flags alone', () => {
    expect(buildWindowsCmdInvocation('npx', ['eslint', 'src/file with space.ts']))
      .toBe('npx eslint "src/file with space.ts"');
  });

  it('escapes a double-quoted arg correctly', () => {
    // Regression: the audit-flagged scenario was that args with internal
    // quotes got mangled. The build function must produce a string that
    // CommandLineToArgvW will parse back to the exact original arg.
    expect(buildWindowsCmdInvocation('npx', ['prettier', '--write', 'a"b.ts']))
      .toBe('npx prettier --write "a\\"b.ts"');
  });

  it('quotes args containing cmd.exe metacharacters so cmd cannot reinterpret them', () => {
    expect(buildWindowsCmdInvocation('npm', ['run', 'build & deploy']))
      .toBe('npm run "build & deploy"');
  });
});
