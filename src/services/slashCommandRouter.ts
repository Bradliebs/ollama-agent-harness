/**
 * Chat slash-command router.
 *
 * Centralises all `/command` detection so the `/api/chat` endpoint stays
 * thin. Each handler is a pure async function that returns an SSE-ready
 * response or `null` (= not my command, fall through).
 *
 * Commands are token-free — they never call a model. They compose the
 * harness's existing services so the user can drive everything from the
 * chat box without touching menus, scripts, or terminals.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';

import { tryGoalSlashCommand } from './goalSlashCommand';
import { parsePrioritySetCommand, setPriorityForToday, getPriorityForToday, loadMorningPriorityInputs } from './morningPriority';
import { groupTasksByColumn, promoteTriageToPlan, withKanbanTag } from './kanbanBridge';
import { listTasks, updateTask, type Task } from './taskStore';

// Cookbook modules live outside src/rootDir — use inline require() to
// avoid TS6059. The types we need are declared locally below.

interface ResearchSource {
  title: string;
  url?: string;
  snippet?: string;
  retrievedAt?: string;
}

interface ResearchFinding {
  label: string;
  body: string;
  confidence?: number;
  sourceIds?: number[];
}

interface ResearchInput {
  subject: string;
  summary: string;
  oneLineAnswer?: string;
  findings: ResearchFinding[];
  sources: ResearchSource[];
  generatedAt?: string;
}

export interface SlashResult {
  handled: boolean;
  response: string;
  /** SSE reason tag. */
  reason: string;
  /** Structured payload for emitEvent. */
  eventPayload?: Record<string, unknown>;
}

const NOT_HANDLED: SlashResult = { handled: false, response: '', reason: '' };

function ok(response: string, reason: string, eventPayload?: Record<string, unknown>): SlashResult {
  return { handled: true, response, reason, eventPayload };
}

// ─── /wiki ──────────────────────────────────────────────────────────

const WIKI_PATTERN = /^\s*\/wiki\b\s*(.*)$/si;

