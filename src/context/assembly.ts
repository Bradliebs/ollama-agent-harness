import * as fs from 'fs/promises';
import * as path from 'path';
import type { Message } from 'ollama';
import type { Tool } from '../types';
import { toolToSchema } from '../types/tool';

export interface ContextConfig {
  systemPrompt: string;
  projectDir: string;
  memoryFiles?: string[];
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
