// Agent-callable tools for squad channels.
//
// Lets the model inspect and use the squad system without going through
// the REST API. Read-only tool that supports four actions:
//   list      — list all squads (id, name, lead, roster size)
//   get       — full definition for one squad
//   route     — compute which agent a message would route to
//   handoff   — check whether a from→to handoff would be allowed
//
// Mutating squad operations (create / update / delete) stay UI-only and
// REST-only because they affect persistent multi-agent topology — that
// is governed by the operator, not the model.

import type { Tool, ToolResult } from '../types';
import { getSquad, listSquads, planHandoff, routeMessage } from '../services/squad';

function projectDir(): string {
  return process.env.HARNESS_PROJECT_DIR && process.env.HARNESS_PROJECT_DIR.trim()
    ? process.env.HARNESS_PROJECT_DIR
    : process.cwd();
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function ok(output: string): ToolResult { return { success: true, output }; }
function fail(error: string): ToolResult { return { success: false, output: error, error }; }

export const SquadInspectTool: Tool = {
  name: 'squad_inspect',
  description: 'Inspect squad channels: list squads, get one squad definition, compute the routing target for a message, or test a handoff. Read-only — does not mutate squad state.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'One of: list, get, route, handoff' },
      squad_id: { type: 'string', description: 'Required for get, route, handoff' },
      message: { type: 'string', description: 'Message text for route' },
      from_agent_id: { type: 'string', description: 'For handoff: source agent id' },
      to_agent_id: { type: 'string', description: 'For handoff: target agent id' },
      current_depth: { type: 'number', description: 'For handoff: current chain depth (default 0)' },
    },
    required: ['action'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const action = asString(input.action) ?? '';
    try {
      switch (action) {
        case 'list': {
          const squads = await listSquads(projectDir());
          if (squads.length === 0) return ok('No squads defined.');
          const lines = squads.map((squad) => `${squad.id}: ${squad.name} — lead=${squad.leadAgentId}, roster=${squad.roster.length}, autonomy=${squad.autonomy}`);
          return ok(lines.join('\n'));
        }
        case 'get': {
          const id = asString(input.squad_id);
          if (!id) return fail('squad_id is required for get');
          const squad = await getSquad(projectDir(), id);
          if (!squad) return fail(`Squad not found: ${id}`);
          return ok(JSON.stringify(squad, null, 2));
        }
        case 'route': {
          const id = asString(input.squad_id);
          const message = asString(input.message);
          if (!id) return fail('squad_id is required for route');
          if (!message) return fail('message is required for route');
          const squad = await getSquad(projectDir(), id);
          if (!squad) return fail(`Squad not found: ${id}`);
          const result = routeMessage(squad, message);
          return ok(JSON.stringify(result, null, 2));
        }
        case 'handoff': {
          const id = asString(input.squad_id);
          const fromId = asString(input.from_agent_id);
          const toId = asString(input.to_agent_id);
          const currentDepth = typeof input.current_depth === 'number' ? input.current_depth : 0;
          if (!id) return fail('squad_id is required for handoff');
          if (!fromId) return fail('from_agent_id is required for handoff');
          if (!toId) return fail('to_agent_id is required for handoff');
          const squad = await getSquad(projectDir(), id);
          if (!squad) return fail(`Squad not found: ${id}`);
          const plan = planHandoff(squad, fromId, toId, currentDepth);
          return ok(JSON.stringify(plan, null, 2));
        }
        default:
          return fail(`Unknown action: ${action}. Use list, get, route, handoff.`);
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};
