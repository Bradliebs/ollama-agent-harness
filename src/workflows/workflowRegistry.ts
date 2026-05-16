// Workflow runner v1.
//
// Workflows are declarative tool-call sequences stored under
// `.harness/workflows/<name>.{yaml,json}`. The runner executes one step at a
// time, runs against the live tool registry + permission engine, and supports
// dry-run, pause, resume, and cancel.
//
// Run state is persisted to `.harness/workflows/runs/<runId>.json` on every
// state transition (start, pause, resume, cancel, per-step settle, terminal
// status). Writes go through `withFileLock` + `atomicWriteFile` so two
// concurrent transitions on the same run cannot lose each other. On
// `restoreRuns()` any run found in `running` or `pending` status is demoted
// to `failed` with a recovery note — tool side effects are not idempotent so
// we never auto-resume an in-flight run.

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../core/logger';
import type { PermissionEngine } from '../permissions/engine';
import { atomicWriteFile, withFileLock } from '../persistence/atomicFile';
import { runtimeTracer } from '../core/tracing';
import type { Tool, ToolResult } from '../types';

export type WorkflowRiskLevel = 'low' | 'medium' | 'high';
export type WorkflowRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'denied';

export interface WorkflowStep {
  id: string;
  tool: string;
  input?: Record<string, unknown>;
  description?: string;
  /** When true, a failure does not abort the run. */
  continueOnError?: boolean;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  riskLevel?: WorkflowRiskLevel;
  variables?: Record<string, unknown>;
  steps: WorkflowStep[];
  filePath: string;
}

export interface WorkflowStepExecution {
  step: WorkflowStep;
  status: WorkflowStepStatus;
  startedAt?: string;
  finishedAt?: string;
  result?: ToolResult;
  resolvedInput?: Record<string, unknown>;
  permissionReason?: string;
  error?: string;
  /** True when this step was simulated rather than executed. */
  dryRun?: boolean;
}

export interface WorkflowRun {
  id: string;
  workflowName: string;
  status: WorkflowRunStatus;
  dryRun: boolean;
  startedAt: string;
  finishedAt?: string;
  variables: Record<string, unknown>;
  steps: WorkflowStepExecution[];
  currentStepIndex: number;
  cancelReason?: string;
  pauseReason?: string;
}

export interface WorkflowRunDeps {
  tools: Tool[];
  permissions: PermissionEngine;
}

export class WorkflowRegistry {
  private runs = new Map<string, WorkflowRun>();
  private signals = new Map<string, { paused: boolean; cancelled: boolean }>();
  // Tracks in-flight `persistRun` promises kicked off by the synchronous
  // mutator methods (`startRun`, `pause`, `resume`, `cancel`). Tests and the
  // server's shutdown path call `flush()` to drain these before teardown so a
  // late rename does not race a directory removal.
  private pendingPersists = new Set<Promise<void>>();

  constructor(private workflowsDir: string) {}

  // Wait for every persist-write currently in-flight to settle. Always
  // resolves — individual write failures are handled inside `persistRun`.
  async flush(): Promise<void> {
    if (this.pendingPersists.size === 0) return;
    await Promise.allSettled(Array.from(this.pendingPersists));
  }

  private trackPersist(run: WorkflowRun): void {
    const promise = this.persistRun(run).finally(() => {
      this.pendingPersists.delete(promise);
    });
    this.pendingPersists.add(promise);
  }

  private runsDir(): string {
    return path.join(this.workflowsDir, 'runs');
  }

  private runFilePath(id: string): string {
    return path.join(this.runsDir(), `${id}.json`);
  }

