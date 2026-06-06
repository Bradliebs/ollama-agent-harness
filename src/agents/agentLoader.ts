// Custom agent loader.
//
// Reads agent definitions from `.harness/agents/*.md` files. Each agent has
// YAML frontmatter (name, description, role, model, etc.) and a body that
// becomes the system prompt. Mirrors the skill loader so authoring is
// familiar.
//
// Built-in role catalogue is also exported here so the harness can resolve
// either a custom agent (by name) or a built-in role (by id).

import * as fs from 'fs/promises';
import * as path from 'path';
import { atomicWriteFile } from '../persistence/atomicFile';
import type { HelperTaskType } from './modelRouting';
import { assertValidAgentId, isValidAgentId } from './agentId';

export type AgentRole = 'researcher' | 'developer' | 'qa' | 'writer' | 'architect' | 'security';

/**
 * Declarative reference to a child agent that this agent can delegate to.
 * When set on a definition, each entry is exposed to the parent agent as a
 * dedicated `subagent_<name>` tool, pre-bound to `agentId` and with `values`
 * substituted into the prompt via `{{key}}` templates.
 */
export interface SubAgentRef {
  /** Unique name within the parent. Surfaces as `subagent_<name>`. */
  name: string;
  /** Built-in role id or custom agent id to delegate to. */
  agentId: string;
  /** Pre-bound values merged into the child prompt via `{{key}}` substitution. */
  values?: Record<string, string>;
  /** Optional human-readable description. Used in the tool description. */
  description?: string;
}

export interface AgentDefinition {
  /** Stable id used by callers — matches the file basename without extension. */
  id: string;
  name: string;
  description: string;
  role?: AgentRole | string;
  /** Optional preferred model. */
  model?: string;
  /** Optional helper preset for routing decisions. */
  preset?: HelperTaskType;
  /** Optional explicit max-turns budget. */
  maxTurns?: number;
  /** Personality / tone hints. */
  personality?: string;
  /** Goal description. */
  goal?: string;
  /** Notable strengths. */
  strengths?: string[];
  /** Tool-name allowlist. When set, the subagent only sees these tools. */
  allowedTools?: string[];
  /**
   * Declarative sub-agent delegation surface. When set, the runtime exposes
   * each entry as a dedicated `subagent_<name>` tool the LLM can call.
   * Composition mirrors goose's sub-recipes: pre-bound role + values map.
   */
  subAgents?: SubAgentRef[];
  /** System prompt — the body of the markdown file (frontmatter stripped). */
  systemPrompt: string;
  /** True unless explicitly disabled in frontmatter. */
  enabled: boolean;
  /** Path the definition was loaded from. */
  filePath: string;
}

export interface AgentLoadDiagnostic {
  id: string;
  filePath: string;
  reason: 'missing-frontmatter' | 'unreadable-file' | 'invalid-agent-id' | 'unknown-sub-agent-ref';
  message: string;
}

export interface AgentDirectoryScan {
  agents: AgentDefinition[];
  diagnostics: AgentLoadDiagnostic[];
}

