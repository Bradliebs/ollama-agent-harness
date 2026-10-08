// Governed working state — what the agent must not forget, kept outside the
// transcript.
//
// Compaction summarises the conversation, and summaries lose things: the plan,
// a decision and why it was made, "never touch this file". This store holds
// that state as typed data. When enabled it is rendered into the system prompt
// on every model call, so compaction can never remove it, and protected paths
// are enforced by the loop before file tools run, not merely mentioned.
//
// The model may add to the state (via the state_update tool) but can never
// remove invariants or protected paths; those only tighten.

import * as path from 'path';
import type { Message } from 'ollama';
import type { Tool, ToolResult } from '../types';

export interface PlanStep {
  step: string;
  status: 'pending' | 'done';
}

export interface Fact {
  claim: string;
  source?: string;
}

export interface Decision {
  what: string;
  why?: string;
}

export interface SourceRead {
  url: string;
  title?: string;
}

export interface WorkingState {
  plan: PlanStep[];
  facts: Fact[];
  decisions: Decision[];
  openQuestions: string[];
  invariants: string[];
  protectedPaths: string[];
  sources: SourceRead[];
}

export interface StateUpdate {
  plan?: string[];
  completeSteps?: number[];
  addFacts?: Fact[];
  addDecisions?: Decision[];
  addQuestions?: string[];
  resolveQuestions?: string[];
  addInvariants?: string[];
  protectPaths?: string[];
}

const LIMITS = { plan: 12, facts: 30, decisions: 20, openQuestions: 10, invariants: 20, protectedPaths: 50, sources: 12 } as const;
const MAX_ITEM_CHARS = 300;
export const DEFAULT_RENDER_CHARS = 4000;
export const WORKING_STATE_HEADER = '## Working state (maintained by the harness; kept across compaction)';

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS) : '';
}

function pushCapped<T>(list: T[], item: T, limit: number, same: (a: T, b: T) => boolean): boolean {
  if (list.some((existing) => same(existing, item))) return false;
  list.push(item);
  while (list.length > limit) list.shift();
  return true;
}