  // Persistence is best-effort: a write failure must not crash the run. The
  // in-memory state remains authoritative for the rest of the current
  // process; the next successful write will catch the persisted snapshot up.
  private async persistRun(run: WorkflowRun): Promise<void> {
    try {
      await fs.mkdir(this.runsDir(), { recursive: true });
      const filePath = this.runFilePath(run.id);
      await withFileLock(filePath, async () => {
        // Snapshot inside the lock so a concurrent in-memory mutation cannot
        // produce a torn JSON document on disk.
        const snapshot = JSON.stringify(run, null, 2);
        await atomicWriteFile(filePath, snapshot, { encoding: 'utf-8' });
      });
    } catch (error) {
      logger.warn('Workflow', 'Failed to persist workflow run', {
        runId: run.id, error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Load every persisted run into memory. Runs found in `running` (the server
  // exited mid-step) or `pending` (server exited before execute() began) are
  // demoted to `failed` and re-persisted so the next restore is idempotent.
  // Returns counts for the startup log.
  async restoreRuns(): Promise<{ restored: number; demoted: number }> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.runsDir());
    } catch {
      return { restored: 0, demoted: 0 };
    }
    let restored = 0;
    let demoted = 0;
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const filePath = path.join(this.runsDir(), name);
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as WorkflowRun;
        if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string' || !Array.isArray(parsed.steps)) {
          logger.warn('Workflow', 'Skipping malformed run file', { file: name });
          continue;
        }
        let wasDemoted = false;
        if (parsed.status === 'running' || parsed.status === 'pending') {
          const recoveryNote = 'Server exited while workflow run was in progress; not auto-resumed.';
          for (const step of parsed.steps) {
            if (step.status === 'running') {
              step.status = 'failed';
              step.error = step.error ?? recoveryNote;
              step.finishedAt = step.finishedAt ?? new Date().toISOString();
            }
          }
          parsed.status = 'failed';
          parsed.finishedAt = parsed.finishedAt ?? new Date().toISOString();
          demoted += 1;
          wasDemoted = true;
        }
        this.runs.set(parsed.id, parsed);
        // Restored runs are inert — no executor is bound to their signal. A
        // future resume() call would currently fail because the signal entry
        // is only honoured by an in-process execute(). That is correct for
        // v1: restored runs are visible for inspection only.
        this.signals.set(parsed.id, { paused: parsed.status === 'paused', cancelled: false });
        restored += 1;
        if (wasDemoted) {
          // Re-persist the demoted state so the next restore is idempotent.
          await this.persistRun(parsed);
        }
      } catch (error) {
        logger.warn('Workflow', 'Failed to restore workflow run', {
          file: name, error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { restored, demoted };
  }

  async list(): Promise<WorkflowDefinition[]> {
    let entries: string[] = [];
    try { entries = await fs.readdir(this.workflowsDir); } catch { return []; }
    const defs: WorkflowDefinition[] = [];
    for (const name of entries) {
      if (!/\.(ya?ml|json)$/i.test(name)) continue;
      try {
        const def = await this.loadFile(path.join(this.workflowsDir, name));
        if (def) defs.push(def);
      } catch (error) {
        logger.warn('Workflow', 'Failed to load workflow', { name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return defs.sort((a, b) => a.name.localeCompare(b.name));
  }

  async load(name: string): Promise<WorkflowDefinition | null> {
    for (const ext of ['.yaml', '.yml', '.json']) {
      const filePath = path.join(this.workflowsDir, name + ext);
      try {
        const def = await this.loadFile(filePath);
        if (def) return def;
      } catch { /* try next extension */ }
    }
    return null;
  }

  private async loadFile(filePath: string): Promise<WorkflowDefinition | null> {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = filePath.endsWith('.json') ? JSON.parse(raw) : parseSimpleYaml(raw);
    return normalizeDefinition(parsed, filePath);
  }

  startRun(definition: WorkflowDefinition, options: { dryRun?: boolean; variables?: Record<string, unknown> } = {}): WorkflowRun {
    const id = `run-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const variables = { ...(definition.variables ?? {}), ...(options.variables ?? {}) };
    const run: WorkflowRun = {
      id,
      workflowName: definition.name,
      status: 'pending',
      dryRun: Boolean(options.dryRun),
      startedAt: new Date().toISOString(),
      variables,
      steps: definition.steps.map((step) => ({ step, status: 'pending' })),
      currentStepIndex: 0,
    };
    this.runs.set(id, run);
    this.signals.set(id, { paused: false, cancelled: false });
    // Fire-and-forget tracked persist: `flush()` will await it on shutdown.
    // persistRun is internally try/catch so the failure mode is a warn-log,
    // never an unhandled rejection. Awaiting here would block the synchronous
    // startRun contract callers rely on.
    this.trackPersist(run);
    return run;
  }

  getRun(id: string): WorkflowRun | undefined {
    return this.runs.get(id);
  }

  listRuns(): WorkflowRun[] {
    return Array.from(this.runs.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  pause(id: string, reason?: string): boolean {
    const signal = this.signals.get(id);
    const run = this.runs.get(id);
    if (!signal || !run) return false;
    // Allow pre-pausing a pending run so the caller can choose when to begin
    // executing it. Re-pausing an already paused run is a no-op success.
    if (run.status !== 'running' && run.status !== 'pending' && run.status !== 'paused') return false;
    signal.paused = true;
    run.pauseReason = reason;
    if (run.status === 'pending') run.status = 'paused';
    this.trackPersist(run);
    return true;
  }

  resume(id: string): boolean {
    const signal = this.signals.get(id);
    const run = this.runs.get(id);
    if (!signal || !run) return false;
    if (run.status !== 'paused') return false;
    signal.paused = false;
    run.pauseReason = undefined;
    this.trackPersist(run);
    return true;
  }

  cancel(id: string, reason?: string): boolean {
    const signal = this.signals.get(id);
    const run = this.runs.get(id);
    if (!signal || !run) return false;
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return false;
    signal.cancelled = true;
    signal.paused = false;
    run.cancelReason = reason;
    this.trackPersist(run);
    return true;
  }

  async execute(runId: string, deps: WorkflowRunDeps): Promise<WorkflowRun> {
    const run = this.runs.get(runId);
    const signal = this.signals.get(runId);
    if (!run || !signal) throw new Error(`Unknown workflow run: ${runId}`);
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return run;
    if (signal.paused) {
      run.status = 'paused';
      runtimeTracer.recordEvent('workflow.run_paused', { runId });
      await this.persistRun(run);
      return run;
    }
    run.status = 'running';
    runtimeTracer.recordEvent('workflow.run_started', { runId, workflow: run.workflowName, dryRun: run.dryRun });
    await this.persistRun(run);

    while (run.currentStepIndex < run.steps.length) {
      if (signal.cancelled) {
        run.status = 'cancelled';
        run.finishedAt = new Date().toISOString();
        runtimeTracer.recordEvent('workflow.run_cancelled', { runId, reason: run.cancelReason });
        await this.persistRun(run);
        return run;
      }
      if (signal.paused) {
        run.status = 'paused';
        runtimeTracer.recordEvent('workflow.run_paused', { runId });
        await this.persistRun(run);
        return run;
      }
      const stepExecution = run.steps[run.currentStepIndex];
      try {
        await this.runStep(run, stepExecution, deps);
      } catch (error) {
        // Preserve a more specific status (e.g. 'denied') if runStep already set
        // it; otherwise fall back to 'failed'.
        if (stepExecution.status === 'pending' || stepExecution.status === 'running') {
          stepExecution.status = 'failed';
        }
        if (!stepExecution.error) stepExecution.error = error instanceof Error ? error.message : String(error);
        if (!stepExecution.finishedAt) stepExecution.finishedAt = new Date().toISOString();
        if (!stepExecution.step.continueOnError) {
          run.status = 'failed';
          run.finishedAt = new Date().toISOString();
          runtimeTracer.recordEvent('workflow.run_failed', { runId, step: stepExecution.step.id, error: stepExecution.error });
          await this.persistRun(run);
          return run;
        }
      }
      run.currentStepIndex++;
      // Persist after each step settles so a crash mid-loop doesn't lose the
      // record of which step ran last. The next-step write would catch the
      // index up otherwise, but the run-level summary should stay current.
      await this.persistRun(run);
    }

    run.status = 'completed';
    run.finishedAt = new Date().toISOString();
    runtimeTracer.recordEvent('workflow.run_completed', { runId, steps: run.steps.length });
    await this.persistRun(run);
    return run;
  }

  private async runStep(run: WorkflowRun, execution: WorkflowStepExecution, deps: WorkflowRunDeps): Promise<void> {
    execution.status = 'running';
    execution.startedAt = new Date().toISOString();
    const resolvedInput = substituteVariables(execution.step.input ?? {}, run.variables);
    execution.resolvedInput = resolvedInput;

    const tool = deps.tools.find((candidate) => candidate.name === execution.step.tool);
    if (!tool) {
      execution.status = 'failed';
      execution.error = `Unknown tool: ${execution.step.tool}`;
      execution.finishedAt = new Date().toISOString();
      throw new Error(execution.error);
    }

    const permission = deps.permissions.evaluate({ name: tool.name, input: resolvedInput });
    execution.permissionReason = permission.reason;
    if (permission.decision === 'deny') {
      execution.status = 'denied';
      execution.error = permission.reason;
      execution.finishedAt = new Date().toISOString();
      runtimeTracer.recordEvent('workflow.step_denied', { runId: run.id, step: execution.step.id, reason: permission.reason });
      if (!execution.step.continueOnError) throw new Error(permission.reason ?? 'Tool denied by permission engine');
      return;
    }

    if (run.dryRun) {
      execution.dryRun = true;
      execution.result = { success: true, output: `[dry-run] would call ${tool.name}` };
      execution.status = 'completed';
      execution.finishedAt = new Date().toISOString();
      runtimeTracer.recordEvent('workflow.step_dry_run', { runId: run.id, step: execution.step.id, tool: tool.name });
      return;
    }

    if (permission.decision === 'ask') {
      // Workflow runner does not interactively prompt — treat 'ask' as denied
      // to keep batch execution deterministic.
      execution.status = 'denied';
      execution.error = 'Permission engine requested approval; workflow runner cannot prompt.';
      execution.finishedAt = new Date().toISOString();
      if (!execution.step.continueOnError) throw new Error(execution.error);
      return;
    }

    try {
      execution.result = await tool.execute(resolvedInput);
      execution.status = execution.result.success ? 'completed' : 'failed';
      if (!execution.result.success && !execution.step.continueOnError) {
        execution.error = execution.result.error || execution.result.output;
        throw new Error(execution.error);
      }
    } finally {
      execution.finishedAt = new Date().toISOString();
    }
  }
}

function normalizeDefinition(parsed: Record<string, unknown>, filePath: string): WorkflowDefinition | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const name = typeof parsed.name === 'string' && parsed.name.trim()
    ? parsed.name.trim()
    : path.basename(filePath).replace(/\.(ya?ml|json)$/i, '');
  const stepsRaw = Array.isArray(parsed.steps) ? parsed.steps as unknown[] : [];
  const steps: WorkflowStep[] = [];
  for (let i = 0; i < stepsRaw.length; i++) {
    const raw = stepsRaw[i] as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') continue;
    const tool = typeof raw.tool === 'string' ? raw.tool : '';
    if (!tool) continue;
    steps.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : `step-${i + 1}`,
      tool,
      input: typeof raw.input === 'object' && raw.input !== null ? raw.input as Record<string, unknown> : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      continueOnError: Boolean(raw.continue_on_error ?? raw.continueOnError),
    });
  }
  if (steps.length === 0) return null;
  const riskRaw = typeof parsed.risk_level === 'string' ? parsed.risk_level.toLowerCase() : (typeof parsed.riskLevel === 'string' ? parsed.riskLevel.toLowerCase() : '');
  const riskLevel: WorkflowRiskLevel | undefined = riskRaw === 'low' || riskRaw === 'medium' || riskRaw === 'high' ? riskRaw : undefined;
  return {
    name,
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    riskLevel,
    variables: typeof parsed.variables === 'object' && parsed.variables !== null ? parsed.variables as Record<string, unknown> : undefined,
    steps,
    filePath,
  };
}

function substituteVariables(input: Record<string, unknown>, variables: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input, (_, value) => {
    if (typeof value !== 'string') return value;
    return value.replace(/\$\{variables\.([a-zA-Z0-9_]+)\}/g, (_match, key) => {
      const replacement = variables[key];
      return replacement === undefined || replacement === null ? '' : String(replacement);
    });
  }));
}

// Minimal YAML subset parser sufficient for workflow definitions:
//   key: value
//   key:
//     - item
//     - item
//   key:
//     subkey: value
function parseSimpleYaml(content: string): Record<string, unknown> {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; container: Record<string, unknown> | unknown[] }> = [{ indent: -1, container: root }];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];
    const line = rawLine.trim();
    if (line.startsWith('- ')) {
      if (!Array.isArray(top.container)) continue;
      const value = line.slice(2).trim();
      if (value.includes(':')) {
        const item: Record<string, unknown> = {};
        top.container.push(item);
        const [k, v] = splitYamlKv(value);
        if (k) item[k] = parseScalar(v);
        stack.push({ indent, container: item });
      } else {
        top.container.push(parseScalar(value));
      }
      continue;
    }
    const [key, value] = splitYamlKv(line);
    if (!key) continue;
    if (Array.isArray(top.container)) continue;
    if (value === '') {
      // peek ahead for list vs object
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const next = j < lines.length ? lines[j] : '';
      const nextIndent = next.length - next.trimStart().length;
      const isList = next.trim().startsWith('- ') && nextIndent > indent;
      const container: Record<string, unknown> | unknown[] = isList ? [] : {};
      top.container[key] = container;
      stack.push({ indent, container });
    } else {
      top.container[key] = parseScalar(value);
    }
  }

  return root;
}

function splitYamlKv(line: string): [string, string] {
  const idx = line.indexOf(':');
  if (idx === -1) return ['', ''];
  return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
}

function parseScalar(value: string): unknown {
  if (value === '') return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d*\.\d+$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
