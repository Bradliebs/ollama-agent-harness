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
    expect(result.error).toContain('shell control operators');
  });

  it('blocks command substitution patterns', async () => {
    const result = await BashTool.execute({ command: 'echo $(whoami)' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('shell control operators');
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
});