async function handleWiki(text: string, projectDir: string): Promise<SlashResult> {
  const m = text.match(WIKI_PATTERN);
  if (!m) return NOT_HANDLED;
  const arg = m[1].trim();
  if (!arg) {
    return ok(
      '**`/wiki` — turn a PDF into a chaptered wiki + RAG chat page.**\n\n' +
      'Usage:\n```\n/wiki D:\\path\\to\\document.pdf\n/wiki ./docs/spec.pdf\n```\n\n' +
      'Output lands in `.harness/wiki/`. Open `index.html` to browse.',
      'wiki_usage',
    );
  }

  const pdfPath = path.resolve(projectDir, arg);
  const outDir = path.join(projectDir, '.harness', 'wiki');

  try {
    await fs.access(pdfPath);
  } catch {
    return ok(`❌ PDF not found: \`${arg}\`\n\nCheck the path and try again.`, 'wiki_error');
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildBlueprint } = require('../../cookbook/blueprint-pdf-to-wiki') as { buildBlueprint: (pdfPath: string, outDir: string, opts?: Record<string, unknown>) => Promise<{ chapters: { length: number }[]; files: { index: string; chat: string; ragIndex: string } }> };
    const result = await buildBlueprint(pdfPath, outDir, { projectDir, skipRag: false });
    const lines: string[] = [];
    lines.push(`✅ **Wiki built** from \`${path.basename(pdfPath)}\``);
    lines.push('');
    lines.push(`- **${result.chapters.length}** chapter${result.chapters.length === 1 ? '' : 's'} detected`);
    lines.push(`- Index: \`${path.relative(projectDir, result.files.index)}\``);
    lines.push(`- Chat:  \`${path.relative(projectDir, result.files.chat)}\``);
    if (result.files.ragIndex) lines.push(`- RAG:   \`${path.relative(projectDir, result.files.ragIndex)}\``);
    lines.push('');
    lines.push('Open the index in your browser to start reading, or use the chat page to query via RAG.');
    return ok(lines.join('\n'), 'wiki_built', { chapters: result.chapters.length, pdf: path.basename(pdfPath) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return ok(`❌ Wiki build failed: ${msg}`, 'wiki_error');
  }
}

// ─── /research ──────────────────────────────────────────────────────

const RESEARCH_PATTERN = /^\s*\/research\b\s*(.*)$/si;

async function handleResearch(text: string, projectDir: string): Promise<SlashResult> {
  const m = text.match(RESEARCH_PATTERN);
  if (!m) return NOT_HANDLED;
  const subject = m[1].trim();
  if (!subject) {
    return ok(
      '**`/research` — generate a research report on any subject.**\n\n' +
      'Usage:\n```\n/research Acme Corp tech stack\n/research emerging trends in local LLM inference\n```\n\n' +
      'This searches the web, synthesizes findings, and renders a polished HTML report in `.harness/research/`.',
      'research_usage',
    );
  }

  // Web search via the harness's built-in tool
  let searchResults: string[] = [];
  try {
    const { WebSearchTool } = await import('../tools/webSearchTool');
    const result = await WebSearchTool.execute({ query: subject, max_results: 8 });
    if (result.success && result.output) {
      searchResults.push(result.output);
    }
  } catch {
    // Offline — fall through with empty results
  }

  // Build a stub ResearchInput from search snippets (no model call —
  // keeps it token-free and fast. The report still looks good because
  // the template adds structure.)
  const sources: ResearchSource[] = [];
  const findings: ResearchFinding[] = [];

  for (const block of searchResults) {
    // Parse the WebSearchTool output format: "N. **title**\n   url\n   snippet"
    const entries = block.split(/\n\d+\.\s+\*\*/);
    for (const entry of entries) {
      if (!entry.trim()) continue;
      const titleMatch = entry.match(/^([^*]+)\**/);
      const urlMatch = entry.match(/\n\s+(https?:\/\/\S+)/);
      const snippetMatch = entry.match(/\n\s+(?:https?:\/\/\S+\n\s+)?(.+)/s);
      if (titleMatch) {
        sources.push({
          title: titleMatch[1].trim(),
          url: urlMatch?.[1],
          snippet: snippetMatch?.[1]?.trim().slice(0, 200),
          retrievedAt: new Date().toISOString(),
        });
      }
    }
  }

  if (sources.length > 0) {
    // Group snippets into a single finding
    findings.push({
      label: 'Web search results',
      body: sources.map((s, i) => `**${s.title}**: ${s.snippet || 'No snippet available.'}`).join('\n\n'),
      confidence: 0.6,
      sourceIds: sources.map((_, i) => i),
    });
  }

  const input: ResearchInput = {
    subject,
    summary: sources.length > 0
      ? `Research on "${subject}" based on ${sources.length} web source${sources.length === 1 ? '' : 's'}.`
      : `Research on "${subject}" — no web results available (offline mode or search failed).`,
    findings,
    sources,
  };

  const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'research';
  const outPath = path.join(projectDir, '.harness', 'research', `${slug}.html`);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { writeResearchReport } = require('../../cookbook/blueprint-competitor-research') as { writeResearchReport: (input: ResearchInput, outPath: string) => { html: string; markdownSummary: string } };
    const rendered = writeResearchReport(input, outPath);
    const relPath = path.relative(projectDir, outPath);
    const lines: string[] = [];
    lines.push(`✅ **Research report generated** for "${subject}"`);
    lines.push('');
    lines.push(`- **${sources.length}** source${sources.length === 1 ? '' : 's'} cited`);
    lines.push(`- **${findings.length}** finding${findings.length === 1 ? '' : 's'}`);
    lines.push(`- Report: \`${relPath}\``);
    lines.push('');
    if (sources.length === 0) {
      lines.push('⚠️ No web results — the report is a stub. Make sure you have internet access for richer results.');
    } else {
      lines.push('Open the report in your browser for the full formatted view.');
    }
    return ok(lines.join('\n'), 'research_built', { subject, sources: sources.length, path: relPath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return ok(`❌ Research report failed: ${msg}`, 'research_error');
  }
}

// ─── /memory-wiki ───────────────────────────────────────────────────

const MEMORY_WIKI_PATTERN = /^\s*\/memory-wiki\b/i;

async function handleMemoryWiki(text: string, projectDir: string): Promise<SlashResult> {
  if (!MEMORY_WIKI_PATTERN.test(text)) return NOT_HANDLED;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { rebuildSemanticMemory } = require('../persistence/semanticMemory') as { rebuildSemanticMemory: (dir: string) => Promise<Array<{ id: string; timestamp: string; kind: string; text: string; sessionId: string }>> };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildPersonalWiki } = require('../../cookbook/blueprint-personal-wiki') as { buildPersonalWiki: (entries: unknown[], outDir: string, opts?: Record<string, unknown>) => { totalEntries: number; days: string[]; indexFile: string } };

    const entries = await rebuildSemanticMemory(projectDir);
    const mapped = entries.map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      kind: e.kind,
      text: e.text,
      sessionId: e.sessionId,
    }));

    const outDir = path.join(projectDir, '.harness', 'memory-wiki');
    const result = buildPersonalWiki(mapped, outDir, { title: 'Personal Memory Wiki' });

    const lines: string[] = [];
    lines.push(`✅ **Memory wiki rebuilt**`);
    lines.push('');
    lines.push(`- **${result.totalEntries}** entr${result.totalEntries === 1 ? 'y' : 'ies'} across **${result.days.length}** day${result.days.length === 1 ? '' : 's'}`);
    lines.push(`- Index: \`${path.relative(projectDir, result.indexFile)}\``);
    lines.push('');
    lines.push('Open the index in your browser to browse your memory.');
    return ok(lines.join('\n'), 'memory_wiki_built', { entries: result.totalEntries, days: result.days.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return ok(`❌ Memory wiki build failed: ${msg}`, 'memory_wiki_error');
  }
}

