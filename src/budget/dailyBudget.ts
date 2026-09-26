// Daily spend cap — global ceiling on cloud-LLM cost per UTC day.
//
// Storage: .harness/daily-spend.json, written under withFileLock + atomic.
// Day boundary: UTC. Rolls over at 00:00Z by zeroing the spend record.
// Scope: cloud-provider chat calls only. Local Ollama is always free and
// is short-circuited by the BudgetEnforcingChatClient before this module
// is consulted.
//
// Fail-closed posture: a corrupt or unwritable spend file refuses cloud
// calls until repaired. Same posture as the kill switch — a budget gate
// that silently fails open is theatre.

import { promises as fs } from 'fs';
import * as path from 'path';
import { atomicWriteFile, withFileLock } from '../persistence/atomicFile';

const SPEND_FILE_VERSION = 1 as const;
const WARN_THRESHOLD = 0.8;

export interface DailySpendRecord {
  version: typeof SPEND_FILE_VERSION;
  /** UTC date in YYYY-MM-DD form. */
  utcDate: string;
  /** Cumulative spend for utcDate in USD. */
  spentUsd: number;
  /** Cumulative override addition for utcDate in USD (0 unless an operator extended the cap). */
  overrideUsd: number;
  /** Per-model spend breakdown for the current day. */
  byModel: Record<string, number>;
  /** First and last record timestamps for the current day. */
  firstAt: string;
  lastAt: string;
}

export interface BudgetState {
  /** 'off' = no cap configured. 'ok' / 'warn' / 'block' = enforcement active. 'unavailable' = spend file unreadable; fail-closed. */
  status: 'off' | 'ok' | 'warn' | 'block' | 'unavailable';
  /** Effective cap (configured cap + today's overrides). 0 when status='off'. */
  effectiveCapUsd: number;
  /** Configured base cap (without overrides). */
  configuredCapUsd: number;
  /** Today's accumulated spend. */
  spentUsd: number;
  /** Today's accumulated override extension. */
  overrideUsd: number;
  /** Spend / cap, clamped to [0, 1]. 0 when off. */
  fraction: number;
  utcDate: string;
  reason?: string;
}

function spendFilePath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'daily-spend.json');
}

function todayUtcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Resolve the configured base cap from environment. Settings.json override
 * is layered on top by the caller (server resolves both and passes the
 * final number into checkBudgetState/recordSpend via getCapUsd).
 *
 * Returns 0 when unset or non-positive — 0 disables enforcement.
 */
