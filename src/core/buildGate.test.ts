import {
  planBuildGate,
  runBuildGate,
  buildGateVerifierScore,
  type ProjectProbe,
  type GateCommand,
  type BuildGatePlan,
} from './buildGate';

const emptyProbe: ProjectProbe = { hasPackageJson: false, packageScripts: {}, pythonPackages: [] };

describe('planBuildGate', () => {
  it('produces no commands when nothing changed', () => {
    const plan = planBuildGate({ changedFiles: [], workingDir: '/w', probe: emptyProbe });
    expect(plan.kind).toBe('none');
    expect(plan.commands).toHaveLength(0);
    expect(plan.reason).toMatch(/no files/i);
  });

  it('runs py_compile for changed python files', () => {
    const plan = planBuildGate({
      changedFiles: ['/w/pkg/a.py', '/w/pkg/b.py'],
      workingDir: '/w',
      probe: { ...emptyProbe, pythonPackages: [] },
    });
    expect(plan.kind).toBe('python');
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0].label).toBe('py_compile');
    expect(plan.commands[0].args).toEqual(['-m', 'py_compile', '/w/pkg/a.py', '/w/pkg/b.py']);
    expect(plan.commands[0].cwd).toBe('/w');
  });

  it('adds an import smoke check per discovered python package (catches BioARN-class failures)', () => {
    const plan = planBuildGate({
      changedFiles: ['/w/bioarn/core.py'],
      workingDir: '/w',
      probe: { ...emptyProbe, pythonPackages: ['bioarn'] },
    });
    const labels = plan.commands.map((c) => c.label);
    expect(labels).toContain('py_compile');
    expect(labels).toContain('import bioarn');
    const importCmd = plan.commands.find((c) => c.label === 'import bioarn') as GateCommand;
    expect(importCmd.args).toEqual(['-c', 'import bioarn']);
  });

  it('runs pytest after compile/import when the project has tests', () => {
    const plan = planBuildGate({
      changedFiles: ['/w/bioarn/core.py'],
      workingDir: '/w',
      probe: { ...emptyProbe, pythonPackages: ['bioarn'], pythonHasTests: true },
    });
    expect(plan.commands.map((c) => c.label)).toEqual(['py_compile', 'import bioarn', 'pytest']);
    const pytest = plan.commands.find((c) => c.label === 'pytest') as GateCommand;
    expect(pytest.args).toEqual(['-m', 'pytest', '-q']);
  });

  it('does not run pytest when the project has no tests', () => {
    const plan = planBuildGate({
      changedFiles: ['/w/a.py'],
      workingDir: '/w',
      probe: { ...emptyProbe, pythonHasTests: false },
    });
    expect(plan.commands.map((c) => c.label)).not.toContain('pytest');
  });

  it('prefers typecheck then test for node projects with scripts', () => {
    const plan = planBuildGate({
      changedFiles: ['/w/src/index.ts'],
      workingDir: '/w',
      probe: { hasPackageJson: true, packageScripts: { typecheck: 'tsc --noEmit', test: 'jest' }, pythonPackages: [] },
    });
    expect(plan.kind).toBe('node');
    expect(plan.commands.map((c) => c.label)).toEqual(['typecheck', 'test']);
  });

  it('falls back to build when no typecheck script exists', () => {
    const plan = planBuildGate({
      changedFiles: ['/w/src/index.js'],
      workingDir: '/w',
      probe: { hasPackageJson: true, packageScripts: { build: 'webpack' }, pythonPackages: [] },
    });
    expect(plan.commands.map((c) => c.label)).toEqual(['build']);
  });

  it('produces no commands when node files change but no package.json is present', () => {
    const plan = planBuildGate({
      changedFiles: ['/w/index.ts'],
      workingDir: '/w',
      probe: emptyProbe,
    });
    expect(plan.kind).toBe('node');
    expect(plan.commands).toHaveLength(0);
    expect(plan.reason).toMatch(/no package\.json/i);
  });

  it('reports mixed kind and validates both languages', () => {
    const plan = planBuildGate({
      changedFiles: ['/w/a.py', '/w/src/b.ts'],
      workingDir: '/w',
      probe: { hasPackageJson: true, packageScripts: { typecheck: 'tsc' }, pythonPackages: [] },
    });
    expect(plan.kind).toBe('mixed');
    expect(plan.commands.map((c) => c.label)).toEqual(['py_compile', 'typecheck']);
  });

  it('caps the number of python files passed to py_compile', () => {
    const files = Array.from({ length: 40 }, (_, i) => `/w/f${i}.py`);
    const plan = planBuildGate({ changedFiles: files, workingDir: '/w', probe: emptyProbe, maxPyCompileFiles: 5 });
    // -m, py_compile, then 5 files
    expect(plan.commands[0].args).toHaveLength(7);
  });
});

describe('runBuildGate', () => {
  const okPlan: BuildGatePlan = {
    kind: 'python',
    reason: 'test',
    commands: [
      { command: 'python', args: ['-m', 'py_compile', 'a.py'], cwd: '/w', label: 'py_compile' },
      { command: 'python', args: ['-c', 'import pkg'], cwd: '/w', label: 'import pkg' },
    ],
  };

  it('returns ran:false for an empty plan (nothing to validate != failure)', async () => {
    const result = await runBuildGate({ kind: 'none', commands: [], reason: 'nothing' }, async () => ({ exitCode: 0, output: '' }));
    expect(result.ran).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.score).toBeUndefined();
  });

  it('passes when every command exits 0', async () => {
    const result = await runBuildGate(okPlan, async () => ({ exitCode: 0, output: 'ok' }));
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.results).toHaveLength(2);
    expect(result.summary).toMatch(/passed/i);
  });

  it('fails fast at the first failing command', async () => {
    const calls: string[] = [];
    const result = await runBuildGate(okPlan, async (cmd) => {
      calls.push(cmd.label);
      return cmd.label === 'py_compile' ? { exitCode: 1, output: 'SyntaxError' } : { exitCode: 0, output: '' };
    });
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.0);
    expect(calls).toEqual(['py_compile']); // stopped before import check
    expect(result.summary).toMatch(/FAILED: py_compile/);
  });
});

describe('buildGateVerifierScore', () => {
  it('returns the score when the gate ran', async () => {
    const failed = await runBuildGate(
      { kind: 'python', reason: 'x', commands: [{ command: 'python', args: [], cwd: '/w', label: 'import pkg' }] },
      async () => ({ exitCode: 1, output: 'ModuleNotFoundError' }),
    );
    expect(buildGateVerifierScore(failed)).toBe(0.0);
  });

  it('returns undefined when the gate did not run', () => {
    expect(buildGateVerifierScore({ ran: false, passed: true, kind: 'none', results: [], score: undefined, summary: '' })).toBeUndefined();
  });
});
