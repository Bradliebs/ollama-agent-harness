// Company scoping — multi-tenant isolation for goals, agents, budgets, and tasks.
//
// Each company gets a directory under `.harness/companies/<id>/` containing
// `company.json`, `goals.json`, and `budgets.json`. All mutations emit
// events through the event store so live WebSocket clients see changes.

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { emitEvent } from '../persistence/eventStore';

// ─── Types ──────────────────────────────────────────────────────────

export interface CompanySettings {
  /** Default execution policy for new tasks. */
  defaultExecutionPolicy?: 'auto' | 'require_approval' | 'require_approval_above_budget';
  /** Budget approval threshold in cents (used when policy is require_approval_above_budget). */
  budgetApprovalThresholdCents?: number;
  /** Maximum concurrent sub-agents across the company. */
  maxConcurrentAgents?: number;
  /** Custom metadata. */
  [key: string]: unknown;
}

export interface Company {
  id: string;
  name: string;
  mission: string;
  monthlyBudgetCents?: number;
  settings: CompanySettings;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCompanyInput {
  id?: string;
  name: string;
  mission: string;
  monthlyBudgetCents?: number;
  settings?: CompanySettings;
}

export interface UpdateCompanyInput {
  name?: string;
  mission?: string;
  monthlyBudgetCents?: number;
  settings?: CompanySettings;
}

// ─── Paths ──────────────────────────────────────────────────────────

function companiesDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'companies');
}

function companyDir(projectDir: string, id: string): string {
  return path.join(companiesDir(projectDir), id);
}

function companyFile(projectDir: string, id: string): string {
  return path.join(companyDir(projectDir, id), 'company.json');
}

// ─── CRUD ───────────────────────────────────────────────────────────

export async function listCompanies(projectDir: string): Promise<Company[]> {
  const dir = companiesDir(projectDir);
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const companies: Company[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await fs.readFile(companyFile(projectDir, entry.name), 'utf-8');
      companies.push(JSON.parse(raw) as Company);
    } catch {
      // Skip corrupt or missing files.
    }
  }
  return companies;
}

export async function getCompany(projectDir: string, id: string): Promise<Company | undefined> {
  try {
    const raw = await fs.readFile(companyFile(projectDir, id), 'utf-8');
    return JSON.parse(raw) as Company;
  } catch {
    return undefined;
  }
}

export async function createCompany(projectDir: string, input: CreateCompanyInput, now = new Date()): Promise<Company> {
  if (!input.name?.trim()) throw new Error('Company name is required.');
  if (!input.mission?.trim()) throw new Error('Company mission is required.');
  const id = (input.id?.trim() || crypto.randomUUID()).slice(0, 80);
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) throw new Error('Company id must be alphanumeric with - or _ only.');

  // Check for duplicate
  const existing = await getCompany(projectDir, id);
  if (existing) throw new Error(`Company already exists: ${id}`);

  const company: Company = {
    id,
    name: input.name.trim(),
    mission: input.mission.trim(),
    monthlyBudgetCents: input.monthlyBudgetCents,
    settings: input.settings ?? { defaultExecutionPolicy: 'auto' },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  const dir = companyDir(projectDir, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(companyFile(projectDir, id), JSON.stringify(company, null, 2), 'utf-8');

  // Initialize empty goals file
  await fs.writeFile(path.join(dir, 'goals.json'), JSON.stringify({ goals: [] }, null, 2), 'utf-8');
  // Initialize empty budgets file
  await fs.writeFile(path.join(dir, 'budgets.json'), JSON.stringify({ entries: [], spendEvents: [] }, null, 2), 'utf-8');

  await emitEvent(projectDir, 'service', 'company.created', { company }, 'system', id).catch(() => {});
  return company;
}

export async function updateCompany(projectDir: string, id: string, input: UpdateCompanyInput, now = new Date()): Promise<Company> {
  const existing = await getCompany(projectDir, id);
  if (!existing) throw new Error(`Company not found: ${id}`);

  const updated: Company = {
    ...existing,
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.mission !== undefined ? { mission: input.mission.trim() } : {}),
    ...(input.monthlyBudgetCents !== undefined ? { monthlyBudgetCents: input.monthlyBudgetCents } : {}),
    ...(input.settings !== undefined ? { settings: input.settings } : {}),
    updatedAt: now.toISOString(),
  };

  await fs.mkdir(companyDir(projectDir, id), { recursive: true });
  await fs.writeFile(companyFile(projectDir, id), JSON.stringify(updated, null, 2), 'utf-8');
  await emitEvent(projectDir, 'service', 'company.updated', { company: updated, previous: existing }, 'system', id).catch(() => {});
  return updated;
}

export async function deleteCompany(projectDir: string, id: string): Promise<boolean> {
  const dir = companyDir(projectDir, id);
  try {
    await fs.access(path.join(dir, 'company.json'));
  } catch {
    return false;
  }
  await fs.rm(dir, { recursive: true, force: true });
  await emitEvent(projectDir, 'service', 'company.deleted', { companyId: id }, 'system', id).catch(() => {});
  return true;
}