import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { scanFileForConflicts, selectBlockingConflicts, DEFAULT_CONFLICT_BLOCK_THRESHOLD } from '../services/memoryConflictDetector';
import { getCurrentSessionId } from './sessionContext';
import * as ccmem from '../services/conceptMemoryClient';

// Match the resolution used by web/server.ts so the model's `remember`
// writes land in the same .harness/memory/ that assembleSystemContext reads
// from. Falls back to cwd when the env var is absent.
function memoryProjectDir(): string {
  return process.env.HARNESS_PROJECT_DIR && process.env.HARNESS_PROJECT_DIR.trim()
    ? process.env.HARNESS_PROJECT_DIR
    : process.cwd();
}

// Active session, when known. Prefers the async-context binding set around
// tool dispatch (correct under concurrent sessions); falls back to the
// HARNESS_SESSION_ID env var for hosts that set it process-wide. Best-effort
// provenance: absent => the section simply records no session (never a wrong
// one). Read per-call so a long-lived process picks up the current value.
function currentSessionId(): string | undefined {
  const ctx = getCurrentSessionId();
  if (ctx) return ctx;
  const id = process.env.HARNESS_SESSION_ID?.trim();
  return id ? id : undefined;
}

// Opt-in: block a write when it conflicts (>= threshold) with existing memory.
// Default OFF preserves the advisory warn-then-write behaviour.
function conflictEnforceEnabled(): boolean {
  return process.env.HARNESS_MEMORY_CONFLICT_ENFORCE === '1';
}

function conflictBlockThreshold(): number {
  const raw = Number.parseFloat(process.env.HARNESS_MEMORY_CONFLICT_THRESHOLD ?? '');
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_CONFLICT_BLOCK_THRESHOLD;
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
    // Provenance metadata line, recorded as the first body line so parseMemoryFile
    // can recover which session/tool produced this entry. created-by is always
    // known; source-session only when the host set HARNESS_SESSION_ID.
    const sessionId = currentSessionId();
    const metaParts = ['importance: medium', `created: ${date}`];
    if (sessionId) metaParts.push(`source-session: ${sessionId}`);
    metaParts.push('created-by: remember');
    const meta = `<!-- ${metaParts.join(' | ')} -->`;
    let filePath: string;
    let entry: string;

    switch (category) {
      case 'decision':
        filePath = path.join(memoryDir, 'decisions.md');
        entry = `\n### ${date}: ${title}\n${meta}\n${content}\n`;
        break;
      case 'pattern':
        filePath = path.join(memoryDir, 'patterns.md');
        entry = `\n### ${title}\n${meta}\n${content}\n`;
        break;
      default:
        filePath = path.join(memoryDir, 'notes.md');
        entry = `\n### ${date}: ${title}\n${meta}\n${content}\n`;
        break;
    }

    try {
      // Check for conflicts with existing memory before writing.
      const fileName = category === 'decision' ? 'decisions.md'
        : category === 'pattern' ? 'patterns.md'
        : 'notes.md';
      const conflictBody = `${title}\n${content}`;
      const conflicts = await scanFileForConflicts(memoryProjectDir(), fileName, conflictBody);

      // Enforce mode (opt-in): block the write when a high-confidence conflict
      // exists, returning the offending sections instead of writing through.
      if (conflictEnforceEnabled()) {
        const blocking = selectBlockingConflicts(conflicts, conflictBlockThreshold());
        if (blocking.length > 0) {
          const detail = blocking
            .map((c) => `  - "${c.existingSection.title}" (${c.conflictType}, confidence ${Math.round(c.confidence * 100)}%): ${c.reason}`)
            .join('\n');
          return {
            success: false,
            error: 'memory-conflict',
            output: `🚫 Memory write blocked: "${title}" conflicts with ${blocking.length} existing section(s):\n${detail}\n` +
              `Revise the entry or resolve the existing section(s). (Set HARNESS_MEMORY_CONFLICT_ENFORCE=0 to allow.)`,
          };
        }
      }

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

      // Dual-write to concept memory for semantic recall across sessions.
      // Best-effort — never fail the remember call if ccmem is offline.
      const ccmemLabel = sessionId ? `${category}: ${title} (session ${sessionId})` : `${category}: ${title}`;
      void ccmem.store(`${title}\n${content}`, ccmemLabel).catch(() => undefined);

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

/**
 * SemanticRecallTool — queries the Concept Cells memory service (ccmem) for
 * semantically relevant memories. Unlike `recall` (which reads markdown files),
 * this uses MiniLM embeddings so it finds related memories even when exact
 * keywords don't match.
 *
 * Requires the cc_service to be running (H:\MiniLM\cc_service).
 * If unavailable, returns a graceful message.
 */
export const SemanticRecallTool: Tool = {
  name: 'semantic_recall',
  description: 'Search your memory semantically — finds relevant past decisions, patterns, and notes even when you don\'t know the exact words. Powered by MiniLM concept cells.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What you want to remember — describe it naturally, e.g. "how did I handle authentication" or "database choice for this project"',
      },
      top_k: {
        type: 'number',
        description: 'Maximum number of results to return (default 5, max 10)',
      },
    },
    required: ['query'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const query = (input.query as string ?? '').trim();
    if (!query) return { success: false, output: 'semantic_recall requires a query.', error: 'missing query' };

    const topK = Math.min(Math.max(1, Number(input.top_k ?? 5) | 0), 10);

    const available = await ccmem.isAvailable();
    if (!available) {
      return {
        success: false,
        output: `Concept memory service is not running. It is auto-started by start.bat; if launching the harness manually, run:\n  python -m uvicorn ccmem.service:app --host 0.0.0.0 --port 8765`,
        error: 'ccmem unavailable',
      };
    }

    const hits = await ccmem.recall(query, topK);
    if (hits.length === 0) {
      return { success: true, output: 'No relevant memories found for that query.' };
    }

    const lines = hits.map((h, i) => {
      const label = h.label ? ` [${h.label}]` : '';
      const score = `(margin ${h.margin.toFixed(3)})`;
      const text = h.source ? `\n  ${h.source.replace(/\n/g, '\n  ')}` : '';
      return `${i + 1}.${label} ${score}${text}`;
    });

    return {
      success: true,
      output: `Found ${hits.length} relevant memories for "${query}":\n\n${lines.join('\n\n')}`,
    };
  },
};
