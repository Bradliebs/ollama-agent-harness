// Triggers: lightweight polling that runs scripts on a short interval and
// emits any non-empty stdout as a `trigger.message` event. The model is NOT
// invoked — exit-0 with output means "something happened, deliver this as a
// channel message". Exit non-zero means "nothing happened" and the trigger
// stays silent.
//
// Trigger envelope (`.harness/triggers/triggers.json`):
//
//   {
//     "version": 1,
//     "triggers": [
//       { "id": "email-poll", "command": "node", "args": ["scripts/check-email.js"], "intervalSeconds": 30, "enabled": true }
//     ]
//   }
//
// Built-in safeguards:
//   - Minimum interval clamp (5s) per trigger.
//   - Output cap (4KB) per run.
//   - Per-trigger concurrency guard (skip tick if previous run still in flight).
//   - Startup cooldown (30s) so triggers don't all fire at boot.
//
// Reads support a legacy v1 bare-array form: `[{ ... }]` becomes
// `{ version: 1, triggers: [{ ... }] }` automatically.

import { spawn } from 'node:child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../core/logger';
import { emitEvent } from '../persistence/eventStore';

export interface TriggerDefinition {
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  intervalSeconds: number;
  enabled?: boolean;
}

export interface TriggerEnvelope {
  version: 1;
  triggers: TriggerDefinition[];
}

export interface TriggerSchedulerOptions {
  projectDir: string;
  /** Tick interval in ms (default 1000). Tests override. */
  tickMs?: number;
  /** Startup cooldown in ms (default 30_000). */
  startupCooldownMs?: number;
  /** Output cap per run in bytes (default 4096). */
  outputCapBytes?: number;
  /** Returns true when the kill switch is engaged. */
  isKillSwitchActive(): boolean;
  /** Returns true when triggers are globally enabled. */
  isEnabled(): boolean;
  /**
   * Optional override of the spawn function for testing. When present, it is
   * called instead of the real spawn. Must yield { exitCode, stdout, stderr }.
   */
  spawn?: TriggerSpawnFn;
}

export interface TriggerExecutionResult {
  triggerId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export type TriggerSpawnFn = (definition: TriggerDefinition, cwd: string) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

const DEFAULT_TICK_MS = 1000;
const DEFAULT_STARTUP_COOLDOWN_MS = 30_000;
const DEFAULT_OUTPUT_CAP = 4096;
const MIN_INTERVAL_SECONDS = 5;

function triggersFilePath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'triggers', 'triggers.json');
}

