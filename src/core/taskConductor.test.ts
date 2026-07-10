import {
  runConductor,
  createQueryLoopExecutor,
  parsePlan,
  renderStepPrompt,
  PLANNER_SYSTEM_PROMPT,
  type ConductorEvent,
  type ConductorPlan,
  type ConductorStep,
  type StepExecutor,
  type StepResult,
  type StepVerifier,
} from './taskConductor';
import type { VerificationResult } from './doneStateVerifier';
import { buildTaskContract } from './taskContractBuilder';
import type { LoopConfig, Tool } from '../types';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

function step(id: number, over: Partial<ConductorStep> = {}): ConductorStep {
  return { id, intent: `step ${id}`, suggestedToolsets: [], verify: { kind: 'none' }, done: false, ...over };
}

function okResult(over: Partial<StepResult> = {}): StepResult {
  return { text: 'did it', toolCallSequence: [], toolCallCount: 0, toolSuccessCount: 0, fileChanged: false, missingTools: [], doneReason: 'completed', ...over };
}

function passVerification(): VerificationResult {
  return { domain: 'code', overall: 'pass', checks: [{ name: 'typecheck', domain: 'code', status: 'pass' }], timestamp: 'now' };
}

function failVerification(detail = 'TS2322'): VerificationResult {
  return { domain: 'code', overall: 'fail', checks: [{ name: 'typecheck', domain: 'code', status: 'fail', detail }], timestamp: 'now' };
}

function skippedVerification(): VerificationResult {
  return { domain: 'code', overall: 'skip', checks: [{ name: 'typecheck', domain: 'code', status: 'skip' }], timestamp: 'now' };
}

describe('parsePlan', () => {
  it('parses a clean JSON object', () => {
    const plan = parsePlan('{"steps":[{"intent":"do a","verify":"code"},{"intent":"do b"}]}', 'task');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]).toMatchObject({ id: 1, intent: 'do a', verify: { kind: 'code' } });
    expect(plan.steps[1]).toMatchObject({ id: 2, intent: 'do b', verify: { kind: 'none' } });
  });

  it('tolerates markdown fences and surrounding prose', () => {
    const text = 'Sure! Here is the plan:\n```json\n{"steps":[{"intent":"only step"}]}\n```\nHope that helps.';
    const plan = parsePlan(text, 'task');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].intent).toBe('only step');
  });

  it('normalizes suggestedToolsets and drops empty intents', () => {
    const plan = parsePlan('{"steps":[{"intent":"keep","suggestedToolsets":["fs"," ",3]},{"intent":"  "}]}', 'task');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].suggestedToolsets).toEqual(['fs']);
  });

  it('falls back to a single whole-task step on garbage', () => {
    const plan = parsePlan('no json here at all', 'fix the build');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].intent).toBe('fix the build');
    expect(plan.steps[0].verify.kind).toBe('code');
  });

  it('falls back when steps array is empty', () => {
    const plan = parsePlan('{"steps":[]}', 'the task');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].intent).toBe('the task');
  });
});

describe('renderStepPrompt', () => {
  it('includes the overall task, the step, and prior progress', () => {
    const prompt = renderStepPrompt(step(2, { intent: 'wire the route' }), { task: 'build feature', priorSummary: 'Step 1: created file' });
    expect(prompt).toContain('Overall task: build feature');
    expect(prompt).toContain('Step: wire the route');
    expect(prompt).toContain('Progress so far:');
    expect(prompt).toContain('Step 1: created file');
  });

  it('omits the progress block on the first step', () => {
    const prompt = renderStepPrompt(step(1), { task: 't', priorSummary: '' });
    expect(prompt).not.toContain('Progress so far:');
  });

  it('injects usage hints when provided (Phase 3)', () => {
    const prompt = renderStepPrompt(step(1), { task: 't', priorSummary: '' }, ['- web_search: web_search({query})']);
    expect(prompt).toContain('Tool usage hints:');
    expect(prompt).toContain('web_search({query})');
  });

  it('omits the hints block when there are none', () => {
    const prompt = renderStepPrompt(step(1), { task: 't', priorSummary: '' }, []);
    expect(prompt).not.toContain('Tool usage hints:');
  });
});

