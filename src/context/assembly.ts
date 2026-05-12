import * as fs from 'fs/promises';
import * as path from 'path';
import type { Message } from 'ollama';
import type { Tool } from '../types';
import { toolToSchema } from '../types/tool';
import { loadSkillsDir } from '../extensibility/skillLoader';
import { recall } from '../jarvis/knowledgeGraph';

const PROJECT_MEMORY_MAX_CHARS = 8_000;
const AGENT_MEMORY_MAX_CHARS = 4_000;
const RECALL_MAX_HITS = 3;
const SKILL_LIST_MAX_ITEMS = 40;

export interface ContextConfig {
  systemPrompt: string;
  projectDir: string;
  memoryFiles?: string[];
  skillsDir?: string;
  /** When set with a non-empty `recallQuery`, inject top KG hits as a memory section. */
  recallProjectDir?: string;
  recallQuery?: string;
}

export async function assembleSystemContext(config: ContextConfig): Promise<string> {
  const parts: string[] = [config.systemPrompt];

  // Append project memory files (CLAUDE.md equivalent)
  const memoryPaths = config.memoryFiles ?? [
    path.join(config.projectDir, 'HARNESS.md'),
    path.join(config.projectDir, 'forge-memory', 'patterns.md'),
  ];

  for (const filePath of memoryPaths) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      parts.push(`\n--- ${path.basename(filePath)} ---\n${trimContextText(content, PROJECT_MEMORY_MAX_CHARS, 'middle')}`);
    } catch {
      // File doesn't exist — skip silently
    }
  }

  // Load agent memory (auto-memory from .harness/memory/)
  const autoMemoryDir = path.join(config.projectDir, '.harness', 'memory');
  for (const file of ['decisions.md', 'patterns.md', 'notes.md']) {
    try {
      const content = await fs.readFile(path.join(autoMemoryDir, file), 'utf-8');
      parts.push(`\n--- Agent Memory: ${file} ---\n${trimContextText(content, AGENT_MEMORY_MAX_CHARS, 'tail')}`);
    } catch {
      // Not yet created — skip
    }
  }

  // Inject skill descriptions so the model knows what skills are available
  // (Paper §6.3: "only frontmatter descriptions stay in the prompt" — low context cost)
  const sDir = config.skillsDir ?? path.join(config.projectDir, '.harness', 'skills');
  try {
    const skills = await loadSkillsDir(sDir);
    if (skills.length > 0) {
      const listedSkills = skills.slice(0, SKILL_LIST_MAX_ITEMS);
      const skillList = listedSkills.map(s => `• ${s.name} — ${s.description} (triggers: ${s.triggers.join(', ') || 'none'})`).join('\n');
      const omitted = skills.length > listedSkills.length ? `\n...(${skills.length - listedSkills.length} more skill(s) omitted from prompt; use list_skills when needed)` : '';
      parts.push(`\n--- Available Skills ---\nYou can invoke these skills using the "skill" tool. Use "create_skill" to create new ones.\n${skillList}${omitted}`);
    }
  } catch {
    // No skills directory — skip
  }

  // Inject knowledge-graph recall when caller opts in (jarvis layer).
  // Pulls the top hits matching `recallQuery` from `recallProjectDir` as a
  // small memory section. Failure-tolerant: any error means we skip.
  if (config.recallProjectDir && config.recallQuery && config.recallQuery.trim().length > 0) {
    try {
      const result = await recall(config.recallProjectDir, config.recallQuery, RECALL_MAX_HITS);
      const lines: string[] = [];
      for (const e of result.entities) lines.push(`- entity ${e.type}: ${e.name} _(source: ${e.id})_`);
      for (const f of result.facts) lines.push(`- fact: ${f.subject} ${f.predicate} ${f.object} _(source: ${f.id})_`);
      for (const ed of result.edges) lines.push(`- edge: ${ed.from} ${ed.relation} ${ed.to} _(source: ${ed.id})_`);
      if (lines.length > 0) {
        parts.push(`\n--- Knowledge graph recall: ${config.recallQuery} ---\n${lines.join('\n')}\n_When citing these facts in your answer, reference the source id in parentheses._`);
      }
    } catch { /* skip */ }
  }

  return parts.join('\n');
}

function trimContextText(content: string, maxChars: number, mode: 'middle' | 'tail'): string {
  if (content.length <= maxChars) return content;
  if (mode === 'tail') {
    return `...(trimmed to latest ${maxChars} chars for prompt budget)\n${content.slice(-maxChars)}`;
  }
  const half = Math.floor(maxChars / 2);
  return `${content.slice(0, half)}\n...(trimmed ${content.length - maxChars} chars for prompt budget)...\n${content.slice(-half)}`;
}

export function assembleToolSchemas(tools: Tool[]): string {
  const schemas = tools.map(toolToSchema);
  return JSON.stringify(schemas, null, 2);
}

export function assembleUserContext(projectDir: string): Message {
  return {
    role: 'user' as const,
    content: `Current working directory: ${projectDir}\nDate: ${new Date().toISOString().split('T')[0]}`,
  };
}

export function buildInitialMessages(
  userMessage: string,
  projectDir: string,
): Message[] {
  return [
    assembleUserContext(projectDir),
    { role: 'user' as const, content: userMessage },
  ];
}

export function estimateTokenCount(messages: Message[]): number {
  // Rough estimate: ~4 chars per token
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  return Math.ceil(totalChars / 4);
}
