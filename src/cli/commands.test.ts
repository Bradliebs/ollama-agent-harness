import { formatCliHelp, resolveCliCommand } from './commands';

describe('CLI command registry', () => {
  it('resolves command aliases', () => {
    expect(resolveCliCommand('health')?.name).toBe('doctor');
  });

  it('formats help from registry metadata', () => {
    const help = formatCliHelp(['coding-answer']);

    expect(help).toContain('harness doctor [options]');
    expect(help).toContain('--model <name>');
    expect(help).toContain('coding-answer');
  });
});
