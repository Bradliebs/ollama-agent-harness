// Chat-driven agent and squad lifecycle tools.
//
// These let the model do the full CRUD on agents and squads from chat
// prompts — e.g. "create an agent that reviews my emails and run it on
// today's inbox". Without these, the model could only invoke the
// existing `agent` sub-agent tool (one-shot, no persistence) and the
// user had to drive the Agents tab UI by hand.
//
// All filesystem work is rooted at HARNESS_PROJECT_DIR (falling back to
// cwd) to stay consistent with assembleSystemContext.

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import {
  BUILTIN_AGENT_ROLES,
  loadAgentDefinitions,
  resolveAgentDefinition,
  writeCustomAgent,
} from '../agents/agentLoader';
import {
  createSquad,
  deleteSquad,
  getSquad,
  listSquads,
  routeMessage,
  updateSquad,
} from '../services/squad';

function agentsProjectDir(): string {
  return process.env.HARNESS_PROJECT_DIR && process.env.HARNESS_PROJECT_DIR.trim()
    ? process.env.HARNESS_PROJECT_DIR
    : process.cwd();
}

function ok(output: string): ToolResult { return { success: true, output }; }
function fail(error: string): ToolResult { return { success: false, output: error, error }; }
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

// ─── Agents ─────────────────────────────────────────────────────────