export const BUILTIN_AGENT_ROLES: AgentDefinition[] = [
  {
    id: 'researcher',
    name: 'Researcher',
    description: 'Investigates topics, gathers sources, and summarizes findings without taking destructive action.',
    role: 'researcher',
    preset: 'explore',
    personality: 'Thorough, skeptical, cites sources.',
    goal: 'Produce well-sourced findings that ground later decisions.',
    strengths: ['Search', 'Reading', 'Cross-referencing'],
    allowedTools: ['file_read', 'list_files', 'grep', 'web_fetch', 'web_search', 'web_read', 'recall'],
    systemPrompt: 'You are a Researcher. Investigate carefully, cite sources, and produce a focused summary. Prefer reading over writing. Never modify files.',
    enabled: true,
    filePath: '<builtin>',
  },
  {
    id: 'developer',
    name: 'Developer',
    description: 'Writes and edits code, runs tests, and fixes regressions within the project.',
    role: 'developer',
    preset: 'general',
    personality: 'Pragmatic, idiomatic, conservative with changes.',
    goal: 'Land minimum-correct code that passes existing tests.',
    strengths: ['Refactoring', 'Bug fixes', 'Tests'],
    systemPrompt: 'You are a Developer. Make minimum-correct code changes. Run tests after edits. Match existing style. Never refactor adjacent code unless explicitly asked.',
    enabled: true,
    filePath: '<builtin>',
  },
  {
    id: 'qa',
    name: 'QA',
    description: 'Designs and runs tests; reports failures with reproduction steps.',
    role: 'qa',
    preset: 'review',
    personality: 'Methodical, adversarial, precise.',
    goal: 'Catch defects and confirm fixes with evidence.',
    strengths: ['Test design', 'Reproduction', 'Edge cases'],
    systemPrompt: 'You are QA. Verify behavior with explicit test cases. Report defects with reproduction steps. Never patch code yourself — return findings.',
    enabled: true,
    filePath: '<builtin>',
  },
  {
    id: 'writer',
    name: 'Writer',
    description: 'Produces user-facing documentation, release notes, and explanations.',
    role: 'writer',
    preset: 'summarize',
    personality: 'Clear, concise, audience-aware.',
    goal: 'Turn raw findings into readable documents.',
    strengths: ['Markdown', 'Explanations', 'Structure'],
    systemPrompt: 'You are a Writer. Turn raw notes into clear, concise documents. Match the existing voice. Avoid filler.',
    enabled: true,
    filePath: '<builtin>',
  },
  {
    id: 'architect',
    name: 'Architect',
    description: 'Plans larger work, identifies risks, and proposes a sequence of steps.',
    role: 'architect',
    preset: 'plan',
    personality: 'Big-picture, considers trade-offs explicitly.',
    goal: 'Produce a plan with clear phases, risks, and validation criteria.',
    strengths: ['System design', 'Trade-off analysis', 'Sequencing'],
    systemPrompt: 'You are an Architect. Produce phased plans with explicit risks and validation steps. Prefer minimum-viable approaches over speculative flexibility.',
    enabled: true,
    filePath: '<builtin>',
  },
  {
    id: 'security',
    name: 'Security Analyst',
    description: 'Reviews code and configurations for vulnerabilities and risk.',
    role: 'security',
    preset: 'review',
    personality: 'Cautious, focuses on attack surface.',
    goal: 'Identify exploitable conditions and recommend mitigations.',
    strengths: ['OWASP Top 10', 'Secrets', 'Privilege boundaries'],
    systemPrompt: 'You are a Security Analyst. Review for OWASP Top 10 risks, secret leakage, and privilege escalation. Recommend specific mitigations.',
    enabled: true,
    filePath: '<builtin>',
  },
];

export async function loadAgentDefinitions(projectDir: string): Promise<AgentDefinition[]> {
  return (await scanAgentDefinitions(projectDir)).agents;
}

export async function scanAgentDefinitions(projectDir: string): Promise<AgentDirectoryScan> {
  const agents: AgentDefinition[] = [];
  const diagnostics: AgentLoadDiagnostic[] = [];
  const dir = path.join(projectDir, '.harness', 'agents');
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { agents, diagnostics };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = path.join(dir, entry.name);
    const id = entry.name.replace(/\.md$/, '');
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const definition = parseAgentFile(content, filePath, id);
      if (!definition) {
        diagnostics.push({ id, filePath, reason: 'missing-frontmatter', message: 'Agent file is missing YAML frontmatter.' });
        continue;
      }
      if (!isValidAgentId(definition.id)) {
        diagnostics.push({
          id: definition.id,
          filePath,
          reason: 'invalid-agent-id',
          message: `Agent id ${JSON.stringify(definition.id)} is not a valid identifier (alphanumeric with - or _ only).`,
        });
        continue;
      }
      agents.push(definition);
    } catch (error) {
      diagnostics.push({ id, filePath, reason: 'unreadable-file', message: error instanceof Error ? error.message : String(error) });
    }
  }
  // Cross-agent validation: surface sub-recipe references that point at ids
  // we never loaded so authors don't have to wait for tool-invocation time to
  // discover a typo or a deleted agent.
  const knownIds = new Set<string>([
    ...agents.map((agent) => agent.id),
    ...BUILTIN_AGENT_ROLES.map((agent) => agent.id),
  ]);
  for (const agent of agents) {
    if (!agent.subAgents) continue;
    for (const ref of agent.subAgents) {
      if (knownIds.has(ref.agentId)) continue;
      diagnostics.push({
        id: agent.id,
        filePath: agent.filePath,
        reason: 'unknown-sub-agent-ref',
        message: `Agent ${JSON.stringify(agent.id)} declares sub-agent ${JSON.stringify(ref.name)} that targets unknown agent id ${JSON.stringify(ref.agentId)}.`,
      });
    }
  }
  return { agents, diagnostics };
}

