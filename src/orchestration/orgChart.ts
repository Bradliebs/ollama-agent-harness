// Org Chart — hierarchical agent relationships within a company.
//
// An org chart defines the reporting and delegation structure for agents.
// Each node is an agent with a role, a manager (parent), and optional
// direct reports. This mirrors Paperclip's org chart concept while
// building on our existing squad and subagent infrastructure.
//
// Storage: .harness/orgcharts/<id>.json

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { emitEvent } from '../persistence/eventStore';

// ─── Types ──────────────────────────────────────────────────────────

export type OrgRole = 'ceo' | 'cto' | 'vp_engineering' | 'engineer' | 'designer' | 'pm' | 'marketer' | 'researcher' | 'analyst' | 'reviewer' | 'custom';

export interface OrgNode {
  /** Agent definition ID (references .harness/agents/). */
  agentId: string;
  role: OrgRole | string;
  /** Custom title (e.g. "VP of AI Research"). */
  title?: string;
  /** Agent ID of the manager (parent in the org tree). */
  managerId?: string;
  /** IDs of direct reports. */
  reportIds: string[];
  /** Budget override for this agent. */
  budget?: {
    maxTurnsPerRun?: number;
    maxTimeMsPerRun?: number;
    maxCostUsdPerDay?: number;
  };
  /** Which adapter this agent uses. */
  adapterId?: string;
  /** Custom system prompt additions. */
  promptAdditions?: string;
}

export interface OrgChart {
  id: string;
  companyId: string;
  name: string;
  description?: string;
  /** Root node (CEO) agent ID. */
  rootAgentId: string;
  /** All nodes in the org chart. */
  nodes: OrgNode[];
  /** Maximum depth of the org tree. */
  maxDepth: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrgChartInput {
  companyId: string;
  name: string;
  description?: string;
  rootAgentId: string;
  nodes: OrgNode[];
  maxDepth?: number;
}

export interface UpdateOrgChartInput {
  name?: string;
  description?: string;
  rootAgentId?: string;
  nodes?: OrgNode[];
  maxDepth?: number;
}

// ─── Storage ─────────────────────────────────────────────────────────

function orgChartsDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'orgcharts');
}

function orgChartFile(projectDir: string, id: string): string {
  return path.join(orgChartsDir(projectDir), `${id}.json`);
}

// ─── CRUD ───────────────────────────────────────────────────────────

