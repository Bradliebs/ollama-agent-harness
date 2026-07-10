// Task Conductor — turns a single task into an explicit plan, runs each step
// through the existing queryLoop, and (Phase 4) verifies code steps by actually
// running tsc/lint/tests, self-correcting on failure instead of only reporting.
//
// Design: the orchestration core (runConductor) is provider-free and takes
// injectable seams (planner / executor / verifier) so it can be unit-tested
// without a live model or a real toolchain. The default factories at the bottom
// wire those seams to the real chat client, queryLoop, and verifyCode.
//
// Opt-in only: nothing here runs unless a caller invokes it (the CLI gates it
// behind HARNESS_CONDUCTOR=1). queryLoop's own signature is untouched.

import * as path from 'path';
import * as fs from 'fs/promises';
import type { Message } from 'ollama';
import type { IChatClient } from './chatClient';
import type { Tool } from '../types/tool';
import type { LoopConfig, LoopEvent } from '../types/loop';
import { queryLoop, type QueryLoopDeps } from './queryLoop';
import { verifyCode, type VerificationResult } from './doneStateVerifier';
import { planSurgicalRepairForChecks } from '../verification/critic';

// ─── Types ──────────────────────────────────────────────────────────

export interface ConductorStep {
  id: number;
  intent: string;
  suggestedToolsets: string[];
  /** `code` steps are verified by running the toolchain. */
  verify: { kind: 'code' | 'none' };
  /** Whether the step itself must successfully mutate a file. Defaults to true for code steps. */
  requiresChange?: boolean;
  done: boolean;
  /** Set when this step was inserted to fix a failed verification of step `id`. */
  remediationFor?: number;
}

export interface ConductorPlan {
  task: string;
  steps: ConductorStep[];
}

export interface StepContext {
  task: string;
  /** Brief running summary of what earlier steps did, for continuity. */
  priorSummary: string;
}

export interface StepResult {
  text: string;
  toolCallSequence: string[];
  toolCallCount: number;
  toolSuccessCount: number;
  /** True when a file-mutating tool (file_write / file_edit) succeeded. */
  fileChanged: boolean;
  /** Names of tools the model tried to call that are not in the tool pool. */
  missingTools: string[];
  doneReason: string;
}

/**
 * A capability the agent reached for but did not have. Surfaced as a first-class
 * request so the user can fill the gap (e.g. add an MCP server via the existing
 * user-gated flow) instead of the run silently dead-ending. The conductor never
 * acquires the capability itself — it only reports the need.
 */
export interface CapabilityGap {
  /** The tool / capability name the agent tried to use. */
  need: string;
  /** Why it was needed (which step intent triggered it). */
  reason: string;
}

export type Planner = (task: string) => Promise<ConductorPlan>;
export type StepExecutor = (step: ConductorStep, ctx: StepContext) => Promise<StepResult>;
/** Returns a verification result for a code step, or null when not applicable. */
export type StepVerifier = (step: ConductorStep) => Promise<VerificationResult | null>;

export type ConductorEvent =
  | { type: 'plan'; plan: ConductorPlan }
  | { type: 'step_start'; step: ConductorStep; index: number; total: number }
  | { type: 'step_result'; step: ConductorStep; result: StepResult }
  | { type: 'verify'; step: ConductorStep; result: VerificationResult }
  | { type: 'remediation'; failedStep: ConductorStep; attempt: number }
  | { type: 'capability_gap'; gap: CapabilityGap }
  | { type: 'done'; status: ConductorStatus; steps: number };

export type ConductorStatus = 'completed' | 'completed_with_failures' | 'stopped';

export interface ConductorOptions {
  task: string;
  planner: Planner;
  executor: StepExecutor;
  verifier: StepVerifier;
  /** Max remediation attempts per failing step before giving up. Default 2. */
  maxRemediationsPerStep?: number;
  /** When set, plan.json / result.json are written under `<persistDir>/<runId>/`. */
  persistDir?: string;
  runId?: string;
  /** Hard cap on planned steps actually executed (excludes remediations). Default 12. */
  maxSteps?: number;
  abortSignal?: AbortSignal;
  onEvent?: (e: ConductorEvent) => void;
}

export interface ConductorOutcome {
  plan: ConductorPlan;
  status: ConductorStatus;
  stepResults: StepResult[];
  verifications: VerificationResult[];
  capabilityGaps: CapabilityGap[];
  toolCallSequence: string[];
  toolCallCount: number;
  toolSuccessCount: number;
  assistantText: string;
}

// ─── Orchestrator ───────────────────────────────────────────────────