export function parseAgentFile(content: string, filePath: string, fallbackId?: string): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const frontmatter = parseSimpleYaml(match[1]);
  const body = match[2].trim();
  const enabledRaw = frontmatter.enabled;
  const enabled = enabledRaw === undefined
    ? true
    : !(enabledRaw === false || (typeof enabledRaw === 'string' && enabledRaw.toLowerCase() === 'false'));
  // Coerce id/name to strings: YAML parses unquoted all-digit values (e.g.
  // `id: 2006`) as numbers. Downstream lookups use strict equality with the
  // string from URL params or POST bodies, so a numeric id silently fails
  // to match.
  const rawId = frontmatter.id;
  const idFromFrontmatter = typeof rawId === 'string' ? rawId
    : (typeof rawId === 'number' || typeof rawId === 'boolean') ? String(rawId)
    : undefined;
  const id = idFromFrontmatter ?? fallbackId ?? path.basename(filePath, '.md');
  const rawName = frontmatter.name;
  const name = typeof rawName === 'string' ? rawName
    : (typeof rawName === 'number' || typeof rawName === 'boolean') ? String(rawName)
    : id;
  return {
    id,
    name,
    description: (frontmatter.description as string) ?? '',
    role: typeof frontmatter.role === 'string' ? frontmatter.role : undefined,
    model: typeof frontmatter.model === 'string' ? frontmatter.model : undefined,
    preset: typeof frontmatter.preset === 'string' ? frontmatter.preset as HelperTaskType : undefined,
    maxTurns: typeof frontmatter.max_turns === 'number' ? frontmatter.max_turns : undefined,
    personality: typeof frontmatter.personality === 'string' ? frontmatter.personality : undefined,
    goal: typeof frontmatter.goal === 'string' ? frontmatter.goal : undefined,
    strengths: Array.isArray(frontmatter.strengths) ? (frontmatter.strengths as string[]).filter((item) => typeof item === 'string') : undefined,
    allowedTools: Array.isArray(frontmatter.allowed_tools) ? (frontmatter.allowed_tools as string[]).filter((item) => typeof item === 'string') : undefined,
    subAgents: Array.isArray(frontmatter.sub_agents) ? coerceSubAgents(frontmatter.sub_agents) : undefined,
    systemPrompt: body || (typeof frontmatter.system_prompt === 'string' ? frontmatter.system_prompt : ''),
    enabled,
    filePath,
  };
}

export function resolveAgentDefinition(
  agentId: string,
  customAgents: AgentDefinition[],
): AgentDefinition | undefined {
  const fromCustom = customAgents.find((agent) => agent.id === agentId && agent.enabled);
  if (fromCustom) return fromCustom;
  return BUILTIN_AGENT_ROLES.find((agent) => agent.id === agentId);
}

export interface CreateCustomAgentInput {
  id: string;
  name: string;
  description: string;
  role?: string;
  model?: string;
  preset?: HelperTaskType;
  personality?: string;
  goal?: string;
  systemPrompt: string;
  allowedTools?: string[];
}

