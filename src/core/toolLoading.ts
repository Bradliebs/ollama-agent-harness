// Deferred tool loading — offer a few tools, load the rest on demand.
//
// Every tool definition is sent with every request: with ~70 tools that is
// ~10k tokens before the conversation starts. With deferred loading the model
// gets a core set plus the tools most relevant to the task, chosen once
// before the first turn, and a `tool_search` tool that loads more. The
// loaded set only grows, so the request prefix changes rarely (a stable
// prefix is what providers cache).
//
// Opt-in (HARNESS_TOOL_LOADING=deferred|auto) because it changes which tools
// the model sees; replay evaluation decides whether it becomes the default.

import { rankToolsByRelevance } from './scaffolding';
import type { Tool, ToolResult } from '../types';

export type ToolLoadingMode = 'off' | 'deferred' | 'auto';

export const TOOL_SEARCH_NAME = 'tool_search';

/** Always offered: the tools most tasks need, and the ones the default prompts name. */
export const DEFAULT_CORE_TOOLS = [
  'file_read', 'file_write', 'file_edit', 'file_move', 'list_files', 'grep', 'bash',
  'web_search', 'web_read', 'skill', 'remember', 'recall',
];

/** Extra tools picked by relevance to the task text. */
export const DEFAULT_RELEVANT_TOOLS = 6;
// Words too common in tool descriptions or requests to say anything about relevance.
const GENERIC_TERMS = new Set([
  'the', 'and', 'for', 'with', 'what', 'how', 'this', 'that', 'from', 'about', 'are', 'was', 'you', 'please', 'has', 'have',
  'been', 'which', 'who', 'why', 'where', 'there', 'then', 'than', 'them', 'they', 'but', 'our', 'its', 'their', 'your',
  'use', 'used', 'using', 'add', 'run', 'get', 'set', 'list', 'make', 'new', 'file', 'files', 'tool', 'tools', 'data', 'text',
  'show', 'check', 'help', 'need', 'want', 'all', 'any', 'one', 'not', 'will', 'can', 'into', 'out', 'more', 'when', 'only', 'also',
]);

function relevanceTerms(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2 && !GENERIC_TERMS.has(term));
}

/**
 * Relevance of each tool to the task: a word of the tool's name counts 2, a
 * word of its description 1. Stricter than scaffolding's ranker (no prefix
 * matches), because every tool picked here is paid for on every request.
 */
function toolRelevance(tools: readonly Tool[], taskText: string): Map<string, number> {
  const task = new Set(relevanceTerms(taskText));
  const scores = new Map<string, number>();
  for (const tool of tools) {
    const nameTerms = new Set(relevanceTerms(tool.name.replace(/_/g, ' ')));
    const descriptionTerms = new Set(relevanceTerms(tool.description ?? '').filter((term) => !nameTerms.has(term)));
    let score = 0;
    for (const term of nameTerms) if (task.has(term)) score += 2;
    for (const term of descriptionTerms) if (task.has(term)) score += 1;
    scores.set(tool.name, score);
  }
  return scores;
}

/** Minimum relevance to be offered up front: a name match, or two description words. */
const MIN_RELEVANCE = 2;

/** In auto mode, defer when the definitions would take more than this share of the window. */
export const AUTO_DEFER_SHARE = 0.2;

export function resolveToolLoadingMode(env = process.env.HARNESS_TOOL_LOADING): ToolLoadingMode {
  const value = env?.trim().toLowerCase();
  return value === 'deferred' || value === 'auto' ? value : 'off';
}

/**
 * Whether to defer in this run: always in deferred mode; in auto mode only
 * when the definitions would take a large share of the context window.
 */
export function shouldDeferTools(mode: ToolLoadingMode, schemaTokens: number, contextTokens: number): boolean {
  if (mode === 'deferred') return true;
  if (mode === 'auto') return contextTokens > 0 && schemaTokens > contextTokens * AUTO_DEFER_SHARE;
  return false;
}

/** Most extra tools a conversation accumulates through planInitialToolsForConversation. */
export const MAX_CONVERSATION_RELEVANT_TOOLS = 18;

/**
 * planInitialTools for a chat: the union of each user message's picks, earliest
 * first. Within one conversation the result only grows, so the tool block at
 * the front of every request changes rarely and its cached prefix survives.
 */
export function planInitialToolsForConversation(tools: readonly Tool[], userMessages: readonly string[], options: { core?: readonly string[] } = {}): string[] {
  const core = new Set(options.core ?? DEFAULT_CORE_TOOLS);
  const picked: string[] = [];
  for (const text of userMessages) {
    for (const name of planInitialTools(tools, text, options)) {
      if (!core.has(name) && !picked.includes(name) && picked.length < MAX_CONVERSATION_RELEVANT_TOOLS) picked.push(name);
    }
  }
  const chosen = new Set(picked);
  return tools.filter((tool) => core.has(tool.name) || chosen.has(tool.name) || tool.required).map((tool) => tool.name);
}

