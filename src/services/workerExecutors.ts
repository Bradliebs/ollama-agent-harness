// Default Worker Executors — built-in executors for the worker queue.
//
// These executors handle common background tasks without requiring a
// running LLM. They do rule-based processing and can be swapped for
// model-backed versions when an LLM is available.

import { classifyMode } from './modeClassifier';
import { extractCommands } from './commandExtractor';
import type { WorkerJob, WorkerExecutor, WorkerJobType } from './workerQueue';
import type { WorkerQueue } from './workerQueue';

// ─── Classify Task Executor ─────────────────────────────────────────

const classifyTaskExecutor: WorkerExecutor = async (job) => {
  const input = job.input as { message?: string };
  if (!input.message || typeof input.message !== 'string') {
    throw new Error('classify_task requires input.message string.');
  }
  const classification = classifyMode(input.message);
  return {
    mode: classification.mode,
    confidence: classification.confidence,
    reason: classification.reason,
    matchedPatterns: classification.matchedPatterns,
  };
};

// ─── Extract Tasks Executor ─────────────────────────────────────────

const extractTasksExecutor: WorkerExecutor = async (job) => {
  const input = job.input as { message?: string };
  if (!input.message || typeof input.message !== 'string') {
    throw new Error('extract_tasks requires input.message string.');
  }
  const result = extractCommands(input.message);
  return {
    commands: result.commands,
    valid: result.valid,
    errors: result.errors,
  };
};

// ─── Validate JSON Executor ─────────────────────────────────────────

const validateJsonExecutor: WorkerExecutor = async (job) => {
  const input = job.input as { json?: string };
  if (!input.json || typeof input.json !== 'string') {
    throw new Error('validate_json requires input.json string.');
  }
  try {
    const parsed = JSON.parse(input.json);
    return { valid: true, parsed };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// ─── Summarise Notes Executor (rule-based, no LLM) ─────────────────

const summariseNotesExecutor: WorkerExecutor = async (job) => {
  const input = job.input as { notes?: Array<{ content?: string; created_at?: string }> };
  if (!Array.isArray(input.notes)) {
    throw new Error('summarise_notes requires input.notes array.');
  }
  const count = input.notes.length;
  const contents = input.notes
    .filter((n) => n.content)
    .map((n) => n.content!)
    .slice(0, 20); // Cap to prevent oversized summaries
  return {
    note_count: count,
    summary: contents.length > 0
      ? `${count} note(s). Topics: ${contents.map((c) => c.slice(0, 50)).join('; ')}`
      : `${count} note(s), no content available.`,
  };
};

// ─── Detect Failures Executor ───────────────────────────────────────

const detectFailuresExecutor: WorkerExecutor = async (job) => {
  const input = job.input as { jobs?: Array<{ status?: string; error?: string; job_type?: string }> };
  if (!Array.isArray(input.jobs)) {
    throw new Error('detect_failures requires input.jobs array.');
  }
  const failures = input.jobs.filter((j) => j.status === 'failed');
  const byType = new Map<string, number>();
  for (const f of failures) {
    const key = f.job_type ?? 'unknown';
    byType.set(key, (byType.get(key) ?? 0) + 1);
  }
  const repeated = Array.from(byType.entries())
    .filter(([, count]) => count >= 2)
    .map(([type, count]) => ({ type, count }));
  return {
    total_failures: failures.length,
    repeated_failures: repeated,
    has_repeated: repeated.length > 0,
  };
};

// ─── Executor registry ──────────────────────────────────────────────

export const DEFAULT_EXECUTORS: Record<string, WorkerExecutor> = {
  classify_task: classifyTaskExecutor,
  extract_tasks: extractTasksExecutor,
  validate_json: validateJsonExecutor,
  summarise_notes: summariseNotesExecutor,
  detect_failures: detectFailuresExecutor,
};

/** Register all default executors on a worker queue. */
export function registerDefaultExecutors(queue: WorkerQueue): void {
  for (const [jobType, executor] of Object.entries(DEFAULT_EXECUTORS)) {
    queue.registerExecutor(jobType as WorkerJobType, executor);
  }
}
