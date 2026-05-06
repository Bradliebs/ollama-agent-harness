import * as fs from 'fs/promises';
import * as path from 'path';
import { findInstalledVisionModel } from '../models/visionModels';
import { createCleanupAgentOutputsAction } from '../services/selfLearningHeartbeat';

// `harness doctor --fix` — auto-remediate the failure modes the doctor
// already diagnoses. Three classes of fix:
//
//   1. Vision: when no vision-capable model is installed, pull a default
//      via `ollama pull` (long-running, network, ~4GB). Always opt-in
//      via `--yes` because of the disk/bandwidth cost.
//   2. Context: when `.harness/settings.json` `contextMaxTokens` is one
//      of the known stale defaults (8192, 4096), rewrite to 0 so the
//      resolver enters auto mode and uses the model's detected window.
//   3. Prune: delegate to the cleanup_agent_outputs heartbeat action so
//      a single 14d cutoff applies whether the heartbeat runs or the
//      user runs `--fix` manually.
//
// Each fix is independent — a failure in one does not skip the others.
// All side-effects are routed through injectable executors so the test
// suite can run the pipeline without touching `ollama` or the real
// filesystem.

export type VisionFixOutcome = 'ok' | 'pulled' | 'skipped-confirm' | 'failed' | 'no-target';
export type ContextFixOutcome = 'ok' | 'rewritten' | 'skipped' | 'failed';
export type PruneOutcome = 'ok' | 'failed';

export interface DoctorFixResult {
  vision: { outcome: VisionFixOutcome; message: string; pulledModel?: string };
  context: { outcome: ContextFixOutcome; message: string; previousValue?: number; nextValue?: number };
  prune: { outcome: PruneOutcome; message: string; removed: number; scanned: number };
}

export interface DoctorFixOptions {
  /** Project root used for settings.json + agent-outputs lookups. */
  projectDir: string;
  /** Ollama host for vision-model pulls. */
  ollamaHost: string;
  /** Configured vision model from doctor input (CLI/env). */
  visionModel: string;
  /** Currently configured contextMaxTokens (0/undefined means already auto). */
  contextMaxTokens: number;
  /** When true, perform destructive fixes (vision pull) without prompting. */
  yes: boolean;
  /** Model to pull when no vision-capable model is installed. */
  defaultVisionPull?: string;
  /** Cutoff in days for agent-outputs prune. Defaults to 14. */
  pruneMaxAgeDays?: number;
  /**
   * Lists installed Ollama models. Defaults to the live `ollama` SDK call.
   * Tests inject a mock to avoid network.
   */
  listInstalledModels?: () => Promise<string[]>;
  /**
   * Pulls a model via Ollama. Defaults to the live SDK call. Tests inject
   * a mock that records the requested model.
   */
  pullModel?: (model: string) => Promise<void>;
  /**
   * Interactive confirmation hook. When provided AND `yes` is false, the
   * vision fixer calls it before pulling so a TTY user can approve in
   * one invocation. Returning `true` proceeds with the pull; `false`
   * leaves the outcome as `skipped-confirm`.
   */
  confirmVisionPull?: (model: string) => Promise<boolean>;
}

const DEFAULT_VISION_PULL = 'llava:latest';
const LEGACY_CONTEXT_DEFAULTS = new Set<number>([8192, 4096]);

export async function runDoctorFix(options: DoctorFixOptions): Promise<DoctorFixResult> {
  const [vision, context, prune] = await Promise.all([
    fixVision(options),
    fixContext(options),
    fixPrune(options),
  ]);
  return { vision, context, prune };
}

async function fixVision(options: DoctorFixOptions): Promise<DoctorFixResult['vision']> {
  const listImpl = options.listInstalledModels ?? defaultListInstalledModels(options.ollamaHost);
  const pullImpl = options.pullModel ?? defaultPullModel(options.ollamaHost);
  let installed: string[];
  try {
    installed = await listImpl();
  } catch (error) {
    return { outcome: 'failed', message: `Could not list installed models: ${describeError(error)}` };
  }
  const detected = findInstalledVisionModel(installed);
  // If the user explicitly configured a vision model and it IS installed,
  // there is nothing to fix.
  const configured = options.visionModel.trim();
  if (configured && installed.some((name) => name === configured || name.startsWith(`${configured}:`))) {
    return { outcome: 'ok', message: `Vision model "${configured}" is installed.` };
  }
  // If a different vision-capable model is installed, surface that as
  // the no-op fix — `harness doctor --fix` should not download something
  // when a working model is already on disk.
  if (detected) {
    return { outcome: 'ok', message: `Vision-capable model "${detected}" already installed; no pull required.` };
  }
  // No vision-capable model present. Decide which one to pull.
  const target = (configured || options.defaultVisionPull || DEFAULT_VISION_PULL).trim();
  if (!target) {
    return { outcome: 'no-target', message: 'No vision model configured and no default pull target available.' };
  }
  let approvedToPull = options.yes;
  if (!approvedToPull && options.confirmVisionPull) {
    try {
      approvedToPull = await options.confirmVisionPull(target);
    } catch {
      approvedToPull = false;
    }
  }
  if (!approvedToPull) {
    return {
      outcome: 'skipped-confirm',
      message: `Would pull vision model "${target}". Re-run with --yes to download.`,
    };
  }
  try {
    await pullImpl(target);
    return { outcome: 'pulled', message: `Pulled vision model "${target}".`, pulledModel: target };
  } catch (error) {
    return { outcome: 'failed', message: `Pull failed for "${target}": ${describeError(error)}` };
  }
}

