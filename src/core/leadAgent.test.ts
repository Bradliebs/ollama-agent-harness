import {
  runLeadAgent,
  DEFAULT_MAX_ATTEMPTS,
  type Decomposer,
  type OrchestrateFn,
  type OverallVerifier,
  type LeadAgentEvent,
} from './leadAgent';
import type { WorkstreamTask, OrchestrationResult, WorkstreamResult } from '../agents/orchestrator';

function ws(id: string, over: Partial<WorkstreamTask> = {}): WorkstreamTask {
  return { id, role: 'coder', prompt: `do ${id}`, ...over };
}

function branch(id: string, over: Partial<WorkstreamResult> = {}): WorkstreamResult {
  return { id, role: 'coder', output: `out ${id}`, success: true, duration_ms: 1, ...over };
}

function orchResult(over: Partial<OrchestrationResult> = {}): OrchestrationResult {
  const results = over.results ?? [branch('impl')];
  return {
    results,
    merged_output: over.merged_output ?? 'merged',
    total_duration_ms: over.total_duration_ms ?? 1,
    tasks_succeeded: over.tasks_succeeded ?? results.filter((r) => r.success).length,
    tasks_failed: over.tasks_failed ?? results.filter((r) => !r.success).length,
  };
}

const decomposeOne: Decomposer = async () => [ws('impl')];
const orchestrateOk: OrchestrateFn = async () => orchResult();
const verifyPass: OverallVerifier = async () => ({ passed: true });
const verifyFail: OverallVerifier = async () => ({ passed: false, detail: 'tsc broke' });

describe('runLeadAgent — happy path', () => {
  it('completes on first attempt when verification passes', async () => {
    const events: LeadAgentEvent[] = [];
    const outcome = await runLeadAgent({
      task: 'build a thing',
      decompose: decomposeOne,
      orchestrate: orchestrateOk,
      verifyOverall: verifyPass,
      onEvent: (e) => events.push(e),
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.finalOutput).toBe('merged');
    expect(events.map((e) => e.type)).toEqual([
      'start', 'decompose', 'orchestrated', 'verify', 'done',
    ]);
  });

  it('reports completed_with_failures when a sub-agent failed but verify passed', async () => {
    const outcome = await runLeadAgent({
      task: 't',
      decompose: decomposeOne,
      orchestrate: async () => orchResult({ results: [branch('a'), branch('b', { success: false, error: 'boom' })] }),
      verifyOverall: verifyPass,
    });
    expect(outcome.status).toBe('completed_with_failures');
  });
});

describe('runLeadAgent — replanning', () => {
  it('replans on failure and completes on a later attempt', async () => {
    const seenAttempts: number[] = [];
    const seenFailures: string[][] = [];
    const decompose: Decomposer = async (_task, attempt, priorFailures) => {
      seenAttempts.push(attempt);
      seenFailures.push([...priorFailures]);
      return [ws(`impl-${attempt}`)];
    };
    let call = 0;
    const verify: OverallVerifier = async () => (++call >= 2 ? { passed: true } : { passed: false, detail: 'still broken' });

    const events: LeadAgentEvent[] = [];
    const outcome = await runLeadAgent({
      task: 't',
      decompose,
      orchestrate: orchestrateOk,
      verifyOverall: verify,
      onEvent: (e) => events.push(e),
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.attempts).toHaveLength(2);
    expect(seenAttempts).toEqual([1, 2]);
    // Second decompose call receives the first attempt's failure reason.
    expect(seenFailures[1][0]).toContain('still broken');
    expect(events.some((e) => e.type === 'replan')).toBe(true);
  });

  it('exhausts the attempt budget without a pass', async () => {
    const outcome = await runLeadAgent({
      task: 't',
      decompose: decomposeOne,
      orchestrate: orchestrateOk,
      verifyOverall: verifyFail,
      maxAttempts: 2,
    });
    expect(outcome.status).toBe('budget_exhausted');
    expect(outcome.attempts).toHaveLength(2);
  });

  it('defaults to three attempts', async () => {
    let attempts = 0;
    await runLeadAgent({
      task: 't',
      decompose: async () => { attempts++; return [ws('x')]; },
      orchestrate: orchestrateOk,
      verifyOverall: verifyFail,
    });
    expect(attempts).toBe(DEFAULT_MAX_ATTEMPTS);
  });
});

describe('runLeadAgent — budgets and termination', () => {
  it('stops when the abort signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runLeadAgent({
      task: 't',
      decompose: decomposeOne,
      orchestrate: orchestrateOk,
      verifyOverall: verifyPass,
      abortSignal: controller.signal,
    });
    expect(outcome.status).toBe('stopped');
    expect(outcome.attempts).toHaveLength(0);
  });

  it('stops on wall-clock budget before starting a new attempt', async () => {
    let t = 0;
    const outcome = await runLeadAgent({
      task: 't',
      decompose: decomposeOne,
      orchestrate: orchestrateOk,
      verifyOverall: verifyFail,
      maxDurationMs: 100,
      now: () => (t += 200), // every read jumps 200ms, so the budget is blown immediately
    });
    expect(outcome.status).toBe('budget_exhausted');
  });
});

describe('runLeadAgent — degenerate plans', () => {
  it('returns no_plan when the first decompose is empty', async () => {
    const outcome = await runLeadAgent({
      task: 't',
      decompose: async () => [],
      orchestrate: orchestrateOk,
      verifyOverall: verifyPass,
    });
    expect(outcome.status).toBe('no_plan');
    expect(outcome.attempts).toHaveLength(0);
  });
});

describe('runLeadAgent — capability gaps', () => {
  it('surfaces missing-tool errors from sub-agents once each', async () => {
    const events: LeadAgentEvent[] = [];
    const outcome = await runLeadAgent({
      task: 't',
      decompose: decomposeOne,
      orchestrate: async () => orchResult({
        results: [branch('a', { success: false, error: 'tool "browser" not found in tool pool' })],
        merged_output: 'partial',
      }),
      verifyOverall: verifyPass,
      onEvent: (e) => events.push(e),
    });
    expect(outcome.capabilityGaps).toHaveLength(1);
    expect(outcome.capabilityGaps[0].need).toContain('browser');
    expect(events.filter((e) => e.type === 'capability_gap')).toHaveLength(1);
  });
});

describe('runLeadAgent — persistence seam', () => {
  it('writes plan, result, and outcome artifacts when a persist seam is provided', async () => {
    const written: string[] = [];
    await runLeadAgent({
      task: 't',
      decompose: decomposeOne,
      orchestrate: orchestrateOk,
      verifyOverall: verifyPass,
      persist: async (name) => { written.push(name); },
    });
    expect(written).toContain('attempt-1-plan.json');
    expect(written).toContain('attempt-1-result.json');
    expect(written).toContain('outcome.json');
  });
});
