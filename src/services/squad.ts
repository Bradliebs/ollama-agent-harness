// Squad channels.
//
// A squad is a persisted group of agents that share a routing policy. The
// model (or any caller) picks an agent for a message via `routeMessage`,
// which evaluates ordered regex rules and falls back to the lead agent when
// nothing matches. Handoff chains track depth so an agent passing work to
// another agent cannot loop forever.
//
// Persisted as `.harness/squads/<id>.json`. Mutations emit events through
// the event store so live WebSocket clients see roster changes.

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { emitEvent } from '../persistence/eventStore';

export type SquadAutonomy = 'supervised' | 'semi-autonomous' | 'autonomous';

export interface SquadAgentSlot {
  agentId: string;
  role: string;
  capabilities: string[];
}

export interface SquadRoutingRule {
  pattern: string;
  agentId: string;
  priority: number;
}

export interface SquadDefinition {
  id: string;
  name: string;
  description?: string;
  leadAgentId: string;
  roster: SquadAgentSlot[];
  routingRules: SquadRoutingRule[];
  autonomy: SquadAutonomy;
  /** Hard ceiling on handoff chain depth; default 3. */
  maxHandoffDepth: number;
  /** Per-squad concurrent sub-agent limit; default 3. */
  maxConcurrentAgents: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSquadInput {
  id?: string;
  name: string;
  description?: string;
  leadAgentId: string;
  roster?: SquadAgentSlot[];
  routingRules?: SquadRoutingRule[];
  autonomy?: SquadAutonomy;
  maxHandoffDepth?: number;
  maxConcurrentAgents?: number;
}

export interface RouteResult {
  agentId: string;
  reason: string;
  matchedRule?: SquadRoutingRule;
  isFallback: boolean;
}

export interface HandoffPlan {
  fromAgentId: string;
  toAgentId: string;
  depth: number;
  allowed: boolean;
  reason: string;
}

const DEFAULT_HANDOFF_DEPTH = 3;
const DEFAULT_CONCURRENT_AGENTS = 3;

function squadsDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'squads');
}

function squadFile(projectDir: string, id: string): string {
  return path.join(squadsDir(projectDir), `${id}.json`);
}

export async function listSquads(projectDir: string): Promise<SquadDefinition[]> {
  const dir = squadsDir(projectDir);
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const squads: SquadDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry.name), 'utf-8');
      squads.push(normalizeSquad(JSON.parse(raw) as Partial<SquadDefinition>));
    } catch {
      // Skip corrupt files; the read returns successfully with whatever loaded.
    }
  }
  return squads;
}

export async function getSquad(projectDir: string, id: string): Promise<SquadDefinition | undefined> {
  try {
    const raw = await fs.readFile(squadFile(projectDir, id), 'utf-8');
    return normalizeSquad(JSON.parse(raw) as Partial<SquadDefinition>);
  } catch {
    return undefined;
  }
}

