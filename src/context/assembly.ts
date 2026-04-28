import * as fs from 'fs/promises';
import * as path from 'path';
import type { Message } from 'ollama';
import type { Tool } from '../types';
import { toolToSchema } from '../types/tool';
import { loadSkillsDir } from '../extensibility/skillLoader';

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
      parts.push(`\n--- ${path.basename(filePath)} ---\n${content}`);
    } catch {
      // File doesn't exist — skip silently
    }
  }

  // Load agent memory (auto-memory from .harness/memory/)
  const autoMemoryDir = path.join(config.projectDir, '.harness', 'memory');
  for (const file of ['decisions.md', 'patterns.md', 'notes.md']) {
    try {
      const content = await fs.readFile(path.join(autoMemoryDir, file), 'utf-8');
      parts.push(`\n--- Agent Memory: ${file} ---\n${content}`);
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
      const skillList = skills.map(s => `• ${s.name} — ${s.description} (triggers: ${s.triggers.join(', ') || 'none'})`).join('\n');
      parts.push(`\n--- Available Skills ---\nYou can invoke these skills using the "skill" tool. Use "create_skill" to create new ones.\n${skillList}`);
    }
  } catch {
    // No skills directory — skip
  }

  return parts.join('\n');
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