export async function writeCustomAgent(projectDir: string, input: CreateCustomAgentInput): Promise<string> {
  assertValidAgentId(input.id);
  if (!input.systemPrompt.trim()) throw new Error('systemPrompt is required.');
  const dir = path.join(projectDir, '.harness', 'agents');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${input.id}.md`);
  const lines: string[] = ['---'];
  lines.push(`id: ${input.id}`);
  lines.push(`name: ${escapeYaml(input.name)}`);
  lines.push(`description: ${escapeYaml(input.description)}`);
  if (input.role) lines.push(`role: ${escapeYaml(input.role)}`);
  if (input.model) lines.push(`model: ${escapeYaml(input.model)}`);
  if (input.preset) lines.push(`preset: ${input.preset}`);
  if (input.personality) lines.push(`personality: ${escapeYaml(input.personality)}`);
  if (input.goal) lines.push(`goal: ${escapeYaml(input.goal)}`);
  if (input.allowedTools && input.allowedTools.length > 0) {
    lines.push('allowed_tools:');
    for (const tool of input.allowedTools) lines.push(`  - ${tool}`);
  }
  lines.push('---', '', input.systemPrompt.trim(), '');
  await atomicWriteFile(filePath, lines.join('\n'));
  return filePath;
}

function escapeYaml(value: string): string {
  if (value.includes(':') || value.includes('#') || value.includes('"')) {
    return JSON.stringify(value);
  }
  return value;
}

function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  // List/object parser state. Supports:
  //   key: value
  //   key:
  //     - scalar
  //   key:
  //     - field: value           (object item)
  //       other: value
  //       nested:
  //         k: v
  // The object/nested distinction uses the first field's indent as the object
  // base; anything deeper is treated as a nested map field.
  let listKey: string | null = null;
  let currentObject: Record<string, unknown> | null = null;
  let objectFieldIndent = -1;
  let nestedMapKey: string | null = null;
  let nestedMap: Record<string, unknown> | null = null;

  const flushNested = () => {
    if (currentObject && nestedMapKey && nestedMap) {
      currentObject[nestedMapKey] = nestedMap;
    }
    nestedMapKey = null;
    nestedMap = null;
  };
  const flushObject = () => {
    flushNested();
    if (currentObject && listKey) {
      const list = (result[listKey] as unknown[] | undefined) ?? [];
      list.push(currentObject);
      result[listKey] = list;
    }
    currentObject = null;
    objectFieldIndent = -1;
  };
  const resetList = () => {
    flushObject();
    listKey = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { resetList(); continue; }

    // List item start.
    const listItemMatch = line.match(/^(\s+)-\s+(.*)$/);
    if (listKey && listItemMatch) {
      const rest = listItemMatch[2];
      flushObject();
      const colonIdx = rest.indexOf(':');
      if (colonIdx === -1) {
        // Scalar list item.
        const value = rest.replace(/^"|"$/g, '').trim();
        const list = (result[listKey] as unknown[] | undefined) ?? [];
        list.push(value);
        result[listKey] = list;
        continue;
      }
      // Object list item — first field.
      const key = rest.slice(0, colonIdx).trim();
      const rawValue = rest.slice(colonIdx + 1).trim();
      currentObject = {};
      objectFieldIndent = -1;
      if (rawValue === '') {
        // First field is itself a nested map header.
        nestedMapKey = key;
        nestedMap = {};
      } else {
        currentObject[key] = coerceYamlScalar(rawValue);
      }
      continue;
    }

    // Continuation of an open object: indented `key: value`.
    if (listKey && currentObject) {
      const contMatch = line.match(/^(\s+)([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (contMatch) {
        const indent = contMatch[1].length;
        const key = contMatch[2];
        const rawValue = contMatch[3];
        // Anchor object field indent on the first continuation line.
        if (objectFieldIndent === -1) objectFieldIndent = indent;
        const isNestedField = nestedMapKey !== null && nestedMap !== null && indent > objectFieldIndent;
        if (isNestedField) {
          if (rawValue !== '') {
            nestedMap![key] = coerceYamlScalar(rawValue);
          }
          // Nested-map header inside a nested map is unsupported; ignore quietly.
          continue;
        }
        // New field on currentObject (closes any open nested map first).
        flushNested();
        if (rawValue === '') {
          nestedMapKey = key;
          nestedMap = {};
        } else {
          currentObject[key] = coerceYamlScalar(rawValue);
        }
        continue;
      }
      // Anything else ends the open object/list.
      resetList();
    }

    // Top-level key. Any non-list-item line closes a running list.
    resetList();
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    if (rawValue === '') {
      listKey = key;
      result[key] = [];
      continue;
    }
    result[key] = coerceYamlScalar(rawValue);
  }
  resetList();
  return result;
}

function coerceYamlScalar(rawValue: string): unknown {
  if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
    return rawValue.slice(1, -1);
  }
  if (rawValue === 'true' || rawValue === 'false') {
    return rawValue === 'true';
  }
  const numeric = Number(rawValue);
  if (rawValue !== '' && !Number.isNaN(numeric) && /^-?\d+(\.\d+)?$/.test(rawValue)) {
    return numeric;
  }
  return rawValue;
}

function coerceSubAgents(raw: unknown[]): SubAgentRef[] {
  const out: SubAgentRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    const agentIdRaw = obj.agent_id ?? obj.agentId;
    const agentId = typeof agentIdRaw === 'string' ? agentIdRaw.trim() : '';
    if (!name || !agentId) continue;
    if (!isValidAgentId(agentId)) continue;
    const ref: SubAgentRef = { name, agentId };
    if (typeof obj.description === 'string' && obj.description.trim()) {
      ref.description = obj.description;
    }
    if (obj.values && typeof obj.values === 'object' && !Array.isArray(obj.values)) {
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj.values as Record<string, unknown>)) {
        if (v === null || v === undefined) continue;
        values[k] = typeof v === 'string' ? v : String(v);
      }
      if (Object.keys(values).length > 0) ref.values = values;
    }
    out.push(ref);
  }
  return out;
}