export async function listOrgCharts(projectDir: string, filter?: { companyId?: string }): Promise<OrgChart[]> {
  const dir = orgChartsDir(projectDir);
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const charts: OrgChart[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry.name), 'utf-8');
      charts.push(normalizeOrgChart(JSON.parse(raw)));
    } catch { /* skip */ }
  }
  return charts
    .filter((c) => {
      if (filter?.companyId && c.companyId !== filter.companyId) return false;
      return true;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getOrgChart(projectDir: string, id: string): Promise<OrgChart | undefined> {
  try {
    const raw = await fs.readFile(orgChartFile(projectDir, id), 'utf-8');
    return normalizeOrgChart(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export async function createOrgChart(projectDir: string, input: CreateOrgChartInput, now = new Date()): Promise<OrgChart> {
  if (!input.name?.trim()) throw new Error('Org chart name is required.');
  if (!input.rootAgentId) throw new Error('Root agent ID is required.');

  const id = crypto.randomUUID();
  const chart: OrgChart = normalizeOrgChart({
    id,
    companyId: input.companyId,
    name: input.name.trim(),
    description: input.description?.trim(),
    rootAgentId: input.rootAgentId,
    nodes: input.nodes,
    maxDepth: input.maxDepth ?? 5,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  // Validate tree structure
  validateOrgTree(chart.nodes, input.rootAgentId);

  await fs.mkdir(orgChartsDir(projectDir), { recursive: true });
  await fs.writeFile(orgChartFile(projectDir, id), JSON.stringify(chart, null, 2), 'utf-8');
  await emitEvent(projectDir, 'orchestration', 'orgchart.created', { chart }, 'system', id).catch(() => {});
  return chart;
}

export async function updateOrgChart(projectDir: string, id: string, input: UpdateOrgChartInput, now = new Date()): Promise<OrgChart> {
  const existing = await getOrgChart(projectDir, id);
  if (!existing) throw new Error(`Org chart not found: ${id}`);

  const updated: OrgChart = normalizeOrgChart({
    ...existing,
    ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
    id: existing.id,
    companyId: existing.companyId,
    updatedAt: now.toISOString(),
  });

  if (input.nodes) {
    validateOrgTree(updated.nodes, updated.rootAgentId);
  }

  await fs.writeFile(orgChartFile(projectDir, id), JSON.stringify(updated, null, 2), 'utf-8');
  await emitEvent(projectDir, 'orchestration', 'orgchart.updated', { chart: updated }, 'system', id).catch(() => {});
  return updated;
}

export async function deleteOrgChart(projectDir: string, id: string): Promise<boolean> {
  try {
    await fs.unlink(orgChartFile(projectDir, id));
    await emitEvent(projectDir, 'orchestration', 'orgchart.deleted', { orgChartId: id }, 'system', id).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// ─── Tree Operations ────────────────────────────────────────────────

/**
 * Get the management chain from a node up to the root.
 */
export function getManagementChain(nodes: OrgNode[], agentId: string): OrgNode[] {
  const chain: OrgNode[] = [];
  const nodeMap = new Map(nodes.map((n) => [n.agentId, n]));
  let current = nodeMap.get(agentId);
  while (current) {
    chain.push(current);
    current = current.managerId ? nodeMap.get(current.managerId) : undefined;
  }
  return chain;
}

/**
 * Get all direct and indirect reports of a manager.
 */
export function getAllReports(nodes: OrgNode[], managerId: string): OrgNode[] {
  const reports: OrgNode[] = [];
  const nodeMap = new Map(nodes.map((n) => [n.agentId, n]));
  const directReports = nodes.filter((n) => n.managerId === managerId);
  for (const report of directReports) {
    reports.push(report);
    reports.push(...getAllReports(nodes, report.agentId));
  }
  return reports;
}

/**
 * Validate org tree structure: no cycles, all references resolve.
 */
function validateOrgTree(nodes: OrgNode[], rootId: string): void {
  const nodeMap = new Map(nodes.map((n) => [n.agentId, n]));

  // Root must exist
  if (!nodeMap.has(rootId)) {
    throw new Error(`Root agent ${rootId} not found in nodes`);
  }

  // Check for cycles using depth-first traversal
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(nodeId: string): void {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) {
      throw new Error(`Cycle detected in org tree at agent ${nodeId}`);
    }
    visiting.add(nodeId);
    const node = nodeMap.get(nodeId);
    if (node) {
      for (const reportId of node.reportIds) {
        visit(reportId);
      }
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  }

  visit(rootId);

  // Check that all manager references resolve
  for (const node of nodes) {
    if (node.managerId && !nodeMap.has(node.managerId)) {
      throw new Error(`Agent ${node.agentId} references non-existent manager ${node.managerId}`);
    }
  }
}

/**
 * Render an org chart as a tree string (for debugging/display).
 */
export function renderOrgTree(nodes: OrgNode[], rootId: string, indent = ''): string {
  const nodeMap = new Map(nodes.map((n) => [n.agentId, n]));
  const root = nodeMap.get(rootId);
  if (!root) return '';

  const directReports = nodes.filter((n) => n.managerId === rootId);
  let result = `${indent}${root.role}${root.title ? ` (${root.title})` : ''} [${rootId}]\n`;
  for (const report of directReports) {
    result += renderOrgTree(nodes, report.agentId, indent + '  ');
  }
  return result;
}

// ─── Normalization ──────────────────────────────────────────────────

function normalizeOrgChart(partial: Partial<OrgChart> & { id: string }): OrgChart {
  return {
    id: partial.id,
    companyId: partial.companyId ?? '',
    name: partial.name ?? 'Unnamed Org Chart',
    description: partial.description,
    rootAgentId: partial.rootAgentId ?? '',
    nodes: (partial.nodes ?? []).map(normalizeOrgNode),
    maxDepth: partial.maxDepth ?? 5,
    createdAt: partial.createdAt ?? new Date().toISOString(),
    updatedAt: partial.updatedAt ?? new Date().toISOString(),
  };
}

function normalizeOrgNode(partial: Partial<OrgNode> & { agentId?: string }): OrgNode {
  return {
    agentId: partial.agentId ?? '',
    role: partial.role ?? 'custom',
    title: partial.title,
    managerId: partial.managerId,
    reportIds: partial.reportIds ?? [],
    budget: partial.budget,
    adapterId: partial.adapterId,
    promptAdditions: partial.promptAdditions,
  };
}