// ─── /kanban ────────────────────────────────────────────────────────

const KANBAN_PATTERN = /^\s*\/kanban\b\s*(.*)$/si;

async function handleKanban(text: string, projectDir: string): Promise<SlashResult> {
  const m = text.match(KANBAN_PATTERN);
  if (!m) return NOT_HANDLED;
  const arg = m[1].trim().toLowerCase();

  const tasks = await listTasks(projectDir);
  const board = groupTasksByColumn(tasks);

  if (!arg || arg === 'show' || arg === 'board') {
    const lines: string[] = [];
    lines.push('**📋 Kanban Board**');
    lines.push('');
    for (const [col, label] of [['triage', '🔵 Triage'], ['doing', '🟡 Doing'], ['done', '✅ Done']] as const) {
      const items = board[col];
      lines.push(`### ${label} (${items.length})`);
      if (items.length === 0) {
        lines.push('_empty_');
      } else {
        for (const t of items.slice(0, 15)) {
          lines.push(`- **${t.title}** (\`${t.id.slice(0, 8)}\`)`);
        }
        if (items.length > 15) lines.push(`_…and ${items.length - 15} more_`);
      }
      lines.push('');
    }
    lines.push('Use `/kanban move <task-id> triage|doing|done` to move cards.');
    return ok(lines.join('\n'), 'kanban_board', { triage: board.triage.length, doing: board.doing.length, done: board.done.length });
  }

  // /kanban move <id> <column>
  const moveMatch = arg.match(/^move\s+(\S+)\s+(triage|doing|done)$/i);
  if (moveMatch) {
    const [, taskId, column] = moveMatch;
    const col = column.toLowerCase() as 'triage' | 'doing' | 'done';
    const task = tasks.find((t) => t.id === taskId || t.id.startsWith(taskId));
    if (!task) {
      return ok(`❌ Task not found: \`${taskId}\``, 'kanban_error');
    }
    const newTags = withKanbanTag(task.tags, col);
    await updateTask(projectDir, task.id, { tags: newTags });
    let promoMsg = '';
    if (col === 'triage') {
      const result = await promoteTriageToPlan([{ ...task, tags: newTags }], { projectDir });
      if (result.mutated) promoMsg = `\n📝 Also promoted to \`IMPLEMENTATION_PLAN.md\` for the next autonomy run.`;
    }
    return ok(`✅ Moved **${task.title}** → **${col}**${promoMsg}`, 'kanban_moved', { taskId: task.id, column: col });
  }

  return ok(
    '**`/kanban` — manage your task board from chat.**\n\n' +
    'Usage:\n```\n/kanban              Show the board\n/kanban move <id> triage   Move a card to Triage (auto-promotes to plan)\n/kanban move <id> doing    Move a card to Doing\n/kanban move <id> done     Move a card to Done\n```',
    'kanban_usage',
  );
}