export async function createSquad(projectDir: string, input: CreateSquadInput, now = new Date()): Promise<SquadDefinition> {
  if (!input.name?.trim()) throw new Error('Squad name is required.');
  if (!input.leadAgentId?.trim()) throw new Error('leadAgentId is required.');
  const id = (input.id?.trim() || crypto.randomUUID()).slice(0, 80);
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) throw new Error('Squad id must be alphanumeric with - or _ only.');
  const squad: SquadDefinition = normalizeSquad({
    id,
    name: input.name.trim(),
    description: input.description?.trim(),
    leadAgentId: input.leadAgentId.trim(),
    roster: input.roster ?? [],
    routingRules: input.routingRules ?? [],
    autonomy: input.autonomy ?? 'supervised',
    maxHandoffDepth: input.maxHandoffDepth ?? DEFAULT_HANDOFF_DEPTH,
    maxConcurrentAgents: input.maxConcurrentAgents ?? DEFAULT_CONCURRENT_AGENTS,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  const dir = squadsDir(projectDir);
  await fs.mkdir(dir, { recursive: true });
  const fp = squadFile(projectDir, id);
  try {
    await fs.access(fp);
    throw new Error(`Squad ${id} already exists.`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('already exists')) throw error;
    // ENOENT path — happy case.
  }
  await fs.writeFile(fp, JSON.stringify(squad, null, 2), 'utf-8');
  await emitEvent(projectDir, 'system', 'squad.created', { squadId: id, name: squad.name }, 'system', id).catch(() => {});
  return squad;
}

export async function updateSquad(projectDir: string, id: string, patch: Partial<CreateSquadInput>, now = new Date()): Promise<SquadDefinition> {
  const existing = await getSquad(projectDir, id);
  if (!existing) throw new Error(`Squad not found: ${id}`);
  const merged: SquadDefinition = normalizeSquad({
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
    ...(patch.leadAgentId !== undefined ? { leadAgentId: patch.leadAgentId.trim() } : {}),
    ...(patch.roster !== undefined ? { roster: patch.roster } : {}),
    ...(patch.routingRules !== undefined ? { routingRules: patch.routingRules } : {}),
    ...(patch.autonomy !== undefined ? { autonomy: patch.autonomy } : {}),
    ...(patch.maxHandoffDepth !== undefined ? { maxHandoffDepth: patch.maxHandoffDepth } : {}),
    ...(patch.maxConcurrentAgents !== undefined ? { maxConcurrentAgents: patch.maxConcurrentAgents } : {}),
    updatedAt: now.toISOString(),
  });
  await fs.writeFile(squadFile(projectDir, id), JSON.stringify(merged, null, 2), 'utf-8');
  await emitEvent(projectDir, 'system', 'squad.updated', { squadId: id }, 'system', id).catch(() => {});
  return merged;
}

export async function deleteSquad(projectDir: string, id: string): Promise<boolean> {
  try {
    await fs.unlink(squadFile(projectDir, id));
    await emitEvent(projectDir, 'system', 'squad.deleted', { squadId: id }, 'system', id).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick an agent for the message. Iterates routing rules in priority order
 * (highest first); first regex match wins. When nothing matches, the lead
 * agent is returned as a fallback.
 */
export function routeMessage(squad: SquadDefinition, message: string): RouteResult {
  const sortedRules = [...squad.routingRules].sort((a, b) => b.priority - a.priority);
  for (const rule of sortedRules) {
    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern, 'i');
    } catch {
      continue;
    }
    if (regex.test(message)) {
      return {
        agentId: rule.agentId,
        reason: `matched rule /${rule.pattern}/i (priority=${rule.priority})`,
        matchedRule: rule,
        isFallback: false,
      };
    }
  }
  return {
    agentId: squad.leadAgentId,
    reason: 'no rule matched — routed to lead agent',
    isFallback: true,
  };
}

/**
 * Decide whether an agent is allowed to hand off work to another agent.
 * Hard ceiling on chain depth prevents loops. Both agents must appear in
 * the squad roster (or be the lead).
 */
export function planHandoff(squad: SquadDefinition, fromAgentId: string, toAgentId: string, currentDepth: number): HandoffPlan {
  if (currentDepth >= squad.maxHandoffDepth) {
    return { fromAgentId, toAgentId, depth: currentDepth, allowed: false, reason: `handoff depth ${currentDepth} would exceed limit ${squad.maxHandoffDepth}` };
  }
  if (fromAgentId === toAgentId) {
    return { fromAgentId, toAgentId, depth: currentDepth, allowed: false, reason: 'cannot hand off to self' };
  }
  const knownAgents = new Set([squad.leadAgentId, ...squad.roster.map((slot) => slot.agentId)]);
  if (!knownAgents.has(fromAgentId)) {
    return { fromAgentId, toAgentId, depth: currentDepth, allowed: false, reason: `from-agent ${fromAgentId} is not on the squad roster` };
  }
  if (!knownAgents.has(toAgentId)) {
    return { fromAgentId, toAgentId, depth: currentDepth, allowed: false, reason: `to-agent ${toAgentId} is not on the squad roster` };
  }
  return { fromAgentId, toAgentId, depth: currentDepth + 1, allowed: true, reason: `handoff approved (depth ${currentDepth + 1}/${squad.maxHandoffDepth})` };
}

function normalizeSquad(value: Partial<SquadDefinition>): SquadDefinition {
  return {
    id: String(value.id ?? '').slice(0, 80),
    name: String(value.name ?? '').trim() || 'Untitled Squad',
    description: value.description?.toString().trim() || undefined,
    leadAgentId: String(value.leadAgentId ?? '').trim(),
    roster: Array.isArray(value.roster) ? value.roster.filter(isAgentSlotLike).map(normalizeSlot) : [],
    routingRules: Array.isArray(value.routingRules) ? value.routingRules.filter(isRuleLike).map(normalizeRule) : [],
    autonomy: normalizeAutonomy(value.autonomy),
    maxHandoffDepth: clamp(value.maxHandoffDepth, 1, 10, DEFAULT_HANDOFF_DEPTH),
    maxConcurrentAgents: clamp(value.maxConcurrentAgents, 1, 16, DEFAULT_CONCURRENT_AGENTS),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  };
}

function isAgentSlotLike(value: unknown): value is SquadAgentSlot {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.agentId === 'string' && typeof v.role === 'string';
}

function normalizeSlot(slot: SquadAgentSlot): SquadAgentSlot {
  return {
    agentId: slot.agentId.trim(),
    role: slot.role.trim(),
    capabilities: Array.isArray(slot.capabilities) ? slot.capabilities.filter((cap): cap is string => typeof cap === 'string') : [],
  };
}

function isRuleLike(value: unknown): value is SquadRoutingRule {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.pattern === 'string' && typeof v.agentId === 'string';
}

function normalizeRule(rule: SquadRoutingRule): SquadRoutingRule {
  return {
    pattern: rule.pattern,
    agentId: rule.agentId.trim(),
    priority: Number.isFinite(rule.priority) ? Math.floor(rule.priority) : 0,
  };
}

function normalizeAutonomy(value: unknown): SquadAutonomy {
  if (value === 'autonomous' || value === 'semi-autonomous' || value === 'supervised') return value;
  return 'supervised';
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