function normalizeProtectedPattern(pattern: string): string {
  return pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

type GlobToken =
  | { kind: 'lit'; ch: string }
  | { kind: 'star' } // any run of characters except '/'
  | { kind: 'globstar' } // any run of characters, '/' included
  | { kind: 'qmark' } // one character except '/'
  | { kind: 'optDirs' } // nothing, or any run ending in '/' (a leading "**/" or the middle of "/**/")
  | { kind: 'optSuffix' }; // nothing, or '/' followed by anything (a trailing "/**", or a bare name's contents)

function tokenizeProtectedPattern(pattern: string, rootAnchored = false): GlobToken[] {
  let p = pattern.toLowerCase();
  if (p.endsWith('/')) p += '**';
  // Applied at any depth unless anchored, so patterns start with optional directories.
  const tokens: GlobToken[] = rootAnchored ? [] : [{ kind: 'optDirs' }];
  for (let i = 0; i < p.length;) {
    if (p.startsWith('/**/', i)) { tokens.push({ kind: 'lit', ch: '/' }, { kind: 'optDirs' }); i += 4; }
    else if (i === 0 && p.startsWith('**/')) { if (rootAnchored) tokens.push({ kind: 'optDirs' }); i += 3; }
    else if (p.startsWith('/**', i) && /^\**$/.test(p.slice(i + 3))) { tokens.push({ kind: 'optSuffix' }); break; }
    else if (p.startsWith('**', i)) { tokens.push({ kind: 'globstar' }); i += 2; while (p[i] === '*') i += 1; }
    else if (p[i] === '*') { tokens.push({ kind: 'star' }); i += 1; }
    else if (p[i] === '?') { tokens.push({ kind: 'qmark' }); i += 1; }
    else { tokens.push({ kind: 'lit', ch: p[i] }); i += 1; }
  }
  const last = tokens[tokens.length - 1].kind;
  // A bare name also covers a folder of that name and everything in it.
  if (last !== 'optSuffix' && last !== 'globstar') tokens.push({ kind: 'optSuffix' });
  return tokens;
}

/**
 * Glob match for a protected pattern, applied at any depth: "dir/" and
 * "dir/**" cover the directory and everything in it, a bare name covers a
 * file or a directory of that exact name, "*" stays within one path segment,
 * "**" spans segments. Dynamic programming over (token, position), so the
 * cost is linear in pattern x path length whatever the pattern: patterns can
 * come from the model (state_update), and a backtracking regex could hang.
 */
function matchesProtectedPattern(tokens: GlobToken[], candidate: string): boolean {
  const n = candidate.length;
  let prev: boolean[] = new Array<boolean>(n + 1).fill(false);
  prev[0] = true;
  for (const token of tokens) {
    const next: boolean[] = new Array<boolean>(n + 1).fill(false);
    let anyBefore = false; // prev[k] for some k < j
    let slashAfterMatch = false; // prev[k] && candidate[k] === '/' for some k < j
    for (let j = 0; j <= n; j += 1) {
      const ch = j > 0 ? candidate[j - 1] : '';
      switch (token.kind) {
        case 'lit': next[j] = j > 0 && prev[j - 1] && ch === token.ch; break;
        case 'qmark': next[j] = j > 0 && prev[j - 1] && ch !== '/'; break;
        case 'star': next[j] = prev[j] || (j > 0 && next[j - 1] && ch !== '/'); break;
        case 'globstar': next[j] = prev[j] || (j > 0 && next[j - 1]); break;
        case 'optDirs': next[j] = prev[j] || (ch === '/' && anyBefore); break;
        case 'optSuffix': next[j] = prev[j] || slashAfterMatch; break;
      }
      if (prev[j]) anyBefore = true;
      if (prev[j] && candidate[j] === '/') slashAfterMatch = true;
    }
    prev = next;
  }
  return prev[n];
}

export class WorkingStateStore {
  private readonly data: WorkingState = { plan: [], facts: [], decisions: [], openQuestions: [], invariants: [], protectedPaths: [], sources: [] };
  private version = 0;

  constructor(seed: Partial<Pick<WorkingState, 'invariants' | 'protectedPaths'>> = {}) {
    // Seeded entries come from the user and task contract: pinned, never capped or evicted.
    for (const invariant of seed.invariants ?? []) this.addInvariant(invariant, true);
    for (const pattern of seed.protectedPaths ?? []) this.protect(pattern, true);
    this.version = 0;
  }

  get state(): WorkingState {
    return JSON.parse(JSON.stringify(this.data)) as WorkingState;
  }

  /** Incremented on every change; lets the loop re-render only when needed. */
  get revision(): number {
    return this.version;
  }

  get isEmpty(): boolean {
    const d = this.data;
    return d.plan.length + d.facts.length + d.decisions.length + d.openQuestions.length + d.invariants.length + d.protectedPaths.length + d.sources.length === 0;
  }

  /** Apply an update; returns human-readable change descriptions. */
  apply(update: StateUpdate): string[] {
    const changes: string[] = [];
    if (Array.isArray(update.plan)) {
      const steps = update.plan.map(clean).filter(Boolean).slice(0, LIMITS.plan);
      if (steps.length > 0) {
        this.data.plan = steps.map((step) => ({ step, status: 'pending' }));
        changes.push(`plan set (${steps.length} steps)`);
      }
    }
    for (const index of update.completeSteps ?? []) {
      const step = this.data.plan[Number(index) - 1];
      if (step && step.status !== 'done') {
        step.status = 'done';
        changes.push(`step ${index} done`);
      }
    }
    for (const fact of update.addFacts ?? []) {
      const claim = clean(fact?.claim);
      if (claim && pushCapped(this.data.facts, { claim, ...(clean(fact.source) ? { source: clean(fact.source) } : {}) }, LIMITS.facts, (a, b) => a.claim === b.claim)) changes.push(`fact: ${claim}`);
    }
    for (const decision of update.addDecisions ?? []) {
      const what = clean(decision?.what);
      if (what && pushCapped(this.data.decisions, { what, ...(clean(decision.why) ? { why: clean(decision.why) } : {}) }, LIMITS.decisions, (a, b) => a.what === b.what)) changes.push(`decision: ${what}`);
    }
    for (const question of update.addQuestions ?? []) {
      const text = clean(question);
      if (text && pushCapped(this.data.openQuestions, text, LIMITS.openQuestions, (a, b) => a === b)) changes.push(`question: ${text}`);
    }
    for (const question of update.resolveQuestions ?? []) {
      const text = clean(question);
      const index = this.data.openQuestions.findIndex((open) => open === text || open.toLowerCase().includes(text.toLowerCase()));
      if (text && index >= 0) {
        this.data.openQuestions.splice(index, 1);
        changes.push(`resolved: ${text}`);
      }
    }
    for (const invariant of update.addInvariants ?? []) if (this.addInvariant(invariant)) changes.push(`invariant: ${clean(invariant)}`);
    for (const pattern of update.protectPaths ?? []) if (this.protect(pattern)) changes.push(`protected: ${normalizeProtectedPattern(pattern)}`);
    if (changes.length > 0) this.version += 1;
    return changes;
  }

  /** Harness-derived: a source the agent actually read. */
  addSource(url: string, title?: string): boolean {
    const cleanUrl = clean(url);
    if (!cleanUrl) return false;
    const added = pushCapped(this.data.sources, { url: cleanUrl, ...(title ? { title: clean(title) } : {}) }, LIMITS.sources, (a, b) => a.url === b.url);
    if (added) this.version += 1;
    return added;
  }

  // Invariants and protected paths only tighten: once full, new entries are
  // refused rather than evicting older ones (which the model could otherwise
  // use to unprotect a path by flooding state_update).
  private addInvariant(invariant: string, pinned = false): boolean {
    const text = clean(invariant);
    if (!text || this.data.invariants.includes(text)) return false;
    if (!pinned && this.data.invariants.length >= LIMITS.invariants) return false;
    this.data.invariants.push(text);
    this.version += 1;
    return true;
  }

  private protect(pattern: string, pinned = false): boolean {
    const normalized = normalizeProtectedPattern(clean(pattern));
    if (!normalized || this.data.protectedPaths.includes(normalized)) return false;
    if (!pinned && this.data.protectedPaths.length >= LIMITS.protectedPaths) return false;
    this.data.protectedPaths.push(normalized);
    this.version += 1;
    return true;
  }

  /** The protected pattern that covers an absolute path, if any. */
  protectedMatch(absPath: string, projectRoot: string): string | null {
    const relative = path.relative(projectRoot, absPath).replace(/\\/g, '/');
    const candidates = [relative, absPath.replace(/\\/g, '/')].map((c) => c.toLowerCase());
    for (const pattern of this.data.protectedPaths) {
      const tokens = tokenizeProtectedPattern(pattern);
      if (candidates.some((candidate) => matchesProtectedPattern(tokens, candidate))) return pattern;
      // gitignore style: a leading "/" anchors the pattern at the project root
      // (the literal form above still covers real absolute paths).
      if (/^\/[^/]/.test(pattern) && matchesProtectedPattern(tokenizeProtectedPattern(pattern.slice(1), true), candidates[0])) return pattern;
    }
    return null;
  }

  render(maxChars = DEFAULT_RENDER_CHARS): string {
    if (this.isEmpty) return '';
    const d = this.data;
    const lines: string[] = [WORKING_STATE_HEADER];
    if (d.invariants.length) lines.push('Invariants (always hold):', ...d.invariants.map((item) => `- ${item}`));
    if (d.protectedPaths.length) lines.push(`Protected paths (never modify): ${d.protectedPaths.join(', ')}`);
    if (d.plan.length) lines.push('Plan:', ...d.plan.map((step, i) => `${i + 1}. [${step.status === 'done' ? 'x' : ' '}] ${step.step}`));
    if (d.decisions.length) lines.push('Decisions:', ...d.decisions.map((item) => `- ${item.what}${item.why ? ` (because ${item.why})` : ''}`));
    if (d.facts.length) lines.push('Established facts:', ...d.facts.map((item) => `- ${item.claim}${item.source ? ` [${item.source}]` : ''}`));
    if (d.openQuestions.length) lines.push('Open questions:', ...d.openQuestions.map((item) => `- ${item}`));
    if (d.sources.length) lines.push('Sources read:', ...d.sources.map((item) => `- ${item.title ? `${item.title} ` : ''}${item.url}`));
    const text = lines.join('\n');
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  }
}

/** Append the rendered working state to the system prompt of an outbound request. */
export function injectWorkingState(messages: readonly Message[], rendered: string): Message[] {
  if (!rendered || messages.length === 0 || messages[0].role !== 'system') return [...messages];
  return [{ ...messages[0], content: `${String(messages[0].content ?? '')}\n\n${rendered}` }, ...messages.slice(1)];
}

/**
 * Tail placement: send the rendered working state as a last message instead,
 * so the system prompt and the history before it stay byte-identical between
 * calls (and cacheable) when the state changes. Not stored in the transcript.
 */
export function appendWorkingState(messages: readonly Message[], rendered: string): Message[] {
  if (!rendered) return [...messages];
  return [...messages, { role: 'user', content: `${rendered}\n(Maintained by the harness for reference; not a new request.)` } as Message];
}

export type WorkingStatePosition = 'system' | 'tail';

/** Place the rendered state where the run is configured to put it. */
export function placeWorkingState(messages: readonly Message[], rendered: string, position: WorkingStatePosition = 'system'): Message[] {
  return position === 'tail' ? appendWorkingState(messages, rendered) : injectWorkingState(messages, rendered);
}

/** Parse a numbered or bulleted plan out of free text (heavy scaffolding's plan turn). */
export function parsePlanText(text: string): string[] {
  return text
    .split(/\r?\n|(?=\s\d+[.)]\s)/)
    .map((line) => line.trim().replace(/^(?:\d+[.)]|[-*•])\s*/, ''))
    .filter((line) => line.length > 2)
    .slice(0, LIMITS.plan);
}

