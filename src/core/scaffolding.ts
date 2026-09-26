// Adjustable scaffolding — one harness, three levels of structure.
//
// Frontier models do best with light structure: a goal, tools and verifiers.
// Small models do best with heavy structure: an explicit plan, one tool per
// step, a prompt that names the current step, and a narrow context. The level
// comes from the model's capability profile (or is forced by configuration),
// so as models improve the harness turns scaffolding down instead of being
// rewritten.

import type { Tool } from '../types';

export type ScaffoldLevel = 'light' | 'medium' | 'heavy';

export interface ScaffoldConfig {
  level: ScaffoldLevel;
  /** Tool calls processed per turn; extras get a "skipped" result. */
  maxToolCallsPerTurn: number;
  /** Heavy: the first text-only reply is taken as the plan, not the answer. */
  planTurnFirst: boolean;
  /** Heavy: after each tool turn, prompt for the next step of the plan. */
  stepPrompt: boolean;
  /** Keep only this many recent tool results in full; older ones are trimmed. 0 = keep all. */
  keepRecentToolResults: number;
  /** Tools offered per step (by relevance); 0 = all. */
  maxToolsOffered: number;
  /** Appended to the system prompt. */
  systemAddendum: string;
}

const SCAFFOLDS: Record<ScaffoldLevel, ScaffoldConfig> = {
  light: {
    level: 'light',
    maxToolCallsPerTurn: 0,
    planTurnFirst: false,
    stepPrompt: false,
    keepRecentToolResults: 0,
    maxToolsOffered: 0,
    systemAddendum: '',
  },
  medium: {
    level: 'medium',
    maxToolCallsPerTurn: 3,
    planTurnFirst: false,
    stepPrompt: false,
    keepRecentToolResults: 0,
    maxToolsOffered: 10,
    systemAddendum: 'Working method: before your first tool call, write a short numbered plan (at most 5 steps) in one or two lines, then carry it out. Use at most 3 tool calls per turn.',
  },
  heavy: {
    level: 'heavy',
    maxToolCallsPerTurn: 1,
    planTurnFirst: true,
    stepPrompt: true,
    keepRecentToolResults: 3,
    maxToolsOffered: 6,
    systemAddendum: 'Working method (follow exactly): 1) First reply with ONLY a numbered plan of at most 5 short steps, no tool calls. 2) Then, on each turn, call exactly ONE tool for the current step. 3) When every step is done, write the final answer for the user.',
  },
};

export function scaffoldFor(level: ScaffoldLevel): ScaffoldConfig {
  return { ...SCAFFOLDS[level] };
}

export const PLAN_ACCEPTED_PROMPT = 'Good. Now carry out step 1 of your plan: call exactly one tool.';
export const NEXT_STEP_PROMPT = 'Continue with the next step of your plan: call exactly one tool, or, if every step is done, write the final answer.';
export const SKIPPED_EXTRA_CALL = 'Skipped: this model works one step at a time. Call it again next turn if it is still needed.';

/**
 * Resolve the level to use. `mode` is HARNESS_SCAFFOLD_MODE: 'profile' uses the
 * capability profile's recommendation; a level name forces that level; unset
 * or 'off' returns null (today's behaviour, no scaffolding changes).
 */
export function resolveScaffoldLevel(mode: string | undefined, profileLevel: ScaffoldLevel | undefined): ScaffoldLevel | null {
  const normalized = mode?.trim().toLowerCase();
  if (!normalized || normalized === 'off' || normalized === '0') return null;
  if (normalized === 'light' || normalized === 'medium' || normalized === 'heavy') return normalized;
  if (normalized === 'profile') return profileLevel ?? null;
  return null;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'me', 'my', 'it', 'this', 'that', 'what', 'how', 'can', 'you', 'please', 'from', 'about']);

function terms(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2 && !STOPWORDS.has(term));
}

/** Lexical relevance of each tool to the task text (name + description overlap). */
export function rankToolsByRelevance(tools: Tool[], taskText: string): Map<string, number> {
  const taskTerms = new Set(terms(taskText));
  const scores = new Map<string, number>();
  for (const tool of tools) {
    const toolTerms = new Set([...terms(tool.name.replace(/_/g, ' ')), ...terms(tool.description ?? '')]);
    let score = 0;
    for (const term of toolTerms) {
      if (taskTerms.has(term)) score += 1;
      else if ([...taskTerms].some((taskTerm) => taskTerm.startsWith(term) || term.startsWith(taskTerm))) score += 0.5;
    }
    scores.set(tool.name, score);
  }
  return scores;
}

/** Pick the most relevant tools, always keeping tools marked required. */
export function selectRelevantTools(tools: Tool[], taskText: string, limit: number): Tool[] {
  if (limit <= 0 || tools.length <= limit) return tools;
  const scores = rankToolsByRelevance(tools, taskText);
  const required = tools.filter((tool) => tool.required);
  const optional = tools
    .filter((tool) => !tool.required)
    .map((tool, index) => ({ tool, index, score: scores.get(tool.name) ?? 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, limit - required.length))
    .map((entry) => entry.tool);
  const chosen = new Set([...required, ...optional].map((tool) => tool.name));
  return tools.filter((tool) => chosen.has(tool.name));
}

/** Trimmed stand-in for an older tool result under narrow-context scaffolding. */
export function trimToolResult(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return `[older tool result trimmed to keep context narrow: ${flat.slice(0, 200)}${flat.length > 200 ? '…' : ''}]`;
}