/**
 * Run a task as plan → per-step execute → verify → self-correct.
 * Provider-free: all model/toolchain interaction is injected via planner,
 * executor and verifier. Degrades safely — a planner that returns one step
 * reduces this to a single queryLoop run (today's behaviour).
 */
export async function runConductor(options: ConductorOptions): Promise<ConductorOutcome> {
  const { task, planner, executor, verifier } = options;
  const maxRemediations = options.maxRemediationsPerStep ?? 2;
  const maxSteps = options.maxSteps ?? 12;
  const emit = options.onEvent ?? (() => {});

  const plan = await planner(task);
  if (plan.steps.length > maxSteps) plan.steps = plan.steps.slice(0, maxSteps);
  emit({ type: 'plan', plan });
  if (options.persistDir) {
    await writeJson(options.persistDir, options.runId, 'plan.json', plan);
  }

  const stepResults: StepResult[] = [];
  const verifications: VerificationResult[] = [];
  const capabilityGaps: CapabilityGap[] = [];
  const seenGaps = new Set<string>();
  const toolCallSequence: string[] = [];
  let toolCallCount = 0;
  let toolSuccessCount = 0;
  const texts: string[] = [];
  let exhaustedFailure = false;

  // Remediation steps are spliced in right after the step they fix, so a flat
  // index walk handles both planned and inserted steps in order.
  const queue = [...plan.steps];
  let i = 0;
  while (i < queue.length) {
    if (options.abortSignal?.aborted) {
      emit({ type: 'done', status: 'stopped', steps: stepResults.length });
      return finalize(plan, 'stopped');
    }
    const step = queue[i];
    emit({ type: 'step_start', step, index: i, total: queue.length });

    const ctx: StepContext = { task, priorSummary: buildPriorSummary(stepResults) };
    const result = await executor(step, ctx);
    stepResults.push(result);
    toolCallSequence.push(...result.toolCallSequence);
    toolCallCount += result.toolCallCount;
    toolSuccessCount += result.toolSuccessCount;
    if (result.text.trim()) texts.push(result.text.trim());
    emit({ type: 'step_result', step, result });

    // Phase 5 — surface capabilities the agent reached for but lacked, once
    // each, as a first-class request instead of letting the run dead-end.
    for (const need of result.missingTools) {
      if (seenGaps.has(need)) continue;
      seenGaps.add(need);
      const gap: CapabilityGap = { need, reason: `Step ${step.id} ("${step.intent}") tried to use "${need}", which is not available.` };
      capabilityGaps.push(gap);
      emit({ type: 'capability_gap', gap });
    }

    let verifyPassed = true;
    if (step.verify.kind === 'code') {
      const changeRequired = step.requiresChange !== false;
      const verification = !changeRequired || result.fileChanged
        ? await verifier(step) ?? failedCodeVerification('No verifier result was produced for a required code step.')
        : failedCodeVerification('The code step completed without a successful file mutation.');
      verifications.push(verification);
      emit({ type: 'verify', step, result: verification });
      verifyPassed = verification.overall === 'pass';
    }

    if (!verifyPassed) {
      const priorAttempts = queue.filter((s) => s.remediationFor === step.id).length;
      if (priorAttempts < maxRemediations) {
        queue.splice(i + 1, 0, {
          id: step.id,
          intent: buildRemediationIntent(verifications),
          suggestedToolsets: step.suggestedToolsets,
          verify: step.verify,
          requiresChange: step.requiresChange,
          done: false,
          remediationFor: step.id,
        });
        emit({ type: 'remediation', failedStep: step, attempt: priorAttempts + 1 });
      } else {
        // Remediation budget spent — stop hiding the failure.
        exhaustedFailure = true;
      }
    }

    step.done = true;
    i++;
  }

  const status: ConductorStatus = exhaustedFailure ? 'completed_with_failures' : 'completed';
  emit({ type: 'done', status, steps: stepResults.length });
  return finalize(plan, status);

  function finalize(p: ConductorPlan, s: ConductorStatus): ConductorOutcome {
    const outcome: ConductorOutcome = {
      plan: p,
      status: s,
      stepResults,
      verifications,
      capabilityGaps,
      toolCallSequence,
      toolCallCount,
      toolSuccessCount,
      assistantText: texts.join('\n\n'),
    };
    if (options.persistDir) {
      // Fire-and-forget; persistence failure must not fail the run.
      void writeJson(options.persistDir, options.runId, 'result.json', {
        status: s,
        steps: p.steps,
        verifications,
        capabilityGaps,
      }).catch(() => {});
    }
    return outcome;
  }
}