// ─── /brief ─────────────────────────────────────────────────────────

const BRIEF_PATTERN = /^\s*\/brief\b/i;

async function handleBrief(text: string, projectDir: string): Promise<SlashResult> {
  if (!BRIEF_PATTERN.test(text)) return NOT_HANDLED;

  try {
    const { composeDailyBrief } = await import('../jarvis/dailyBrief');
    const morningPriority = await loadMorningPriorityInputs(projectDir);
    const brief = composeDailyBrief({
      asOf: new Date().toISOString().slice(0, 10),
      windowDescription: 'since your last brief',
      ambientSignals: [],
      pendingLearningCandidates: [],
      predictiveSuggestions: [],
      knowledgeGraph: { records: 0, entities: 0, edges: 0, facts: 0 } as any,
      trustLadder: { capabilities: {} } as any,
      morningPriority: morningPriority ?? undefined,
    });
    return ok(brief, 'daily_brief');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return ok(`❌ Brief generation failed: ${msg}`, 'brief_error');
  }
}

// ─── /yolo ──────────────────────────────────────────────────────────
//
// One-shot full-send: sets dontAsk mode, grants all gated capabilities,
// starts the autonomy loop with high budgets, and optionally sets a time
// limit. Designed so the user can type "/yolo 2h" and walk away.
//
// The kill switch (`/stop` or the UI kill switch) is the brake.

const YOLO_PATTERN = /^\s*\/yolo\b\s*(.*)$/si;

export interface YoloOptions {
  /** Function to set permission mode (from server.ts scope). */
  setPermissionMode: (mode: string, reason: string) => void;
  /** Function to engage timed autonomy. */
  engageTimedAutonomy: (minutes: number, reason: string) => void;
  /** Function to start the autonomy run. */
  startAutonomyRun: (settings: { maxIterations: number; maxTurns: number; timeBudgetMs?: number; unproductiveTurnLimit: number }) => Promise<{ pid?: number; started: boolean; error?: string }>;
  /** Current permission mode. */
  currentMode: string;
}

let yoloHooks: YoloOptions | null = null;

/** Call from server.ts startup to wire the server-scoped functions. */
export function registerYoloHooks(hooks: YoloOptions): void {
  yoloHooks = hooks;
}

function parseTimeBudget(arg: string): number | undefined {
  // "2h" → 120, "30m" → 30, "4" → 240 (assumed hours)
  const m = arg.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)?$/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'h').toLowerCase();
  if (unit.startsWith('m')) return Math.round(n);
  return Math.round(n * 60);
}

