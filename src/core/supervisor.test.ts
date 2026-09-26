import { RunSupervisor, describeAttempt, resolveSupervisorConfig, type TurnObservation } from './supervisor';

const idle = (attempt = 'web_read(https://a.example)'): TurnObservation => ({
  toolCalls: 1,
  newSources: 0,
  filesChanged: 0,
  successfulResults: [],
  attempts: [attempt],
});

describe('RunSupervisor', () => {
  it('escalates warn -> change strategy -> ask human across stalled turns, once per stage', () => {
    const supervisor = new RunSupervisor({ stallTurns: 2 });
    const decisions = Array.from({ length: 7 }, () => supervisor.endTurn(idle()));
    expect(decisions.map((d) => (d.kind === 'intervene' ? d.stage : d.kind))).toEqual([
      'stalled', 'warn', 'stalled', 'change_strategy', 'stalled', 'ask_human', 'stalled',
    ]);
    const ask = decisions[5];
    expect(ask.kind === 'intervene' && ask.summary).toContain('web_read(https://a.example)');
    expect(ask.kind === 'intervene' && ask.message).toMatch(/Stop using tools/);
  });

  it('inserts an escalate stage only when the host can switch models', () => {
    const supervisor = new RunSupervisor({ stallTurns: 1, canEscalate: true });
    const stages = Array.from({ length: 6 }, () => supervisor.endTurn(idle()))
      .filter((d) => d.kind === 'intervene')
      .map((d) => (d.kind === 'intervene' ? d.stage : ''));
    expect(stages).toEqual(['warn', 'change_strategy', 'escalate', 'ask_human']);
  });

  it('treats new sources, file changes, novel results, verifier passes and plan steps as progress', () => {
    const supervisor = new RunSupervisor({ stallTurns: 1 });
    expect(supervisor.endTurn(idle()).kind).toBe('intervene');
    expect(supervisor.endTurn({ ...idle(), newSources: 1 }).kind).toBe('progress');
    expect(supervisor.endTurn({ ...idle(), filesChanged: 1 }).kind).toBe('progress');
    expect(supervisor.endTurn({ ...idle(), successfulResults: [{ name: 'grep', output: 'hit' }] }).kind).toBe('progress');
    // The same output again is not new.
    expect(supervisor.endTurn({ ...idle(), successfulResults: [{ name: 'grep', output: 'hit' }] }).kind).toBe('intervene');
    expect(supervisor.endTurn({ ...idle(), verifierPasses: 1 }).kind).toBe('progress');
    expect(supervisor.endTurn({ ...idle(), planStepsCompleted: 1 }).kind).toBe('progress');
    expect(supervisor.stalledTurns).toBe(0);
  });

  it('re-arms the stages after progress', () => {
    const supervisor = new RunSupervisor({ stallTurns: 1 });
    expect(supervisor.endTurn(idle()).kind).toBe('intervene');
    supervisor.endTurn({ ...idle(), newSources: 1 });
    const again = supervisor.endTurn(idle());
    expect(again.kind === 'intervene' && again.stage).toBe('warn');
  });

  it('enforces the token budget, and the USD budget only for priced models', () => {
    const rates: Record<string, { input: number; output: number }> = { priced: { input: 0.003, output: 0.015 } };
    const supervisor = new RunSupervisor({ maxTokens: 10_000, maxUsd: 0.05 }, (model) => rates[model]);
    supervisor.recordUsage('free-cloud', 4_000, 1_000);
    expect(supervisor.checkBudget().exceeded).toBe(false);
    supervisor.recordUsage('priced', 3_000, 2_000);
    expect(supervisor.usage).toMatchObject({ tokens: 10_000, priced: true });
    expect(supervisor.usage.usd).toBeCloseTo(0.039, 5);
    expect(supervisor.checkBudget().exceeded).toBe(false);
    supervisor.recordUsage('priced', 1_000, 1_000);
    expect(supervisor.checkBudget()).toMatchObject({ exceeded: true, which: 'tokens', limit: 10_000 });

    const usdOnly = new RunSupervisor({ maxTokens: 0, maxUsd: 0.01 }, (model) => rates[model]);
    usdOnly.recordUsage('free-cloud', 1_000_000, 1_000_000);
    expect(usdOnly.checkBudget().exceeded).toBe(false);
    usdOnly.recordUsage('priced', 1_000, 1_000);
    expect(usdOnly.checkBudget()).toMatchObject({ exceeded: true, which: 'usd' });
  });
});

describe('describeAttempt', () => {
  it('labels calls by their target and truncates long ones', () => {
    expect(describeAttempt('web_search', { query: 'nikon  zr   price' })).toBe('web_search(nikon zr price)');
    expect(describeAttempt('reflect', {})).toBe('reflect');
    expect(describeAttempt('bash', { command: 'x'.repeat(100) })).toMatch(/^bash\(x{57}\.\.\.\)$/);
  });
});

describe('resolveSupervisorConfig', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of ['HARNESS_SUPERVISOR', 'HARNESS_RUN_MAX_TOKENS', 'HARNESS_RUN_MAX_USD']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('is on by default, can be disabled, and reads budget overrides', () => {
    expect(resolveSupervisorConfig(undefined)).toMatchObject({ stallTurns: 4, maxTokens: 1_500_000 });
    expect(resolveSupervisorConfig(false)).toBeNull();
    process.env.HARNESS_SUPERVISOR = '0';
    expect(resolveSupervisorConfig(undefined)).toBeNull();
    delete process.env.HARNESS_SUPERVISOR;
    process.env.HARNESS_RUN_MAX_TOKENS = '5000';
    process.env.HARNESS_RUN_MAX_USD = '0.5';
    expect(resolveSupervisorConfig({ stallTurns: 6 })).toMatchObject({ stallTurns: 6, maxTokens: 5000, maxUsd: 0.5 });
  });
});