function failedCodeVerification(detail: string): VerificationResult {
  return {
    domain: 'code',
    overall: 'fail',
    checks: [{ name: 'required_code_change', domain: 'code', status: 'fail', detail }],
    timestamp: new Date().toISOString(),
  };
}

// ─── Plan parsing ───────────────────────────────────────────────────

export const PLANNER_SYSTEM_PROMPT = [
  'You are a planning assistant. Break the user\'s task into a short ordered list',
  'of concrete steps an autonomous coding agent will execute one at a time.',
  '',
  'Rules:',
  '- 1 to 8 steps. Fewer is better. Each step is a single coherent unit of work.',
  '- Mark a step with "verify":"code" when it writes or edits source code that',
  '  can be typechecked or tested, or when the step explicitly runs code verification.',
  '- Set "requiresChange":false for verification-only steps that run tests or checks',
  '  without editing files. Code-editing steps default to true.',
  '- Otherwise use "verify":"none".',
  '- suggestedToolsets is an optional hint (e.g. ["filesystem"], ["web"]).',
  '',
  'Respond with ONLY a JSON object, no prose, no markdown fences:',
  '{"steps":[{"intent":"...","suggestedToolsets":["filesystem"],"verify":"code","requiresChange":true}]}',
].join('\n');

/**
 * Parse a planner model response into a normalized plan. Tolerant of markdown
 * fences and surrounding prose. Falls back to a single step (the whole task)
 * when no usable JSON is found, so the conductor degrades to one queryLoop run.
 */
export function parsePlan(text: string, task: string): ConductorPlan {
  const raw = extractJsonObject(text);
  if (raw) {
    try {
      const obj = JSON.parse(raw) as { steps?: unknown };
      const arr = Array.isArray(obj.steps) ? obj.steps : [];
      const steps: ConductorStep[] = [];
      for (const entry of arr) {
        const e = entry as Record<string, unknown>;
        const intent = typeof e.intent === 'string' ? e.intent.trim() : '';
        if (!intent) continue;
        steps.push({
          id: steps.length + 1,
          intent,
          suggestedToolsets: normalizeToolsets(e.suggestedToolsets),
          verify: { kind: e.verify === 'code' ? 'code' : 'none' },
          requiresChange: typeof e.requiresChange === 'boolean' ? e.requiresChange : undefined,
          done: false,
        });
      }
      if (steps.length > 0) return { task, steps };
    } catch {
      // fall through to single-step fallback
    }
  }
  return singleStepPlan(task);
}

function singleStepPlan(task: string): ConductorPlan {
  return {
    task,
    steps: [{ id: 1, intent: task, suggestedToolsets: [], verify: { kind: 'code' }, done: false }],
  };
}

function normalizeToolsets(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
}

/** Extract the first balanced `{...}` block from arbitrary model text. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ─── Helpers ────────────────────────────────────────────────────────

function buildPriorSummary(results: StepResult[]): string {
  if (results.length === 0) return '';
  return results
    .map((r, idx) => `Step ${idx + 1}: ${firstLine(r.text) || `${r.toolCallCount} tool call(s)`}`)
    .join('\n');
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 200 ? line.slice(0, 200) + '…' : line;
}

function lastFailureDetail(verifications: VerificationResult[]): string {
  const last = verifications[verifications.length - 1];
  if (!last) return '(no detail captured)';
  const failed = last.checks.filter((c) => c.status === 'fail');
  if (failed.length === 0) return '(verification failed without a specific check)';
  return failed.map((c) => `${c.name}: ${c.detail ?? 'failed'}`).join('\n').slice(0, 1500);
}

// HARNESS_SURGICAL_CRITIC=1 swaps the generic "diagnose and fix it" prompt for
// a focused critic prompt that names the failing checks and the passing ones
// to leave alone. Default (env unset) keeps the legacy intent byte-identical.
function buildRemediationIntent(verifications: VerificationResult[]): string {
  const last = verifications[verifications.length - 1];
  if (process.env.HARNESS_SURGICAL_CRITIC === '1' && last) {
    const plan = planSurgicalRepairForChecks(last.checks);
    return `A verification check failed after the previous step. ${plan.prompt}`;
  }
  return `A verification check failed after the previous step. Diagnose and fix it. Failure detail:\n${lastFailureDetail(verifications)}`;
}

async function writeJson(persistDir: string, runId: string | undefined, name: string, data: unknown): Promise<void> {
  const dir = path.join(persistDir, runId ?? 'run');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Default factories (wire the seams to real infrastructure) ───────

/** Planner backed by a single chat call to the model (no tool execution). */
export function createLlmPlanner(client: IChatClient): Planner {
  return async (task: string): Promise<ConductorPlan> => {
    try {
      const res = await client.chatOnce(
        [
          { role: 'system', content: PLANNER_SYSTEM_PROMPT },
          { role: 'user', content: task },
        ],
      );
      const content = typeof res.message.content === 'string' ? res.message.content : '';
      return parsePlan(content, task);
    } catch {
      return parsePlan('', task);
    }
  };
}