async function fixContext(options: DoctorFixOptions): Promise<DoctorFixResult['context']> {
  const settingsPath = path.join(options.projectDir, '.harness', 'settings.json');
  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, 'utf-8');
  } catch {
    // No settings.json yet — nothing to rewrite. The runtime default is
    // already auto-mode for unconfigured users.
    return { outcome: 'ok', message: 'No .harness/settings.json present; runtime is already auto-mode.' };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    return { outcome: 'failed', message: `Could not parse settings.json: ${describeError(error)}` };
  }
  const current = typeof parsed.contextMaxTokens === 'number' ? parsed.contextMaxTokens : undefined;
  if (current === undefined || current === 0) {
    return { outcome: 'ok', message: 'contextMaxTokens already in auto mode.', previousValue: current };
  }
  if (!LEGACY_CONTEXT_DEFAULTS.has(current)) {
    return {
      outcome: 'skipped',
      message: `contextMaxTokens=${current} looks like a deliberate cap (not a legacy default); leaving as-is.`,
      previousValue: current,
    };
  }
  parsed.contextMaxTokens = 0;
  try {
    await fs.writeFile(settingsPath, JSON.stringify(parsed, null, 2), 'utf-8');
  } catch (error) {
    return { outcome: 'failed', message: `Could not write settings.json: ${describeError(error)}`, previousValue: current };
  }
  return {
    outcome: 'rewritten',
    message: `contextMaxTokens ${current} → 0 (auto-detect).`,
    previousValue: current,
    nextValue: 0,
  };
}

async function fixPrune(options: DoctorFixOptions): Promise<DoctorFixResult['prune']> {
  const action = createCleanupAgentOutputsAction({ maxAgeDays: options.pruneMaxAgeDays ?? 14 });
  try {
    const result = await action.run(options.projectDir);
    const details = (result.details ?? {}) as { scanned?: number; removed?: number };
    return {
      outcome: 'ok',
      message: result.summary,
      removed: details.removed ?? 0,
      scanned: details.scanned ?? 0,
    };
  } catch (error) {
    return { outcome: 'failed', message: `Prune failed: ${describeError(error)}`, removed: 0, scanned: 0 };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultListInstalledModels(host: string): () => Promise<string[]> {
  return async () => {
    const { Ollama } = await import('ollama');
    const response = await new Ollama({ host }).list();
    return response.models.map((m) => m.name);
  };
}

function defaultPullModel(host: string): (model: string) => Promise<void> {
  return async (model) => {
    const { Ollama } = await import('ollama');
    // The Ollama SDK returns an async iterable for streaming pulls. We
    // just need to drain it so the download completes.
    const stream = await new Ollama({ host }).pull({ model, stream: true });
    for await (const _chunk of stream) { void _chunk; }
  };
}

export function formatDoctorFixSummary(result: DoctorFixResult): string {
  const lines: string[] = ['Doctor --fix summary:'];
  lines.push(`  Vision : ${labelOutcome(result.vision.outcome)} — ${result.vision.message}`);
  lines.push(`  Context: ${labelOutcome(result.context.outcome)} — ${result.context.message}`);
  lines.push(`  Prune  : ${labelOutcome(result.prune.outcome)} — ${result.prune.message}`);
  return lines.join('\n');
}

function labelOutcome(outcome: string): string {
  switch (outcome) {
    case 'ok': return '✓ ok';
    case 'pulled': return '✓ pulled';
    case 'rewritten': return '✓ rewritten';
    case 'skipped': return '· skipped';
    case 'skipped-confirm': return '· awaiting --yes';
    case 'no-target': return '· no target';
    case 'failed': return '✗ failed';
    default: return outcome;
  }
}
