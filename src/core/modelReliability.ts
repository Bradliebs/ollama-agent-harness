import * as fs from 'fs/promises';
import * as path from 'path';
import { atomicWriteFile, withFileLock } from '../persistence/atomicFile';

// Per-(model, taskType) reliability tracking. Records how often a given
// model produced a usable result for a given task type, so the Execution
// Readiness Gate can supply a real `model_reliability` signal instead of
// leaving it undefined. Mirrors the persistence pattern in synthesisStats.ts
// (atomicWriteFile + withFileLock, JSON under .harness/).

export interface ModelReliabilityRecord {
  successes: number;
  total: number;
  lastUpdated?: string;
}

/** Keyed by `${model}::${taskType}`. */
export type ModelReliabilityMap = Record<string, ModelReliabilityRecord>;

const RELIABILITY_FILE = 'model-reliability.json';

/** Minimum observations before a reliability score is trusted enough to
 * report. Below this, callers receive undefined and the readiness gate
 * simply omits the signal rather than anchoring on a single sample. */
const MIN_SAMPLES = 3;

function reliabilityPath(projectDir: string): string {
  return path.join(projectDir, '.harness', RELIABILITY_FILE);
}

function key(model: string, taskType: string): string {
  return `${model}::${taskType}`;
}

export async function loadModelReliability(projectDir: string): Promise<ModelReliabilityMap> {
  try {
    const raw = await fs.readFile(reliabilityPath(projectDir), 'utf-8');
    return JSON.parse(raw) as ModelReliabilityMap;
  } catch {
    return {};
  }
}

/**
 * Record one turn outcome for a model on a task type. `success` is the
 * caller's judgement that the turn produced a usable result (e.g. visible
 * output and no hard verifier failure).
 */
export async function recordModelOutcome(
  projectDir: string,
  model: string,
  taskType: string,
  success: boolean,
): Promise<void> {
  if (!model || !taskType) return;
  const filePath = reliabilityPath(projectDir);
  await withFileLock(filePath, async () => {
    const map = await loadModelReliability(projectDir);
    const record = map[key(model, taskType)] ?? { successes: 0, total: 0 };
    record.total++;
    if (success) record.successes++;
    record.lastUpdated = new Date().toISOString();
    map[key(model, taskType)] = record;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, JSON.stringify(map, null, 2));
  });
}

/**
 * Reliability score (0-1) for a model on a task type, or undefined when
 * there is not yet enough history to trust. Used to populate
 * ReadinessInput.model_reliability.
 */
export function modelReliabilityScore(
  map: ModelReliabilityMap,
  model: string,
  taskType: string,
): number | undefined {
  const record = map[key(model, taskType)];
  if (!record || record.total < MIN_SAMPLES) return undefined;
  return record.successes / record.total;
}
