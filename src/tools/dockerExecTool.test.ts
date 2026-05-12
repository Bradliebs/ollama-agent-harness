import { createDockerExecTool, type DockerSpawnFn } from './dockerExecTool';

describe('docker_exec tool', () => {
  function makeSpawn(impl: DockerSpawnFn): DockerSpawnFn {
    return impl;
  }

  it('rejects unknown languages', async () => {
    const tool = createDockerExecTool({ spawn: makeSpawn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false })) });
    const result = await tool.execute({ language: 'cobol', code: 'foo' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown language');
  });

  it('requires non-empty code', async () => {
    const tool = createDockerExecTool({ spawn: makeSpawn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false })) });
    const result = await tool.execute({ language: 'python', code: '   ' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('code is required');
  });

  it('builds a docker invocation with the expected sandbox flags', async () => {
    type Captured = { command: string; args: string[] };
    const captured: Captured = { command: '', args: [] };
    const tool = createDockerExecTool({
      spawn: makeSpawn(async (command, args) => {
        captured.command = command;
        captured.args = args;
        return { exitCode: 0, stdout: 'hi\n', stderr: '', timedOut: false };
      }),
    });
    const result = await tool.execute({ language: 'python', code: 'print("hi")' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('exit_code: 0');
    expect(result.output).toContain('hi');
    expect(captured.command).toBe('docker');
    const args = captured.args;
    expect(args).toContain('--rm');
    expect(args).toContain('--network=none');
    expect(args).toContain('--read-only');
    expect(args).toContain('--memory');
    expect(args).toContain('--cpus');
    expect(args.some((arg: string) => arg.includes('python:3.12-slim'))).toBe(true);
    expect(args.some((arg: string) => arg.includes(':/work:ro'))).toBe(true);
  });

  it('reports timeouts as failures', async () => {
    const tool = createDockerExecTool({
      spawn: makeSpawn(async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true })),
    });
    const result = await tool.execute({ language: 'bash', code: 'sleep 5' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('returns non-zero exit codes as a failure with stdout/stderr', async () => {
    const tool = createDockerExecTool({
      spawn: makeSpawn(async () => ({ exitCode: 2, stdout: 'partial', stderr: 'oops', timedOut: false })),
    });
    const result = await tool.execute({ language: 'node', code: 'process.exit(2)' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Exited with code 2');
    expect(result.output).toContain('partial');
    expect(result.output).toContain('oops');
  });

  it('clamps the explicit timeout into the safe range', async () => {
    let receivedTimeout = 0;
    const tool = createDockerExecTool({
      spawn: makeSpawn(async (_command, _args, options) => {
        receivedTimeout = options.timeoutMs;
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      }),
    });
    await tool.execute({ language: 'bash', code: 'echo 1', timeout_ms: 999_999_999 });
    expect(receivedTimeout).toBeLessThanOrEqual(5 * 60_000);
    await tool.execute({ language: 'bash', code: 'echo 1', timeout_ms: 1 });
    expect(receivedTimeout).toBeGreaterThanOrEqual(100);
  });
});