async function handleYolo(text: string, _projectDir: string): Promise<SlashResult> {
  const m = text.match(YOLO_PATTERN);
  if (!m) return NOT_HANDLED;

  const arg = m[1].trim();

  if (arg === 'help' || arg === '?') {
    return ok(
      '**`/yolo` — full-send autonomy mode.**\n\n' +
      '```\n' +
      '/yolo          Start with default overnight budget (8h, 300 tasks)\n' +
      '/yolo 2h       Start with a 2-hour time cap\n' +
      '/yolo 30m      Start with a 30-minute time cap\n' +
      '/yolo stop     Disengage YOLO (revert to previous permission mode)\n' +
      '```\n\n' +
      'What it does:\n' +
      '1. Sets **dontAsk** permission mode (auto-approves everything)\n' +
      '2. Auto-grants all gated capabilities\n' +
      '3. Starts the autonomy loop with high budgets\n\n' +
      '**Safety**: The kill switch (`/stop` or the red button in UI) immediately halts everything.\n\n' +
      '⚠️ **You are trusting the agent fully.** Use when you know the plan is solid.',
      'yolo_usage',
    );
  }

  if (!yoloHooks) {
    return ok('❌ YOLO mode is not wired yet. Restart the harness server.', 'yolo_error');
  }

  if (arg === 'stop' || arg === 'off' || arg === 'cancel') {
    yoloHooks.engageTimedAutonomy(0, 'YOLO mode disengaged by user');
    return ok(
      '✅ **YOLO mode disengaged.** Permission mode reverted.\n\n' +
      'The autonomy loop will finish its current task and then stop.',
      'yolo_stopped',
    );
  }

  // Parse optional time budget
  const timeLimitMinutes = arg ? parseTimeBudget(arg) : undefined;
  const effectiveMinutes = timeLimitMinutes ?? 480; // default 8h

  // 1. Engage timed autonomy (sets dontAsk + auto-grants + auto-reverts)
  yoloHooks.engageTimedAutonomy(effectiveMinutes, 'YOLO mode engaged via /yolo chat command');

  // 2. Start the autonomy run with high budgets
  const timeBudgetMs = effectiveMinutes * 60 * 1000;
  let startResult: { pid?: number; started: boolean; error?: string } = { started: false };
  try {
    startResult = await yoloHooks.startAutonomyRun({
      maxIterations: 300,
      maxTurns: 100,
      timeBudgetMs,
      unproductiveTurnLimit: 15,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return ok(
      `⚠️ **YOLO mode engaged** (dontAsk + grants active) but the autonomy run failed to start: ${msg}\n\n` +
      'Permission mode is already dontAsk — you can start the run manually from the Autonomy tab.',
      'yolo_partial',
    );
  }

  const timeLabel = effectiveMinutes >= 60
    ? `${(effectiveMinutes / 60).toFixed(1).replace(/\.0$/, '')}h`
    : `${effectiveMinutes}m`;

  const lines: string[] = [];
  lines.push(`🚀 **YOLO MODE ENGAGED**`);
  lines.push('');
  lines.push(`- Permission mode: **dontAsk** (auto-approves everything)`);
  lines.push(`- All gated capabilities: **auto-granted**`);
  lines.push(`- Time budget: **${timeLabel}** (auto-reverts when done)`);
  lines.push(`- Task budget: **300 tasks**, **100 turns/task**, **15 stall limit**`);
  if (startResult.pid) lines.push(`- Autonomy PID: **${startResult.pid}**`);
  lines.push('');
  if (!startResult.started) {
    lines.push('⚠️ Autonomy run did not start (no pending tasks?). dontAsk mode is active — add tasks with `/goal` then start from the Autonomy tab.');
  } else {
    lines.push('The agent is now working through `IMPLEMENTATION_PLAN.md` autonomously.');
  }
  lines.push('');
  lines.push('**To stop**: type `/yolo stop`, click the kill switch, or close the terminal.');

  return ok(lines.join('\n'), 'yolo_engaged', { minutes: effectiveMinutes, pid: startResult.pid });
}

// ─── Master router ──────────────────────────────────────────────────

const handlers = [
  handleWiki,
  handleResearch,
  handleMemoryWiki,
  handleKanban,
  handleBrief,
  handleYolo,
] as const;

/**
 * Try every registered slash-command handler. Returns the first match
 * or NOT_HANDLED so the caller can fall through to the model.
 *
 * /goal and /priority are handled separately in server.ts because they
 * were wired before this router existed. They could be migrated here in
 * the future.
 */
export async function routeSlashCommand(messageText: string, projectDir: string): Promise<SlashResult> {
  for (const handler of handlers) {
    const result = await handler(messageText, projectDir);
    if (result.handled) return result;
  }
  return NOT_HANDLED;
}