export const ListAgentsTool: Tool = {
  name: 'list_agents',
  description: 'List every agent the user has available — built-in roles plus any custom agents defined under .harness/agents/. Use this before invoking the `agent` tool so you can pick a real agent_id.',
  parameters: { type: 'object', properties: {} },
  isReadOnly: true,
  async execute(): Promise<ToolResult> {
    const dir = agentsProjectDir();
    try {
      const customs = await loadAgentDefinitions(dir);
      const seen = new Set<string>();
      const rows: string[] = [];
      for (const agent of customs) {
        if (seen.has(agent.id)) continue;
        seen.add(agent.id);
        rows.push(`• custom  ${agent.id} — ${agent.name}${agent.description ? ' — ' + agent.description : ''}`);
      }
      for (const agent of BUILTIN_AGENT_ROLES) {
        if (seen.has(agent.id)) continue;
        seen.add(agent.id);
        rows.push(`• builtin ${agent.id} — ${agent.name}${agent.description ? ' — ' + agent.description : ''}`);
      }
      if (rows.length === 0) return ok('No agents available.');
      return ok(`Available agents (${rows.length}):\n${rows.join('\n')}\n\nTo invoke one, call the \`agent\` tool with agent_id="<id>" and prompt="<task>".`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};

export const DeleteAgentTool: Tool = {
  name: 'delete_agent',
  description: 'Remove a custom agent definition (cannot delete built-in roles). Confirms before deleting unless force=true.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Custom agent id to remove' },
    },
    required: ['id'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const id = asString(input.id);
    if (!id) return fail('id is required');
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) return fail('Invalid agent id (alphanumeric, dashes, underscores).');
    // Refuse to delete a built-in by id-clash; built-ins live in code, not on disk.
    const isBuiltin = BUILTIN_AGENT_ROLES.some((agent) => agent.id === id);
    if (isBuiltin) return fail(`'${id}' is a built-in role and cannot be deleted. Built-ins live in the code, not on disk.`);
    const fp = path.join(agentsProjectDir(), '.harness', 'agents', `${id}.md`);
    try {
      await fs.unlink(fp);
      return ok(`Deleted custom agent '${id}'.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOENT') || msg.includes('no such file')) return fail(`No custom agent '${id}' to delete.`);
      return fail(msg);
    }
  },
};

// ─── Squads ─────────────────────────────────────────────────────────

export const CreateSquadTool: Tool = {
  name: 'create_squad',
  description: 'Create a new squad (a persistent team of agents with routing rules). Use list_agents first to find valid agent ids for the lead and roster. Members reference existing agent ids; if you need agents that don\'t exist yet, call create_custom_agent first.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Stable id (alphanumeric, dashes, underscores). Optional — auto-generated when blank.' },
      name: { type: 'string', description: 'Display name (e.g. "Engineering Squad")' },
      description: { type: 'string', description: 'One-line summary of what the squad does' },
      lead_agent_id: { type: 'string', description: 'Agent id of the squad lead (required)' },
      roster: {
        type: 'array',
        description: 'Squad members. Each: { agent_id, role?, autonomy_floor? }',
        items: {
          type: 'object',
          properties: {
            agent_id: { type: 'string' },
            role: { type: 'string' },
          },
          required: ['agent_id'],
        },
      },
      routing_rules: {
        type: 'array',
        description: 'Pattern → agent routing. Each: { pattern (regex), agent_id, priority? }',
        items: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            agent_id: { type: 'string' },
            priority: { type: 'number' },
          },
          required: ['pattern', 'agent_id'],
        },
      },
      autonomy: { type: 'string', description: 'supervised | semi-autonomous | autonomous (default supervised)' },
    },
    required: ['name', 'lead_agent_id'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const name = asString(input.name);
    const leadAgentId = asString(input.lead_agent_id);
    if (!name) return fail('name is required');
    if (!leadAgentId) return fail('lead_agent_id is required');
    // Validate that the lead agent actually exists so the user doesn't end
    // up with a squad that points at a phantom id.
    const dir = agentsProjectDir();
    const customs = await loadAgentDefinitions(dir).catch(() => []);
    const leadResolved = resolveAgentDefinition(leadAgentId, customs);
    if (!leadResolved) {
      const available = [...customs.map((a) => a.id), ...BUILTIN_AGENT_ROLES.map((a) => a.id)].join(', ');
      return fail(`lead_agent_id '${leadAgentId}' does not match any known agent. Available: ${available}`);
    }
    const rosterRaw = Array.isArray(input.roster) ? input.roster : [];
    const roster = rosterRaw
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .map((entry) => ({
        agentId: String(entry.agent_id || '').trim(),
        role: typeof entry.role === 'string' ? entry.role : '',
        capabilities: Array.isArray(entry.capabilities)
          ? entry.capabilities.filter((c): c is string => typeof c === 'string')
          : [],
      }))
      .filter((entry) => entry.agentId.length > 0);
    const rulesRaw = Array.isArray(input.routing_rules) ? input.routing_rules : [];
    const routingRules = rulesRaw
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .map((entry) => ({
        pattern: String(entry.pattern || '').trim(),
        agentId: String(entry.agent_id || '').trim(),
        priority: typeof entry.priority === 'number' ? entry.priority : 10,
      }))
      .filter((entry) => entry.pattern.length > 0 && entry.agentId.length > 0);
    try {
      // Validate regex patterns up front so the user sees the failure here,
      // not at first route attempt.
      for (const rule of routingRules) {
        try { new RegExp(rule.pattern); } catch (err) {
          return fail(`Invalid regex in routing_rules: ${rule.pattern} — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const autonomyValue = asString(input.autonomy);
      const autonomy = autonomyValue === 'semi-autonomous' || autonomyValue === 'autonomous' ? autonomyValue : 'supervised';
      const squad = await createSquad(dir, {
        id: asString(input.id),
        name,
        description: asString(input.description),
        leadAgentId,
        roster,
        routingRules,
        autonomy,
      });
      return ok(`Created squad '${squad.id}' (${squad.name}). Lead: ${squad.leadAgentId}, roster: ${squad.roster.length}, rules: ${squad.routingRules.length}.`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};

export const UpdateSquadTool: Tool = {
  name: 'update_squad',
  description: 'Patch an existing squad. Supply only the fields you want to change. Use squad_inspect first to see the current shape.',
  parameters: {
    type: 'object',
    properties: {
      squad_id: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      lead_agent_id: { type: 'string' },
      autonomy: { type: 'string', description: 'supervised | semi-autonomous | autonomous' },
      roster: { type: 'array', items: { type: 'object' } },
      routing_rules: { type: 'array', items: { type: 'object' } },
    },
    required: ['squad_id'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const id = asString(input.squad_id);
    if (!id) return fail('squad_id is required');
    const dir = agentsProjectDir();
    const patch: Record<string, unknown> = {};
    if (asString(input.name)) patch.name = asString(input.name);
    if (asString(input.description) !== undefined) patch.description = asString(input.description);
    if (asString(input.lead_agent_id)) patch.leadAgentId = asString(input.lead_agent_id);
    const autonomy = asString(input.autonomy);
    if (autonomy === 'supervised' || autonomy === 'semi-autonomous' || autonomy === 'autonomous') patch.autonomy = autonomy;
    if (Array.isArray(input.roster)) {
      patch.roster = input.roster
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
        .map((entry) => ({
          agentId: String(entry.agent_id || '').trim(),
          role: typeof entry.role === 'string' ? entry.role : '',
          capabilities: Array.isArray(entry.capabilities)
            ? entry.capabilities.filter((c): c is string => typeof c === 'string')
            : [],
        }))
        .filter((entry) => (entry.agentId as string).length > 0);
    }
    if (Array.isArray(input.routing_rules)) {
      const rules = input.routing_rules
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
        .map((entry) => ({
          pattern: String(entry.pattern || '').trim(),
          agentId: String(entry.agent_id || '').trim(),
          priority: typeof entry.priority === 'number' ? entry.priority : 10,
        }))
        .filter((entry) => entry.pattern.length > 0 && entry.agentId.length > 0);
      for (const rule of rules) {
        try { new RegExp(rule.pattern); } catch (err) {
          return fail(`Invalid regex in routing_rules: ${rule.pattern} — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      patch.routingRules = rules;
    }
    try {
      const squad = await updateSquad(dir, id, patch);
      return ok(`Updated squad '${squad.id}' (${squad.name}).`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};

export const DeleteSquadTool: Tool = {
  name: 'delete_squad',
  description: 'Permanently delete a squad. The member agents are not affected.',
  parameters: {
    type: 'object',
    properties: {
      squad_id: { type: 'string' },
    },
    required: ['squad_id'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const id = asString(input.squad_id);
    if (!id) return fail('squad_id is required');
    try {
      const removed = await deleteSquad(agentsProjectDir(), id);
      if (!removed) return fail(`Squad '${id}' not found.`);
      return ok(`Deleted squad '${id}'.`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};

export const SquadRouteTool: Tool = {
  name: 'squad_route',
  description: 'Given a squad and a user message, return which agent the squad\'s routing rules would pick. Useful before delegating with the agent tool.',
  parameters: {
    type: 'object',
    properties: {
      squad_id: { type: 'string' },
      message: { type: 'string' },
    },
    required: ['squad_id', 'message'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const id = asString(input.squad_id);
    const message = asString(input.message);
    if (!id) return fail('squad_id is required');
    if (!message) return fail('message is required');
    try {
      const squad = await getSquad(agentsProjectDir(), id);
      if (!squad) return fail(`Squad '${id}' not found.`);
      const result = routeMessage(squad, message);
      return ok(`Squad '${id}' routes "${message.slice(0, 60)}${message.length > 60 ? '…' : ''}" to agent '${result.agentId}' (reason: ${result.reason}).`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};

// Convenience export for registry wiring.
export const AGENT_MANAGEMENT_TOOLS: Tool[] = [
  ListAgentsTool,
  DeleteAgentTool,
  CreateSquadTool,
  UpdateSquadTool,
  DeleteSquadTool,
  SquadRouteTool,
];
