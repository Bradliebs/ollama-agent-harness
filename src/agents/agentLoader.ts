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

export type AgentRole = 'researcher' | 'developer' | 'qa' | 'writer' | 'architect' | 'security';

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
  reason: 'missing-frontmatter' | 'unreadable-file';
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
      agents.push(definition);
    } catch (error) {
      diagnostics.push({ id, filePath, reason: 'unreadable-file', message: error instanceof Error ? error.message : String(error) });
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
  const id = (frontmatter.id as string) ?? fallbackId ?? path.basename(filePath, '.md');
  const name = (frontmatter.name as string) ?? id;
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
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(input.id)) throw new Error('Agent id must be alphanumeric with - or _ only.');
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
  let currentListKey: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { currentListKey = null; continue; }
    if (currentListKey && /^\s+-\s+/.test(line)) {
      const value = line.replace(/^\s+-\s+/, '').replace(/^"|"$/g, '').trim();
      const list = (result[currentListKey] as string[] | undefined) ?? [];
      list.push(value);
      result[currentListKey] = list;
      continue;
    }
    currentListKey = null;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    if (rawValue === '') {
      currentListKey = key;
      result[key] = [];
      continue;
    }
    if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
      result[key] = rawValue.slice(1, -1);
      continue;
    }
    if (rawValue === 'true' || rawValue === 'false') {
      result[key] = rawValue === 'true';
      continue;
    }
    const numeric = Number(rawValue);
    if (rawValue !== '' && !Number.isNaN(numeric) && /^-?\d+(\.\d+)?$/.test(rawValue)) {
      result[key] = numeric;
      continue;
    }
    result[key] = rawValue;
  }
  return result;
}