describe('runConductor', () => {
  const twoStepPlanner = async (task: string): Promise<ConductorPlan> => ({
    task,
    steps: [step(1, { verify: { kind: 'code' } }), step(2, { verify: { kind: 'none' } })],
  });

  it('runs every planned step in order and reports completed', async () => {
    const seen: number[] = [];
    const executor: StepExecutor = async (s) => { seen.push(s.id); return okResult({ fileChanged: s.verify.kind === 'code' }); };
    const verifier: StepVerifier = async () => passVerification();

    const outcome = await runConductor({ task: 't', planner: twoStepPlanner, executor, verifier });

    expect(seen).toEqual([1, 2]);
    expect(outcome.status).toBe('completed');
    expect(outcome.stepResults).toHaveLength(2);
  });

  it('only calls the external verifier for code steps that changed files', async () => {
    const verified: number[] = [];
    const executor: StepExecutor = async (s) => okResult({ fileChanged: s.id === 1 });
    const verifier: StepVerifier = async (s) => { verified.push(s.id); return passVerification(); };

    await runConductor({ task: 't', planner: twoStepPlanner, executor, verifier });

    // Step 1 is code + changed → verified; step 2 is 'none' → skipped.
    expect(verified).toEqual([1]);
  });

  it('does not complete a code step that made no file change', async () => {
    const outcome = await runConductor({
      task: 't',
      planner: async (task) => ({ task, steps: [step(1, { verify: { kind: 'code' } })] }),
      executor: async () => okResult({ fileChanged: false }),
      verifier: async () => passVerification(),
      maxRemediationsPerStep: 0,
    });

    expect(outcome.status).toBe('completed_with_failures');
    expect(outcome.verifications[0]).toMatchObject({
      overall: 'fail',
      checks: [expect.objectContaining({ name: 'required_code_change', status: 'fail' })],
    });
  });

  it('verifies a verification-only code step without requiring another file change', async () => {
    const verifier = jest.fn(async () => passVerification());
    const outcome = await runConductor({
      task: 't',
      planner: async (task) => ({
        task,
        steps: [step(1, { verify: { kind: 'code' }, requiresChange: false })],
      }),
      executor: async () => okResult({ fileChanged: false }),
      verifier,
      maxRemediationsPerStep: 0,
    });

    expect(outcome.status).toBe('completed');
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(outcome.verifications).toEqual([expect.objectContaining({ overall: 'pass' })]);
  });

  it('does not treat skipped required verification as passing', async () => {
    const outcome = await runConductor({
      task: 't',
      planner: async (task) => ({ task, steps: [step(1, { verify: { kind: 'code' } })] }),
      executor: async () => okResult({ fileChanged: true }),
      verifier: async () => skippedVerification(),
      maxRemediationsPerStep: 0,
    });

    expect(outcome.status).toBe('completed_with_failures');
  });

  it('inserts a remediation step when verification fails, then passes', async () => {
    let calls = 0;
    const events: ConductorEvent[] = [];
    const executor: StepExecutor = async () => { calls++; return okResult({ fileChanged: true }); };
    // Fail the first verification, pass after the remediation step runs.
    let verifyCalls = 0;
    const verifier: StepVerifier = async () => { verifyCalls++; return verifyCalls === 1 ? failVerification() : passVerification(); };

    const outcome = await runConductor({
      task: 't',
      planner: async (task) => ({ task, steps: [step(1, { verify: { kind: 'code' } })] }),
      executor,
      verifier,
      onEvent: (e) => events.push(e),
    });

    // original step + 1 remediation = 2 executions
    expect(calls).toBe(2);
    expect(outcome.status).toBe('completed');
    expect(events.some((e) => e.type === 'remediation')).toBe(true);
  });

  it('stops remediating after the budget and reports completed_with_failures', async () => {
    let calls = 0;
    const executor: StepExecutor = async () => { calls++; return okResult({ fileChanged: true }); };
    const verifier: StepVerifier = async () => failVerification(); // always fails

    const outcome = await runConductor({
      task: 't',
      planner: async (task) => ({ task, steps: [step(1, { verify: { kind: 'code' } })] }),
      executor,
      verifier,
      maxRemediationsPerStep: 2,
    });

    // 1 original + 2 remediations = 3
    expect(calls).toBe(3);
    expect(outcome.status).toBe('completed_with_failures');
  });

  it('caps planned steps at maxSteps', async () => {
    const ran: number[] = [];
    const executor: StepExecutor = async (s) => { ran.push(s.id); return okResult(); };
    const planner = async (task: string): Promise<ConductorPlan> => ({
      task,
      steps: [step(1), step(2), step(3), step(4)],
    });

    await runConductor({ task: 't', planner, executor, verifier: async () => null, maxSteps: 2 });
    expect(ran).toEqual([1, 2]);
  });

  it('stops immediately when the abort signal is already set', async () => {
    const controller = new AbortController();
    controller.abort();
    const executor: StepExecutor = async () => okResult();

    const outcome = await runConductor({
      task: 't',
      planner: twoStepPlanner,
      executor,
      verifier: async () => null,
      abortSignal: controller.signal,
    });

    expect(outcome.status).toBe('stopped');
    expect(outcome.stepResults).toHaveLength(0);
  });

  it('persists plan.json under the run directory', async () => {
    const persistDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-'));
    try {
      await runConductor({
        task: 't',
        planner: twoStepPlanner,
        executor: async () => okResult(),
        verifier: async () => null,
        persistDir,
        runId: 'run-1',
      });
      const planJson = JSON.parse(await fs.readFile(path.join(persistDir, 'run-1', 'plan.json'), 'utf-8'));
      expect(planJson.steps).toHaveLength(2);
    } finally {
      await fs.rm(persistDir, { recursive: true, force: true });
    }
  });

  it('emits a capability gap once per missing tool and collects it (Phase 5)', async () => {
    const events: ConductorEvent[] = [];
    const executor: StepExecutor = async (s) =>
      okResult({ missingTools: s.id === 1 ? ['send_sms', 'send_sms'] : [] });

    const outcome = await runConductor({
      task: 't',
      planner: twoStepPlanner,
      executor,
      verifier: async () => null,
      onEvent: (e) => events.push(e),
    });

    const gapEvents = events.filter((e) => e.type === 'capability_gap');
    expect(gapEvents).toHaveLength(1);
    expect(outcome.capabilityGaps).toHaveLength(1);
    expect(outcome.capabilityGaps[0].need).toBe('send_sms');
    expect(outcome.capabilityGaps[0].reason).toContain('send_sms');
  });

  it('runs a natural-language task through tool execution and deterministic verification', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-acceptance-'));
    const artifactPath = path.join(projectDir, 'result.txt');
    const responses = [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'file_write', arguments: { content: 'verified output' } } }],
        },
      },
      { message: { role: 'assistant', content: 'Created and verified result.txt.' } },
    ];
    const client = { chat: jest.fn(async () => responses.shift()) };
    const fileWrite: Tool = {
      name: 'file_write',
      description: 'Write the requested result artifact.',
      parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
      isReadOnly: false,
      async execute(input) {
        await fs.writeFile(artifactPath, String(input.content), 'utf-8');
        return { success: true, output: `Wrote ${artifactPath}` };
      },
    };
    const task = 'Create a result file containing verified output';
    const contract = buildTaskContract(task);
    const config: LoopConfig = {
      model: 'stub',
      systemPrompt: 'Complete the task with tools.',
      maxTurns: 3,
      taskContract: contract,
      context: { enabled: false },
    };

    try {
      const outcome = await runConductor({
        task,
        planner: async () => ({
          task,
          steps: [step(1, { intent: task, verify: { kind: 'code' } })],
        }),
        executor: createQueryLoopExecutor(config, { client: client as never, tools: [fileWrite] }),
        verifier: async () => {
          const content = await fs.readFile(artifactPath, 'utf-8').catch(() => '');
          return content === 'verified output' ? passVerification() : failVerification('artifact content mismatch');
        },
      });

      expect(outcome.status).toBe('completed');
      expect(outcome.toolCallSequence).toEqual(['file_write']);
      expect(outcome.toolSuccessCount).toBe(1);
      await expect(fs.readFile(artifactPath, 'utf-8')).resolves.toBe('verified output');
      expect(outcome.verifications).toEqual([expect.objectContaining({ overall: 'pass' })]);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe('PLANNER_SYSTEM_PROMPT', () => {
  it('asks for a bare JSON object', () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain('"steps"');
    expect(PLANNER_SYSTEM_PROMPT).toContain('"requiresChange":false');
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/ONLY a JSON object/i);
  });
});
