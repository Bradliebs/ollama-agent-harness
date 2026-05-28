/**
 * /goal slash-command handler.
 *
 * Recognises `/goal <intent>` in a chat message, expands the intent via
 * goalExpander, optionally appends the generated tasks to the plan file,
 * and returns a chat-ready response. Kept as a pure-ish module so the
 * chat endpoint can stay thin and so we can unit-test the slash contract
 * without spinning up the whole web stack.
 *
 * Supported forms:
 *   /goal Build a wiki from D:\big.pdf
 *   /goal --dry Research https://acme.example.com
 *   /goal --plan some-plan.md Set up a 9am check-in
 *
 * Dry runs never touch the filesystem — they just return the proposed
 * tasks so the user can review before committing.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { expandGoal, renderTasksAsPlanMarkdown, type PlanTask } from './goalExpander';

export interface GoalSlashOptions {
  /** Repo root. Plan paths and existing-id discovery resolve from here. */
  projectDir: string;
  /** Filesystem hooks; tests can stub these. */
  fs?: {
    readFile: (p: string) => Promise<string>;
    appendFile: (p: string, data: string) => Promise<void>;
    writeFile: (p: string, data: string) => Promise<void>;
    access: (p: string) => Promise<void>;
  };
}

export interface GoalSlashResult {
  /** Whether the message was a /goal command. When false, callers should fall through. */
  handled: boolean;
  /** Markdown to stream back to the chat as the assistant response. */
  response: string;
  /** Whether the plan file was modified. */
  mutated: boolean;
  /** Tasks emitted, for telemetry / event logging. */
  tasks: PlanTask[];
}

const COMMAND_PATTERN = /^\s*\/goal\b\s*(.*)$/s;

function parseGoalArgs(raw: string): { dry: boolean; planPath: string; intent: string } {
  const tokens = raw.split(/\s+/).filter(Boolean);
  let dry = false;
  let planPath = 'IMPLEMENTATION_PLAN.md';
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--dry' || t === '-n') dry = true;
    else if (t === '--plan' || t === '-p') planPath = tokens[++i] ?? planPath;
    else rest.push(t);
  }
  return { dry, planPath, intent: rest.join(' ').trim() };
}

async function discoverExistingIds(planAbsPath: string, fsHooks: NonNullable<GoalSlashOptions['fs']>): Promise<string[]> {
  try {
    await fsHooks.access(planAbsPath);
  } catch {
    return [];
  }
  let text: string;
  try {
    text = await fsHooks.readFile(planAbsPath);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^- \[.\] (\S+)\s+[—-]/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/**
 * Try to handle a chat message as a /goal command. Returns
 * `{ handled: false }` for any message that isn't /goal so callers can
 * fall through to the normal chat path.
 */
export async function tryGoalSlashCommand(messageText: string, options: GoalSlashOptions): Promise<GoalSlashResult> {
  const match = messageText.match(COMMAND_PATTERN);
  if (!match) return { handled: false, response: '', mutated: false, tasks: [] };

  const fsHooks: NonNullable<GoalSlashOptions['fs']> = options.fs ?? {
    readFile: (p) => fs.readFile(p, 'utf-8'),
    appendFile: (p, d) => fs.appendFile(p, d, 'utf-8'),
    writeFile: (p, d) => fs.writeFile(p, d, 'utf-8'),
    access: (p) => fs.access(p),
  };

  const { dry, planPath, intent } = parseGoalArgs(match[1] ?? '');

  if (!intent) {
    return {
      handled: true,
      mutated: false,
      tasks: [],
      response:
        '**`/goal` — turn a high-level intent into autonomy tasks.**\n\n' +
        'Usage:\n' +
        '```\n' +
        '/goal Build a wiki from D:\\big.pdf\n' +
        '/goal --dry Research https://acme.example.com\n' +
        '/goal --plan some-plan.md Set up a 9am check-in\n' +
        '```\n\n' +
        'Tip: run `--dry` first to preview the tasks before they hit the plan.',
    };
  }

  const planAbsPath = path.resolve(options.projectDir, planPath);
  const existingIds = await discoverExistingIds(planAbsPath, fsHooks);

  // Reject the "pasted-back plan line" case: if the intent's first
  // whitespace-separated token is already a task ID in the plan, we
  // would otherwise slugify the whole pasted blob, bump a suffix, and
  // produce a Frankenstein title like `slug--3 — slug--2 — slug- — …`.
  // Tell the user what's happening instead of silently corrupting the
  // plan.
  const leadingToken = intent.split(/\s+/)[0]?.toLowerCase();
  const duplicateId = leadingToken
    ? existingIds.find((id) => id.toLowerCase() === leadingToken)
    : undefined;
  if (duplicateId) {
    return {
      handled: true,
      mutated: false,
      tasks: [],
      response:
        `_Task \`${duplicateId}\` already exists in \`${planPath}\`._\n\n` +
        `- To re-run it, type \`/yolo\` (runs all pending tasks) or \`/run ${duplicateId}\`.\n` +
        `- To create a fresh task, rephrase the goal without the existing task id at the start.`,
    };
  }

  const result = expandGoal(intent, { existingIds });

  if (result.tasks.length === 0) {
    return {
      handled: true,
      mutated: false,
      tasks: [],
      response: `_Could not derive any tasks from intent: "${intent}". Try rephrasing with a verb like "build", "research", or "ingest"._`,
    };
  }

  const block = renderTasksAsPlanMarkdown(result.tasks);
  const lines: string[] = [];
  lines.push(`**\`/goal\` → detected intent: \`${result.shape}\`**`);
  lines.push('');
  lines.push(`_${result.rationale}_`);
  lines.push('');
  lines.push('```markdown');
  lines.push(block.trimEnd());
  lines.push('```');

  if (dry) {
    lines.push('');
    lines.push(`_Dry run — \`${planPath}\` not modified. Re-run without \`--dry\` to commit._`);
    return { handled: true, mutated: false, tasks: result.tasks, response: lines.join('\n') };
  }

  let exists = true;
  try {
    await fsHooks.access(planAbsPath);
  } catch {
    exists = false;
  }
  if (exists) {
    const current = await fsHooks.readFile(planAbsPath);
    const sep = current.endsWith('\n') ? '' : '\n';
    await fsHooks.appendFile(planAbsPath, sep + block);
  } else {
    await fsHooks.writeFile(planAbsPath, '# Implementation Plan\n\n' + block);
  }
  lines.push('');
  lines.push(`✅ Appended **${result.tasks.length}** task(s) to \`${planPath}\`. Start the autonomy loop to begin work.`);

  return { handled: true, mutated: true, tasks: result.tasks, response: lines.join('\n') };
}