/** Names of the tools to offer from the first turn: core tools plus the most relevant others, in registration order. */
export function planInitialTools(
  tools: readonly Tool[],
  taskText: string,
  options: { core?: readonly string[]; relevant?: number } = {},
): string[] {
  const core = new Set(options.core ?? DEFAULT_CORE_TOOLS);
  const scores = toolRelevance(tools, taskText);
  const relevant = new Set(tools
    .filter((tool) => !core.has(tool.name) && (scores.get(tool.name) ?? 0) >= MIN_RELEVANCE)
    .map((tool, index) => ({ name: tool.name, index, score: scores.get(tool.name) ?? 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, options.relevant ?? DEFAULT_RELEVANT_TOOLS)
    .map((entry) => entry.name));
  return tools.filter((tool) => core.has(tool.name) || relevant.has(tool.name) || tool.required).map((tool) => tool.name);
}

/** The tools of one run, split into loaded (offered to the model) and deferred. */
export class DeferredToolSet {
  private readonly all: readonly Tool[];
  private readonly loaded: Set<string>;

  constructor(all: readonly Tool[], initial: readonly string[]) {
    this.all = all;
    const known = new Set(all.map((tool) => tool.name));
    this.loaded = new Set(initial.filter((name) => known.has(name)));
  }

  isDeferred(name: string): boolean {
    return !this.loaded.has(name) && this.all.some((tool) => tool.name === name);
  }

  get loadedNames(): string[] {
    return this.all.filter((tool) => this.loaded.has(tool.name)).map((tool) => tool.name);
  }

  get deferredTools(): Tool[] {
    return this.all.filter((tool) => !this.loaded.has(tool.name));
  }

  /** Load tools by name; returns the ones that were not loaded before. */
  load(names: readonly string[]): string[] {
    const added: string[] = [];
    for (const name of names) {
      if (this.isDeferred(name)) {
        this.loaded.add(name);
        added.push(name);
      }
    }
    return added;
  }

  /** Deferred tools matching a query: exact names first, then by relevance. */
  search(query: string, limit = 5): Tool[] {
    const deferred = this.deferredTools;
    const words = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
    const exact = deferred.filter((tool) => words.includes(tool.name.toLowerCase()));
    const scores = rankToolsByRelevance(deferred, query);
    const ranked = deferred
      .filter((tool) => !exact.includes(tool) && (scores.get(tool.name) ?? 0) > 0)
      .sort((a, b) => (scores.get(b.name) ?? 0) - (scores.get(a.name) ?? 0));
    return [...exact, ...ranked].slice(0, limit);
  }
}

function describeParameters(tool: Tool): string {
  const schema = tool.parameters as { properties?: Record<string, { type?: unknown }>; required?: unknown } | undefined;
  const required = new Set(Array.isArray(schema?.required) ? schema.required.map(String) : []);
  const params = Object.entries(schema?.properties ?? {})
    .map(([name, spec]) => `${name}${required.has(name) ? '' : '?'}: ${typeof spec?.type === 'string' ? spec.type : 'any'}`);
  return params.length > 0 ? `(${params.join(', ')})` : '()';
}

/** Result for a direct call to a tool that was never loaded and whose arguments are incomplete. */
export function deferredToolCallResult(tool: Tool, errors: readonly string[]): ToolResult {
  return {
    success: false,
    output: `The ${tool.name} tool was not loaded, so its parameters were unknown: ${errors.join(' ')} It is loaded now. Parameters: ${JSON.stringify(tool.parameters)}. Call it again with the required parameters.`,
    error: 'deferred tool called without its required parameters',
  };
}

/**
 * The `tool_search` meta-tool. Its description lists every deferred tool by
 * name (cheap), so the model knows what exists; calling it loads the matches,
 * which are offered from the model's next step.
 */
export function createToolSearchTool(set: DeferredToolSet, onLoad: (names: string[]) => void): Tool {
  const names = set.deferredTools.map((tool) => tool.name).join(', ');
  return {
    name: TOOL_SEARCH_NAME,
    description: `Load more tools. Only some tools are loaded to save context; these also exist: ${names}. Describe what you need (or give exact tool names) and the matching tools become available from your next step.`,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What the tool should do, or exact tool names separated by spaces' } },
      required: ['query'],
    },
    isReadOnly: true,
    required: true,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const query = typeof input.query === 'string' ? input.query : '';
      const matches = set.search(query);
      if (matches.length === 0) {
        return { success: false, output: `No unloaded tool matches "${query}". Unloaded tools: ${set.deferredTools.map((tool) => tool.name).join(', ') || '(none)'}.`, error: 'no match' };
      }
      const added = set.load(matches.map((tool) => tool.name));
      if (added.length > 0) onLoad(added);
      return {
        success: true,
        output: `Loaded; available from your next step:\n${matches.map((tool) => `- ${tool.name}${describeParameters(tool)}: ${tool.description.slice(0, 200)}`).join('\n')}`,
      };
    },
  };
}