const WRITE_SHELL = /(>>?|\brm\b|\bdel\b|\bmv\b|\bcp\b|\bmove\b|\bsed\s+-i|\btee\b|Remove-Item|Set-Content|Add-Content|Out-File|Move-Item|Copy-Item|\btruncate\b)/i;

/** True when a shell command both writes and names a path covered by a protected pattern. */
export function shellTouchesProtected(command: string, store: WorkingStateStore): string | null {
  if (!WRITE_SHELL.test(command)) return null;
  const normalized = command.replace(/\\/g, '/').toLowerCase();
  for (const pattern of store.state.protectedPaths) {
    // Longest literal run of the pattern ("**/secret.txt" -> "secret.txt").
    const needle = pattern.toLowerCase().split(/[*?]+/).map((part) => part.replace(/^\/+|\/+$/g, '')).sort((a, b) => b.length - a.length)[0] ?? '';
    if (needle && normalized.includes(needle)) return pattern;
  }
  return null;
}

export function createStateUpdateTool(store: WorkingStateStore): Tool {
  return {
    name: 'state_update',
    description: 'Record working state the harness keeps for you across the whole task, even after the conversation is compacted: your plan, completed steps, established facts with sources, decisions with reasons, open questions, invariants, and paths that must never be modified. Use it when you make a plan, finish a step, learn a key fact, or decide something.',
    required: true,
    isReadOnly: true,
    parameters: {
      type: 'object',
      properties: {
        plan: { type: 'array', items: { type: 'string' }, description: 'Replace the plan with these steps' },
        completeSteps: { type: 'array', items: { type: 'number' }, description: '1-based step numbers now done' },
        addFacts: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, source: { type: 'string' } }, required: ['claim'] } },
        addDecisions: { type: 'array', items: { type: 'object', properties: { what: { type: 'string' }, why: { type: 'string' } }, required: ['what'] } },
        addQuestions: { type: 'array', items: { type: 'string' } },
        resolveQuestions: { type: 'array', items: { type: 'string' } },
        addInvariants: { type: 'array', items: { type: 'string' } },
        protectPaths: { type: 'array', items: { type: 'string' }, description: 'Paths or patterns (dir/, dir/**) that must never be modified' },
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const changes = store.apply(input as StateUpdate);
      return { success: true, output: changes.length > 0 ? `Working state updated: ${changes.join('; ')}` : 'No changes to working state.' };
    },
  };
}