export function getEnvCapUsd(): number {
  const raw = (process.env.HARNESS_DAILY_SPEND_USD ?? '').trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

function emptyRecord(utcDate: string, nowIso: string): DailySpendRecord {
  return { version: SPEND_FILE_VERSION, utcDate, spentUsd: 0, overrideUsd: 0, byModel: {}, firstAt: nowIso, lastAt: nowIso };
}

/**
 * Read the current spend record. Returns:
 *  - { record, healthy: true } when the file exists and is well-formed
 *  - { record: null, healthy: true } when the file is absent (fresh day, never written)
 *  - { record: null, healthy: false, reason } when the file is present but
 *    corrupt or otherwise unreadable. Callers must fail closed in this case.
 */
async function readSpendRecord(projectDir: string): Promise<{ record: DailySpendRecord | null; healthy: boolean; reason?: string }> {
  const fp = spendFilePath(projectDir);
  let raw: string;
  try {
    raw = await fs.readFile(fp, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { record: null, healthy: true };
    return { record: null, healthy: false, reason: `spend file unreadable: ${(error as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { record: null, healthy: false, reason: `spend file is not valid JSON: ${(error as Error).message}` };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { record: null, healthy: false, reason: 'spend file root is not an object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== SPEND_FILE_VERSION) {
    return { record: null, healthy: false, reason: `spend file version ${String(obj.version)} != ${SPEND_FILE_VERSION}` };
  }
  if (typeof obj.utcDate !== 'string' || typeof obj.spentUsd !== 'number' || typeof obj.overrideUsd !== 'number') {
    return { record: null, healthy: false, reason: 'spend file missing required fields' };
  }
  if (!Number.isFinite(obj.spentUsd) || !Number.isFinite(obj.overrideUsd) || obj.spentUsd < 0 || obj.overrideUsd < 0) {
    return { record: null, healthy: false, reason: 'spend file has invalid numeric fields' };
  }
  const byModelRaw = obj.byModel;
  const byModel: Record<string, number> = {};
  if (byModelRaw && typeof byModelRaw === 'object') {
    for (const [k, v] of Object.entries(byModelRaw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) byModel[k] = v;
    }
  }
  const record: DailySpendRecord = {
    version: SPEND_FILE_VERSION,
    utcDate: obj.utcDate,
    spentUsd: obj.spentUsd,
    overrideUsd: obj.overrideUsd,
    byModel,
    firstAt: typeof obj.firstAt === 'string' ? obj.firstAt : new Date().toISOString(),
    lastAt: typeof obj.lastAt === 'string' ? obj.lastAt : new Date().toISOString(),
  };
  return { record, healthy: true };
}

async function writeSpendRecord(projectDir: string, record: DailySpendRecord): Promise<void> {
  const fp = spendFilePath(projectDir);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await atomicWriteFile(fp, JSON.stringify(record, null, 2));
}

/**
 * Compute the current budget state without mutating the spend file.
 * Returns 'off' when configuredCapUsd <= 0; 'unavailable' when the spend
 * file is corrupt; otherwise compares spent to (cap + overrides).
 */
export async function checkBudgetState(projectDir: string, configuredCapUsd: number, now: Date = new Date()): Promise<BudgetState> {
  const utcDate = todayUtcDate(now);
  if (!Number.isFinite(configuredCapUsd) || configuredCapUsd <= 0) {
    return { status: 'off', effectiveCapUsd: 0, configuredCapUsd: 0, spentUsd: 0, overrideUsd: 0, fraction: 0, utcDate };
  }
  const result = await readSpendRecord(projectDir);
  if (!result.healthy) {
    return { status: 'unavailable', effectiveCapUsd: configuredCapUsd, configuredCapUsd, spentUsd: 0, overrideUsd: 0, fraction: 0, utcDate, reason: result.reason };
  }
  const record = result.record;
  // No record yet, or stale day — today's spend is zero.
  const isToday = record !== null && record.utcDate === utcDate;
  const spentUsd = isToday ? record!.spentUsd : 0;
  const overrideUsd = isToday ? record!.overrideUsd : 0;
  const effectiveCapUsd = configuredCapUsd + overrideUsd;
  const fraction = effectiveCapUsd > 0 ? Math.min(1, spentUsd / effectiveCapUsd) : 0;
  let status: BudgetState['status'];
  if (spentUsd >= effectiveCapUsd) status = 'block';
  else if (spentUsd >= effectiveCapUsd * WARN_THRESHOLD) status = 'warn';
  else status = 'ok';
  return { status, effectiveCapUsd, configuredCapUsd, spentUsd, overrideUsd, fraction, utcDate };
}

export interface RecordSpendInput {
  modelId: string;
  estimatedCostUsd: number;
}

export interface RecordSpendResult {
  /** State AFTER this spend was recorded. */
  state: BudgetState;
  /** True when this call pushed the day across the warn or block threshold for the first time. */
  crossedWarn: boolean;
  crossedBlock: boolean;
}

export interface SpendReservationResult extends RecordSpendResult {
  reserved: boolean;
  reservedCostUsd: number;
}

export interface ReconcileReservedSpendResult extends RecordSpendResult {
  adjustmentUsd: number;
}

function roundMicroUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function stateFromRecord(record: DailySpendRecord, configuredCapUsd: number): BudgetState {
  const effectiveCapUsd = configuredCapUsd > 0 ? configuredCapUsd + record.overrideUsd : 0;
  const fraction = effectiveCapUsd > 0 ? Math.min(1, record.spentUsd / effectiveCapUsd) : 0;
  let status: BudgetState['status'];
  if (configuredCapUsd <= 0) status = 'off';
  else if (record.spentUsd >= effectiveCapUsd) status = 'block';
  else if (record.spentUsd >= effectiveCapUsd * WARN_THRESHOLD) status = 'warn';
  else status = 'ok';
  return { status, effectiveCapUsd, configuredCapUsd, spentUsd: record.spentUsd, overrideUsd: record.overrideUsd, fraction, utcDate: record.utcDate };
}

function thresholdCrossings(priorSpent: number, priorOverride: number, record: DailySpendRecord, configuredCapUsd: number): { crossedWarn: boolean; crossedBlock: boolean } {
  const effectiveCapUsd = configuredCapUsd > 0 ? configuredCapUsd + record.overrideUsd : 0;
  const priorEffective = configuredCapUsd > 0 ? configuredCapUsd + priorOverride : 0;
  return {
    crossedWarn: configuredCapUsd > 0
      && priorSpent < priorEffective * WARN_THRESHOLD
      && record.spentUsd >= effectiveCapUsd * WARN_THRESHOLD
      && record.spentUsd < effectiveCapUsd,
    crossedBlock: configuredCapUsd > 0
      && priorSpent < priorEffective
      && record.spentUsd >= effectiveCapUsd,
  };
}

async function mutateSpend(projectDir: string, input: RecordSpendInput, deltaUsd: number, configuredCapUsd: number, now: Date): Promise<RecordSpendResult> {
  const utcDate = todayUtcDate(now);
  const nowIso = now.toISOString();
  const result = await withFileLock(spendFilePath(projectDir), async () => {
    const read = await readSpendRecord(projectDir);
    let record: DailySpendRecord;
    let priorSpent = 0;
    let priorOverride = 0;
    if (!read.healthy) {
      return { record: null, healthy: false as const, reason: read.reason ?? 'unknown' };
    }
    if (read.record === null || read.record.utcDate !== utcDate) {
      record = emptyRecord(utcDate, nowIso);
    } else {
      record = read.record;
      priorSpent = record.spentUsd;
      priorOverride = record.overrideUsd;
    }
    const nextModelSpend = roundMicroUsd((record.byModel[input.modelId] ?? 0) + deltaUsd);
    record.spentUsd = Math.max(0, roundMicroUsd(record.spentUsd + deltaUsd));
    if (nextModelSpend <= 0) delete record.byModel[input.modelId];
    else record.byModel[input.modelId] = nextModelSpend;
    record.lastAt = nowIso;
    await writeSpendRecord(projectDir, record);
    return { record, healthy: true as const, priorSpent, priorOverride };
  });
  if (!result.healthy) {
    return {
      state: { status: 'unavailable', effectiveCapUsd: configuredCapUsd, configuredCapUsd, spentUsd: 0, overrideUsd: 0, fraction: 0, utcDate, reason: result.reason },
      crossedWarn: false,
      crossedBlock: false,
    };
  }
  const record = result.record;
  if (!record) {
    return {
      state: { status: 'unavailable', effectiveCapUsd: configuredCapUsd, configuredCapUsd, spentUsd: 0, overrideUsd: 0, fraction: 0, utcDate, reason: 'spend record missing after write' },
      crossedWarn: false,
      crossedBlock: false,
    };
  }
  return { state: stateFromRecord(record, configuredCapUsd), ...thresholdCrossings(result.priorSpent, result.priorOverride, record, configuredCapUsd) };
}

/**
 * Add a spend amount to today's record. Always writes (even when cap is
 * off or unavailable) so the operator has a running tally to inspect.
 *
 * Numbers are rounded to micro-USD (6 decimal places) before persisting
 * to keep the file from drifting on float accumulation.
 */
export async function recordSpend(projectDir: string, input: RecordSpendInput, configuredCapUsd: number, now: Date = new Date()): Promise<RecordSpendResult> {
  const incrementUsd = Number.isFinite(input.estimatedCostUsd) && input.estimatedCostUsd > 0
    ? roundMicroUsd(input.estimatedCostUsd)
    : 0;
  return mutateSpend(projectDir, input, incrementUsd, configuredCapUsd, now);
}

export async function reserveSpend(projectDir: string, input: RecordSpendInput, configuredCapUsd: number, now: Date = new Date()): Promise<SpendReservationResult> {
  const utcDate = todayUtcDate(now);
  const nowIso = now.toISOString();
  const reservedCostUsd = Number.isFinite(input.estimatedCostUsd) && input.estimatedCostUsd > 0
    ? roundMicroUsd(input.estimatedCostUsd)
    : 0;
  if (!Number.isFinite(configuredCapUsd) || configuredCapUsd <= 0 || reservedCostUsd <= 0) {
    return { state: await checkBudgetState(projectDir, configuredCapUsd, now), crossedWarn: false, crossedBlock: false, reserved: false, reservedCostUsd: 0 };
  }
  const result = await withFileLock(spendFilePath(projectDir), async () => {
    const read = await readSpendRecord(projectDir);
    let record: DailySpendRecord;
    let priorSpent = 0;
    let priorOverride = 0;
    if (!read.healthy) return { record: null, healthy: false as const, reason: read.reason ?? 'unknown', reserved: false as const };
    if (read.record === null || read.record.utcDate !== utcDate) {
      record = emptyRecord(utcDate, nowIso);
    } else {
      record = read.record;
      priorSpent = record.spentUsd;
      priorOverride = record.overrideUsd;
    }
    const effectiveCapUsd = configuredCapUsd + record.overrideUsd;
    const projectedSpend = roundMicroUsd(record.spentUsd + reservedCostUsd);
    if (record.spentUsd >= effectiveCapUsd || projectedSpend > effectiveCapUsd) {
      const blockedRecord = { ...record, spentUsd: projectedSpend };
      return { record: blockedRecord, healthy: true as const, priorSpent, priorOverride, reserved: false as const };
    }
    record.spentUsd = projectedSpend;
    record.byModel[input.modelId] = roundMicroUsd((record.byModel[input.modelId] ?? 0) + reservedCostUsd);
    record.lastAt = nowIso;
    await writeSpendRecord(projectDir, record);
    return { record, healthy: true as const, priorSpent, priorOverride, reserved: true as const };
  });
  if (!result.healthy) {
    return {
      state: { status: 'unavailable', effectiveCapUsd: configuredCapUsd, configuredCapUsd, spentUsd: 0, overrideUsd: 0, fraction: 0, utcDate, reason: result.reason },
      crossedWarn: false,
      crossedBlock: false,
      reserved: false,
      reservedCostUsd,
    };
  }
  const record = result.record;
  if (!record) {
    return {
      state: { status: 'unavailable', effectiveCapUsd: configuredCapUsd, configuredCapUsd, spentUsd: 0, overrideUsd: 0, fraction: 0, utcDate, reason: 'spend record missing after reservation' },
      crossedWarn: false,
      crossedBlock: false,
      reserved: false,
      reservedCostUsd,
    };
  }
  return { state: stateFromRecord(record, configuredCapUsd), ...thresholdCrossings(result.priorSpent, result.priorOverride, record, configuredCapUsd), reserved: result.reserved, reservedCostUsd };
}

export async function reconcileReservedSpend(projectDir: string, input: RecordSpendInput, reservedCostUsd: number, configuredCapUsd: number, now: Date = new Date()): Promise<ReconcileReservedSpendResult> {
  const actualCostUsd = Number.isFinite(input.estimatedCostUsd) && input.estimatedCostUsd > 0 ? roundMicroUsd(input.estimatedCostUsd) : 0;
  const reserved = Number.isFinite(reservedCostUsd) && reservedCostUsd > 0 ? roundMicroUsd(reservedCostUsd) : 0;
  const adjustmentUsd = roundMicroUsd(actualCostUsd - reserved);
  if (adjustmentUsd === 0) {
    const state = await checkBudgetState(projectDir, configuredCapUsd, now);
    return { state, crossedWarn: false, crossedBlock: false, adjustmentUsd };
  }
  return { ...(await mutateSpend(projectDir, input, adjustmentUsd, configuredCapUsd, now)), adjustmentUsd };
}

/**
 * Add an override extension to today's cap. Returns the new state.
 * Override is additive (multiple overrides accumulate) and resets at the
 * UTC day boundary along with spend.
 */
export async function addOverride(projectDir: string, additionalUsd: number, configuredCapUsd: number, now: Date = new Date()): Promise<BudgetState> {
  if (!Number.isFinite(additionalUsd) || additionalUsd <= 0) {
    throw new Error('Override additionalUsd must be a positive finite number.');
  }
  const utcDate = todayUtcDate(now);
  const nowIso = now.toISOString();
  const result = await withFileLock(spendFilePath(projectDir), async () => {
    const read = await readSpendRecord(projectDir);
    if (!read.healthy) return { record: null, healthy: false as const, reason: read.reason ?? 'unknown' };
    let record: DailySpendRecord;
    if (read.record === null || read.record.utcDate !== utcDate) {
      record = emptyRecord(utcDate, nowIso);
    } else {
      record = read.record;
    }
    record.overrideUsd = Math.round((record.overrideUsd + additionalUsd) * 1_000_000) / 1_000_000;
    record.lastAt = nowIso;
    await writeSpendRecord(projectDir, record);
    return { record, healthy: true as const };
  });
  if (!result.healthy || !result.record) {
    return { status: 'unavailable', effectiveCapUsd: configuredCapUsd, configuredCapUsd, spentUsd: 0, overrideUsd: 0, fraction: 0, utcDate, reason: result.reason };
  }
  const record = result.record;
  const effectiveCapUsd = configuredCapUsd > 0 ? configuredCapUsd + record.overrideUsd : 0;
  const fraction = effectiveCapUsd > 0 ? Math.min(1, record.spentUsd / effectiveCapUsd) : 0;
  let status: BudgetState['status'];
  if (configuredCapUsd <= 0) status = 'off';
  else if (record.spentUsd >= effectiveCapUsd) status = 'block';
  else if (record.spentUsd >= effectiveCapUsd * WARN_THRESHOLD) status = 'warn';
  else status = 'ok';
  return { status, effectiveCapUsd, configuredCapUsd, spentUsd: record.spentUsd, overrideUsd: record.overrideUsd, fraction, utcDate };
}

/** Read the raw spend record for the current day, or null when nothing recorded yet. Used by the Health tile. */
export async function readTodaySpend(projectDir: string, now: Date = new Date()): Promise<DailySpendRecord | null> {
  const utcDate = todayUtcDate(now);
  const result = await readSpendRecord(projectDir);
  if (!result.healthy || !result.record) return null;
  if (result.record.utcDate !== utcDate) return null;
  return result.record;
}