/**
 * Step executor that runs one queryLoop turn-budget per step, framing the step
 * as the user message over the caller's base config (which already carries the
 * harness system prompt + any mycelium context).
 *
 * Phase 2 (tool shortlisting): when `selectTools` is provided, it is called per
 * step to narrow the tool set exposed to the model. Returning `undefined` keeps
 * the full set (the safe default). Remediation steps should receive the full
 * set — escalation — which the caller's selector handles by inspecting
 * `step.remediationFor`.
 *
 * Phase 3 (usage hints): any shortlisted tool carrying a `usageHint` has it
 * injected into the step prompt, so the model sees how to call the tools that
 * were actually selected without bloating the default prompt.
 */
export function createQueryLoopExecutor(
  baseConfig: LoopConfig,
  deps: QueryLoopDeps,
  opts: {
    onLoopEvent?: (e: LoopEvent) => void;
    selectTools?: (step: ConductorStep) => Tool[] | undefined;
  } = {},
): StepExecutor {
  const { onLoopEvent, selectTools } = opts;
  return async (step, ctx): Promise<StepResult> => {
    const shortlisted = selectTools?.(step);
    const effectiveDeps: QueryLoopDeps = shortlisted ? { ...deps, tools: shortlisted } : deps;
    const hints = collectUsageHints(shortlisted);

    const messages: Message[] = [{ role: 'user', content: renderStepPrompt(step, ctx, hints) }];
    let text = '';
    let toolCallCount = 0;
    let toolSuccessCount = 0;
    let fileChanged = false;
    let doneReason = 'completed';
    const toolCallSequence: string[] = [];
    const missingTools: string[] = [];

    for await (const event of queryLoop(baseConfig, effectiveDeps, messages)) {
      onLoopEvent?.(event);
      switch (event.type) {
        case 'text':
          text += event.content;
          break;
        case 'tool_call':
          toolCallSequence.push(event.call.name);
          break;
        case 'tool_result':
          toolCallCount++;
          if (event.result.success) {
            toolSuccessCount++;
            if (event.call.name === 'file_write' || event.call.name === 'file_edit') fileChanged = true;
          } else if (isMissingToolError(event.result.error ?? event.result.output)) {
            missingTools.push(event.call.name);
          }
          break;
        case 'done':
          doneReason = event.reason;
          break;
      }
    }
    return { text, toolCallSequence, toolCallCount, toolSuccessCount, fileChanged, missingTools, doneReason };
  };
}

/** The dispatcher reports an unknown tool with this signature. */
function isMissingToolError(detail: string | undefined): boolean {
  return typeof detail === 'string' && /not found in tool pool|unknown tool/i.test(detail);
}

/** Collect usage hints from shortlisted tools, deduped and bounded. */
function collectUsageHints(tools: Tool[] | undefined): string[] {
  if (!tools) return [];
  const seen = new Set<string>();
  const hints: string[] = [];
  for (const t of tools) {
    if (t.usageHint && !seen.has(t.name)) {
      seen.add(t.name);
      hints.push(`- ${t.name}: ${t.usageHint}`);
    }
  }
  return hints;
}

export function renderStepPrompt(step: ConductorStep, ctx: StepContext, usageHints: string[] = []): string {
  const parts = [
    `Overall task: ${ctx.task}`,
    '',
    `You are completing ONE step of a multi-step plan. Do only this step; do not start later steps.`,
    `Step: ${step.intent}`,
  ];
  if (ctx.priorSummary) {
    parts.push('', 'Progress so far:', ctx.priorSummary);
  }
  if (usageHints.length > 0) {
    parts.push('', 'Tool usage hints:', ...usageHints);
  }
  parts.push('', 'When the step is complete, state briefly what you did.');
  return parts.join('\n');
}

/** Verifier that runs the real toolchain (tsc / lint / tests) for code steps. */
export function createCodeVerifier(projectDir: string, opts?: { quick?: boolean; timeout?: number }): StepVerifier {
  return async (step): Promise<VerificationResult | null> => {
    if (step.verify.kind !== 'code') return null;
    return verifyCode({ projectDir, quick: opts?.quick ?? false, timeout: opts?.timeout ?? 60_000 });
  };
}