export async function loadTriggers(projectDir: string): Promise<TriggerDefinition[]> {
  const fp = triggersFilePath(projectDir);
  let raw: string;
  try {
    raw = await fs.readFile(fp, 'utf-8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return normalizeEnvelope(parsed).triggers;
}

export async function saveTriggers(projectDir: string, triggers: TriggerDefinition[]): Promise<void> {
  const fp = triggersFilePath(projectDir);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  const envelope: TriggerEnvelope = { version: 1, triggers };
  await fs.writeFile(fp, JSON.stringify(envelope, null, 2), 'utf-8');
}

export function normalizeEnvelope(value: unknown): TriggerEnvelope {
  if (Array.isArray(value)) return { version: 1, triggers: value.filter(isTriggerLike) };
  if (value && typeof value === 'object') {
    const env = value as Partial<TriggerEnvelope>;
    if (Array.isArray(env.triggers)) {
      return { version: 1, triggers: env.triggers.filter(isTriggerLike) };
    }
  }
  return { version: 1, triggers: [] };
}

function isTriggerLike(value: unknown): value is TriggerDefinition {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.command === 'string' && typeof v.intervalSeconds === 'number';
}

export class TriggerScheduler {
  private timer: NodeJS.Timeout | null = null;
  private startedAtMs = 0;
  private lastRunMs: Map<string, number> = new Map();
  private inflight: Set<string> = new Set();
  private opts: Required<Omit<TriggerSchedulerOptions, 'spawn'>> & { spawn?: TriggerSpawnFn };

  constructor(opts: TriggerSchedulerOptions) {
    this.opts = {
      projectDir: opts.projectDir,
      tickMs: opts.tickMs ?? DEFAULT_TICK_MS,
      startupCooldownMs: opts.startupCooldownMs ?? DEFAULT_STARTUP_COOLDOWN_MS,
      outputCapBytes: opts.outputCapBytes ?? DEFAULT_OUTPUT_CAP,
      isKillSwitchActive: opts.isKillSwitchActive,
      isEnabled: opts.isEnabled,
      spawn: opts.spawn,
    };
  }

  start(): void {
    if (this.timer) return;
    this.startedAtMs = Date.now();
    this.timer = setInterval(() => {
      this.tick().catch((error) => logger.warn('Triggers', 'Tick failed', { error: error instanceof Error ? error.message : String(error) }));
    }, this.opts.tickMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Drop cached `lastRunMs` timestamps for triggers that no longer exist or
   * whose interval has changed. Call this whenever the on-disk
   * `triggers.json` is mutated so the running scheduler picks up changes
   * without waiting for the existing interval to elapse.
   */
  async invalidate(): Promise<void> {
    const definitions = await loadTriggers(this.opts.projectDir);
    const known = new Set(definitions.map((definition) => definition.id));
    // Drop timestamps for deleted triggers.
    for (const id of Array.from(this.lastRunMs.keys())) {
      if (!known.has(id)) this.lastRunMs.delete(id);
    }
    // For changed intervals, reset the timestamp so the next tick re-evaluates.
    for (const definition of definitions) {
      const existingLast = this.lastRunMs.get(definition.id);
      if (existingLast !== undefined) {
        // Reset so the next tick uses the new interval as the gate.
        this.lastRunMs.set(definition.id, 0);
      }
    }
  }

  /** Run one tick. Returns the executions that fired. Public for tests. */
  async tick(now: Date = new Date()): Promise<TriggerExecutionResult[]> {
    const results: TriggerExecutionResult[] = [];
    if (!this.opts.isEnabled()) return results;
    if (this.opts.isKillSwitchActive()) return results;
    if (now.getTime() - this.startedAtMs < this.opts.startupCooldownMs) return results;

    const triggers = await loadTriggers(this.opts.projectDir);
    for (const definition of triggers) {
      if (definition.enabled === false) continue;
      if (this.inflight.has(definition.id)) continue;
      const intervalMs = Math.max(MIN_INTERVAL_SECONDS, definition.intervalSeconds) * 1000;
      const last = this.lastRunMs.get(definition.id) ?? 0;
      if (now.getTime() - last < intervalMs) continue;
      this.inflight.add(definition.id);
      try {
        const result = await this.execute(definition);
        this.lastRunMs.set(definition.id, now.getTime());
        results.push(result);
        if (result.exitCode === 0 && result.stdout.trim().length > 0) {
          await emitEvent(this.opts.projectDir, 'notification', 'trigger.message', {
            triggerId: definition.id,
            message: result.stdout,
            durationMs: result.durationMs,
          }, 'trigger', definition.id).catch(() => {});
        }
      } catch (error) {
        logger.warn('Triggers', `Execution failed for ${definition.id}`, { error: error instanceof Error ? error.message : String(error) });
      } finally {
        this.inflight.delete(definition.id);
      }
    }
    return results;
  }

  private async execute(definition: TriggerDefinition): Promise<TriggerExecutionResult> {
    const cwd = definition.cwd ?? this.opts.projectDir;
    const started = Date.now();
    const spawnFn = this.opts.spawn ?? defaultSpawnFn(this.opts.outputCapBytes);
    const { exitCode, stdout, stderr } = await spawnFn(definition, cwd);
    return {
      triggerId: definition.id,
      exitCode,
      stdout: capOutput(stdout, this.opts.outputCapBytes),
      stderr: capOutput(stderr, this.opts.outputCapBytes),
      durationMs: Date.now() - started,
    };
  }
}

function capOutput(value: string, capBytes: number): string {
  if (Buffer.byteLength(value, 'utf-8') <= capBytes) return value;
  // Slice by characters first; this is approximate but cheap and safe.
  return value.slice(0, capBytes) + `\n[truncated to ${capBytes} bytes]`;
}

function defaultSpawnFn(outputCapBytes: number): TriggerSpawnFn {
  return (definition, cwd) => new Promise((resolve) => {
    const child = spawn(definition.command, definition.args ?? [], { cwd, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stdout, 'utf-8') < outputCapBytes) stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, 'utf-8') < outputCapBytes) stderr += chunk.toString('utf-8');
    });
    child.on('error', (error) => {
      stderr += '\n' + (error instanceof Error ? error.message : String(error));
      resolve({ exitCode: 1, stdout, stderr });
    });
    child.on('close', (code) => resolve({ exitCode: code, stdout, stderr }));
  });
}
