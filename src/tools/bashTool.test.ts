import { BashTool } from './bashTool';

describe('BashTool safety guardrails', () => {
  it('allows a simple single-command invocation', async () => {
    const result = await BashTool.execute({ command: 'node --version' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('STDOUT:');
  });

  it('does not route shell built-ins through a shell on Windows', async () => {
    if (process.platform !== 'win32') return;

    const result = await BashTool.execute({ command: 'echo hello' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('ENOENT');
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

  it('rejects unmatched quotes before execution', async () => {
    const result = await BashTool.execute({ command: 'node -e "console.log(1)' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('unmatched quotes');
  });
});
