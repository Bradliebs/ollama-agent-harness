// Company Store — multi-tenant scoping for agents, goals, and tasks.
//
// A company is the top-level boundary for all orchestration entities. Every
// agent, goal, issue, and task belongs to exactly one company. This provides
// data isolation and allows running multiple "virtual companies" within a
// single Harness instance.
//
// Storage: .harness/companies/<id>.json

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { emitEvent } from '../persistence/eventStore';

// ─── Types ──────────────────────────────────────────────────────────

export type CompanyStatus = 'active' | 'paused' | 'archived';

export interface Company {
  id: string;
  name: string;
  description?: string;
  mission?: string;
  status: CompanyStatus;
  /** ID of the lead agent (CEO equivalent). */
  leadAgentId?: string;
  /** Default adapter ID for new agents. */
  defaultAdapterId?: string;
  /** Budget limits for the company. */
  budget?: CompanyBudget;
  /** Freeform settings. */
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyBudget {
  /** Maximum monthly spend in USD. */
  monthlyLimitUsd?: number;
  /** Maximum concurrent agents. */
  maxConcurrentAgents?: number;
  /** Maximum tasks per agent per heartbeat. */
  maxTasksPerHeartbeat?: number;
}

export interface CreateCompanyInput {
  name: string;
  description?: string;
  mission?: string;
  leadAgentId?: string;
  defaultAdapterId?: string;
  budget?: CompanyBudget;
  settings?: Record<string, unknown>;
}

export interface UpdateCompanyInput {
  name?: string;
  description?: string;
  mission?: string;
  status?: CompanyStatus;
  leadAgentId?: string;
  defaultAdapterId?: string;
  budget?: CompanyBudget;
  settings?: Record<string, unknown>;
}

// ─── Storage ─────────────────────────────────────────────────────────

function companiesDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'companies');
}

function companyFile(projectDir: string, id: string): string {
  return path.join(companiesDir(projectDir), `${id}.json`);
}

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
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry.name), 'utf-8');
      companies.push(normalizeCompany(JSON.parse(raw)));
    } catch {
      // Skip corrupt files
    }
  }
  return companies.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getCompany(projectDir: string, id: string): Promise<Company | undefined> {
  try {
    const raw = await fs.readFile(companyFile(projectDir, id), 'utf-8');
    return normalizeCompany(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export async function createCompany(projectDir: string, input: CreateCompanyInput, now = new Date()): Promise<Company> {
  if (!input.name?.trim()) throw new Error('Company name is required.');

  const id = crypto.randomUUID();
  const company: Company = normalizeCompany({
    id,
    name: input.name.trim(),
    description: input.description?.trim(),
    mission: input.mission?.trim(),
    status: 'active',
    leadAgentId: input.leadAgentId,
    defaultAdapterId: input.defaultAdapterId,
    budget: input.budget,
    settings: input.settings ?? {},
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  const dir = companiesDir(projectDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(companyFile(projectDir, id), JSON.stringify(company, null, 2), 'utf-8');
  await emitEvent(projectDir, 'orchestration', 'company.created', { company }, 'system', id).catch(() => {});
  return company;
}

export async function updateCompany(projectDir: string, id: string, input: UpdateCompanyInput, now = new Date()): Promise<Company> {
  const existing = await getCompany(projectDir, id);
  if (!existing) throw new Error(`Company not found: ${id}`);

  const updated: Company = normalizeCompany({
    ...existing,
    ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
    id: existing.id,
    updatedAt: now.toISOString(),
  });

  await fs.writeFile(companyFile(projectDir, id), JSON.stringify(updated, null, 2), 'utf-8');
  await emitEvent(projectDir, 'orchestration', 'company.updated', { company: updated }, 'system', id).catch(() => {});
  return updated;
}

export async function deleteCompany(projectDir: string, id: string): Promise<boolean> {
  try {
    await fs.unlink(companyFile(projectDir, id));
    await emitEvent(projectDir, 'orchestration', 'company.deleted', { companyId: id }, 'system', id).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// ─── Normalization ──────────────────────────────────────────────────

function normalizeCompany(partial: Partial<Company> & { id: string }): Company {
  return {
    id: partial.id,
    name: partial.name ?? 'Unnamed Company',
    description: partial.description,
    mission: partial.mission,
    status: partial.status ?? 'active',
    leadAgentId: partial.leadAgentId,
    defaultAdapterId: partial.defaultAdapterId,
    budget: partial.budget,
    settings: partial.settings ?? {},
    createdAt: partial.createdAt ?? new Date().toISOString(),
    updatedAt: partial.updatedAt ?? new Date().toISOString(),
  };
}