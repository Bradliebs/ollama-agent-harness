import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { scanFileForConflicts } from '../services/memoryConflictDetector';

// Match the resolution used by web/server.ts so the model's `remember`
// writes land in the same .harness/memory/ that assembleSystemContext reads
// from. Falls back to cwd when the env var is absent.
function memoryProjectDir(): string {
  return process.env.HARNESS_PROJECT_DIR && process.env.HARNESS_PROJECT_DIR.trim()
    ? process.env.HARNESS_PROJECT_DIR
    : process.cwd();
}

/**
 * MemoryTool — the agent writes observations, patterns, and decisions
 * back to memory files so they persist across sessions.
 * (Paper §7.2: Auto Memory — "contextually relevant memory entries")
 * (Paper §2.1: Contextual Adaptability — "the relationship improves over time")
 */
export const MemoryWriteTool: Tool = {
  name: 'remember',
  description: 'Save a note, decision, or learned pattern to memory so you remember it in future conversations. Memory is stored in plain text files the user can read and edit.',
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Where to save: "decision" (architectural choice), "pattern" (coding convention), "note" (general observation)',
      },
      title: { type: 'string', description: 'Brief title for this memory entry' },
      content: { type: 'string', description: 'The full text to remember' },
    },
    required: ['category', 'title', 'content'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const category = input.category as string;
    const title = input.title as string;
    const content = input.content as string;

    const memoryDir = path.join(memoryProjectDir(), '.harness', 'memory');
    await fs.mkdir(memoryDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    let filePath: string;
    let entry: string;

    switch (category) {
      case 'decision':
        filePath = path.join(memoryDir, 'decisions.md');
        entry = `\n### ${date}: ${title}\n${content}\n`;
        break;
      case 'pattern':
        filePath = path.join(memoryDir, 'patterns.md');
        entry = `\n### ${title}\n${content}\n`;
        break;
      default:
        filePath = path.join(memoryDir, 'notes.md');
        entry = `\n### ${date}: ${title}\n${content}\n`;
        break;
    }

    try {
      // Check for conflicts with existing memory before writing.
      const fileName = category === 'decision' ? 'decisions.md'
        : category === 'pattern' ? 'patterns.md'
        : 'notes.md';
      const conflictBody = `${title}\n${content}`;
      const conflicts = await scanFileForConflicts(memoryProjectDir(), fileName, conflictBody);
      const conflictWarning = conflicts.length > 0
        ? `\n⚠️  Conflict warning: This entry may contradict ${conflicts.length} existing section(s):\n` +
          conflicts.map((c) => `  - "${c.existingSection.title}" (${c.conflictType}, confidence ${Math.round(c.confidence * 100)}%): ${c.reason}`).join('\n') + '\n'
        : '';

      // Initialize file with header if it doesn't exist
      try {
        await fs.access(filePath);
      } catch {
        const header = category === 'decision' ? '# Decisions\n\nArchitectural and design decisions.\n'
          : category === 'pattern' ? '# Patterns\n\nLearned coding conventions and patterns.\n'
          : '# Notes\n\nGeneral observations and context.\n';
        await fs.writeFile(filePath, header, 'utf-8');
      }

      // Append the entry
      await fs.appendFile(filePath, entry, 'utf-8');

      return {
        success: true,
        output: `📝 Remembered "${title}" in ${category}s. Saved to ${path.relative(process.cwd(), filePath)}${conflictWarning}`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to save memory: ${msg}`, error: msg };
    }
  },
};

/**
 * MemoryReadTool — the agent reads its own memory files.
 */
export const MemoryReadTool: Tool = {
  name: 'recall',
  description: 'Read your saved memories (decisions, patterns, notes) to remember context from past conversations.',
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Which memories to read: "decision", "pattern", "note", or "all"',
      },
    },
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const category = (input.category as string) ?? 'all';
    const memoryDir = path.join(memoryProjectDir(), '.harness', 'memory');

    const files: string[] = [];
    if (category === 'all' || category === 'decision') files.push('decisions.md');
    if (category === 'all' || category === 'pattern') files.push('patterns.md');
    if (category === 'all' || category === 'note') files.push('notes.md');

    const parts: string[] = [];
    for (const file of files) {
      try {
        const content = await fs.readFile(path.join(memoryDir, file), 'utf-8');
        parts.push(content);
      } catch {
        // File doesn't exist yet — skip
      }
    }

    if (parts.length === 0) {
      return { success: true, output: 'No memories saved yet. Use the "remember" tool to save decisions, patterns, or notes.' };
    }

    return { success: true, output: parts.join('\n\n---\n\n') };
  },
};
