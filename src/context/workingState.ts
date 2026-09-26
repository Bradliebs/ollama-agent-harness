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

export class WorkingStateStore {
  private readonly data: WorkingState = { plan: [], facts: [], decisions: [], openQuestions: [], invariants: [], protectedPaths: [], sources: [] };
  private version = 0;

  constructor(seed: Partial<Pick<WorkingState, 'invariants' | 'protectedPaths'>> = {}) {
    for (const invariant of seed.invariants ?? []) this.addInvariant(invariant);
    for (const pattern of seed.protectedPaths ?? []) this.protect(pattern);
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
    const added = pushCapped(this.data.sources, { url, ...(title ? { title: clean(title) } : {}) }, LIMITS.sources, (a, b) => a.url === b.url);
    if (added) this.version += 1;
    return added;
  }

  private addInvariant(invariant: string): boolean {
    const text = clean(invariant);
    const added = Boolean(text) && pushCapped(this.data.invariants, text, LIMITS.invariants, (a, b) => a === b);
    if (added) this.version += 1;
    return added;
  }

  private protect(pattern: string): boolean {
    const normalized = normalizeProtectedPattern(clean(pattern));
    const added = Boolean(normalized) && pushCapped(this.data.protectedPaths, normalized, LIMITS.protectedPaths, (a, b) => a === b);
    if (added) this.version += 1;
    return added;
  }

  /** The protected pattern that covers an absolute path, if any. */
  protectedMatch(absPath: string, projectRoot: string): string | null {
    const relative = path.relative(projectRoot, absPath).replace(/\\/g, '/');
    const candidates = [relative, absPath.replace(/\\/g, '/')];
    for (const pattern of this.data.protectedPaths) {
      const lower = pattern.toLowerCase();
      for (const candidate of candidates.map((c) => c.toLowerCase())) {
        if (lower.includes('**')) {
          const prefix = lower.slice(0, lower.indexOf('**'));
          if (candidate.startsWith(prefix) || candidate.includes(`/${prefix}`)) return pattern;
        } else if (lower.endsWith('/')) {
          if (candidate.startsWith(lower) || candidate.includes(`/${lower}`)) return pattern;
        } else if (candidate === lower || candidate.endsWith(`/${lower}`)) {
          return pattern;
        }
      }
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
    const needle = pattern.toLowerCase().replace(/\*\*.*$/, '').replace(/\/$/, '');
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
