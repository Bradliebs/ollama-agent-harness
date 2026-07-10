// Budget and cost tracking for companies and agents.
//
// Tracks monthly budgets per agent and per company, records spend events
// after each sub-agent run, and provides enforcement checks that the
// heartbeat can use.
//
// Storage: `.harness/companies/<companyId>/budgets.json`

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { emitEvent } from '../persistence/eventStore';

// ─── Types ──────────────────────────────────────────────────────────

export interface BudgetEntry {
  id: string;
  companyId: string;
  agentId: string;
  periodStart: string;
  periodEnd: string;
  budgetCents: number;
  spentCents: number;
  createdAt: string;
}

export interface SpendEvent {
  id: string;
  companyId: string;
  agentId: string;
  runId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  timestamp: string;
}

export interface BudgetStatus {
  agentId: string;
  budgetCents: number;
  spentCents: number;
  remainingCents: number;
  percentUsed: number;
  overBudget: boolean;
}

// ─── Persistence ────────────────────────────────────────────────────

interface BudgetData {
  entries: BudgetEntry[];
  spendEvents: SpendEvent[];
}

function budgetsFile(projectDir: string, companyId: string): string {
  return path.join(projectDir, '.harness', 'companies', companyId, 'budgets.json');
}

async function readBudgetData(projectDir: string, companyId: string): Promise<BudgetData> {
  try {
    const raw = await fs.readFile(budgetsFile(projectDir, companyId), 'utf-8');
    return JSON.parse(raw) as BudgetData;
  } catch {
    return { entries: [], spendEvents: [] };
  }
}

async function writeBudgetData(projectDir: string, companyId: string, data: BudgetData): Promise<void> {
  const fp = budgetsFile(projectDir, companyId);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Budget CRUD ────────────────────────────────────────────────────

export async function listBudgets(projectDir: string, companyId: string): Promise<BudgetEntry[]> {
  const data = await readBudgetData(projectDir, companyId);
  return data.entries;
}

export async function getBudget(projectDir: string, companyId: string, agentId: string, periodStart?: string): Promise<BudgetEntry | undefined> {
  const data = await readBudgetData(projectDir, companyId);
  return data.entries.find((e) => e.agentId === agentId && (!periodStart || e.periodStart === periodStart));
}

export async function createBudget(
  projectDir: string,
  companyId: string,
  input: { agentId: string; budgetCents: number; periodStart: string; periodEnd: string },
  now = new Date(),
): Promise<BudgetEntry> {
  const data = await readBudgetData(projectDir, companyId);
  const entry: BudgetEntry = {
    id: crypto.randomUUID(),
    companyId,
    agentId: input.agentId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    budgetCents: input.budgetCents,
    spentCents: 0,
    createdAt: now.toISOString(),
  };
  data.entries.push(entry);
  await writeBudgetData(projectDir, companyId, data);
  await emitEvent(projectDir, 'service', 'budget.created', { entry }, 'system', entry.id).catch(() => {});
  return entry;
}

export async function updateBudget(
  projectDir: string,
  companyId: string,
  id: string,
  input: { budgetCents?: number; spentCents?: number; periodEnd?: string },
  now = new Date(),
): Promise<BudgetEntry> {
  const data = await readBudgetData(projectDir, companyId);
  const idx = data.entries.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error(`Budget entry not found: ${id}`);
  const previous = data.entries[idx];
  const updated: BudgetEntry = {
    ...previous,
    ...(input.budgetCents !== undefined ? { budgetCents: input.budgetCents } : {}),
    ...(input.spentCents !== undefined ? { spentCents: input.spentCents } : {}),
    ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
  };
  data.entries[idx] = updated;
  await writeBudgetData(projectDir, companyId, data);
  await emitEvent(projectDir, 'service', 'budget.updated', { entry: updated, previous }, 'system', updated.id).catch(() => {});
  return updated;
}

// ─── Spend Events ────────────────────────────────────────────────────

export async function recordSpend(
  projectDir: string,
  companyId: string,
  input: { agentId: string; runId: string; model: string; inputTokens: number; outputTokens: number; costCents: number },
  now = new Date(),
): Promise<SpendEvent> {
  const data = await readBudgetData(projectDir, companyId);
  const event: SpendEvent = {
    id: crypto.randomUUID(),
    companyId,
    agentId: input.agentId,
    runId: input.runId,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    costCents: input.costCents,
    timestamp: now.toISOString(),
  };
  data.spendEvents.push(event);

  // Auto-increment the relevant budget entry's spentCents
  const period = data.entries.find((e) => {
    const withinPeriod = event.timestamp >= e.periodStart && event.timestamp <= e.periodEnd;
    return e.agentId === input.agentId && withinPeriod;
  });
  if (period) {
    period.spentCents += input.costCents;
  }

  await writeBudgetData(projectDir, companyId, data);
  await emitEvent(projectDir, 'service', 'spend.recorded', { event }, 'system', event.id).catch(() => {});
  return event;
}

export async function listSpendEvents(projectDir: string, companyId: string, filter?: { agentId?: string; runId?: string }): Promise<SpendEvent[]> {
  const data = await readBudgetData(projectDir, companyId);
  return data.spendEvents.filter((e) => {
    if (filter?.agentId && e.agentId !== filter.agentId) return false;
    if (filter?.runId && e.runId !== filter.runId) return false;
    return true;
  });
}

// ─── Enforcement ──────────────────────────────────────────────────────

/**
 * Check whether an agent is over budget for the current period.
 */
export async function checkBudgetStatus(
  projectDir: string,
  companyId: string,
  agentId: string,
  now = new Date(),
): Promise<BudgetStatus | undefined> {
  const data = await readBudgetData(projectDir, companyId);
  const nowIso = now.toISOString();
  const entry = data.entries.find((e) => e.agentId === agentId && nowIso >= e.periodStart && nowIso <= e.periodEnd);
  if (!entry) return undefined;

  return {
    agentId,
    budgetCents: entry.budgetCents,
    spentCents: entry.spentCents,
    remainingCents: entry.budgetCents - entry.spentCents,
    percentUsed: entry.budgetCents > 0 ? Math.round((entry.spentCents / entry.budgetCents) * 100) : 0,
    overBudget: entry.spentCents > entry.budgetCents,
  };
}

/**
 * Check all agents in a company for budget overages.
 */
export async function listBudgetStatuses(projectDir: string, companyId: string, now = new Date()): Promise<BudgetStatus[]> {
  const data = await readBudgetData(projectDir, companyId);
  const nowIso = now.toISOString();
  const results: BudgetStatus[] = [];
  for (const entry of data.entries) {
    if (nowIso >= entry.periodStart && nowIso <= entry.periodEnd) {
      results.push({
        agentId: entry.agentId,
        budgetCents: entry.budgetCents,
        spentCents: entry.spentCents,
        remainingCents: entry.budgetCents - entry.spentCents,
        percentUsed: entry.budgetCents > 0 ? Math.round((entry.spentCents / entry.budgetCents) * 100) : 0,
        overBudget: entry.spentCents > entry.budgetCents,
      });
    }
  }
  return results;
}