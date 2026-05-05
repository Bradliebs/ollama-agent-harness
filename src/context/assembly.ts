import * as fs from 'fs/promises';
import * as path from 'path';
import type { Message } from 'ollama';
import type { Tool } from '../types';
import { toolToSchema } from '../types/tool';
import { loadSkillsDir } from '../extensibility/skillLoader';

const PROJECT_MEMORY_MAX_CHARS = 8_000;
const AGENT_MEMORY_MAX_CHARS = 4_000;
const SKILL_LIST_MAX_ITEMS = 40;

export interface ContextConfig {
  systemPrompt: string;
  projectDir: string;
  memoryFiles?: string[];
  skillsDir?: string;
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
