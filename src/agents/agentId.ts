// Canonical agent-id contract.
//
// Centralises (1) the syntactic shape of a valid agent id and (2) strict
// resolution semantics so callers can fail loudly when an id is bogus
// instead of silently running with no role/defaults. The lookup-or-undefined
// variant still lives in agentLoader (`resolveAgentDefinition`) for the
// genuinely-optional case.

import { BUILTIN_AGENT_ROLES, resolveAgentDefinition, type AgentDefinition } from './agentLoader';

/** Single source of truth for the agent-id format. */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

export function isValidAgentId(id: unknown): id is string {
  return typeof id === 'string' && AGENT_ID_PATTERN.test(id);
}

export function assertValidAgentId(id: unknown, context?: string): asserts id is string {
  if (isValidAgentId(id)) return;
  const where = context ? ` (${context})` : '';
  const got = typeof id === 'string' ? JSON.stringify(id) : `<${typeof id}>`;
  throw new Error(`Agent id must be alphanumeric with - or _ only${where}. Got: ${got}`);
}

export class UnknownAgentError extends Error {
  readonly agentId: string;
  readonly available: string[];
  constructor(agentId: string, available: string[]) {
    super(
      `Unknown agent id "${agentId}". Available: ${available.length > 0 ? available.join(', ') : '(none)'}.`,
    );
    this.name = 'UnknownAgentError';
    this.agentId = agentId;
    this.available = available;
  }
}

/**
 * Strict variant of `resolveAgentDefinition`: throws `UnknownAgentError`
 * (with the list of available ids) when the id doesn't resolve to an
 * enabled custom agent or a built-in role.
 */
export function requireAgentDefinition(
  agentId: string,
  customAgents: AgentDefinition[],
): AgentDefinition {
  const found = resolveAgentDefinition(agentId, customAgents);
  if (found) return found;
  const enabledCustom = customAgents.filter((agent) => agent.enabled).map((agent) => agent.id);
  const builtinIds = BUILTIN_AGENT_ROLES.map((agent) => agent.id);
  const available = Array.from(new Set([...enabledCustom, ...builtinIds])).sort();
  throw new UnknownAgentError(agentId, available);
}
