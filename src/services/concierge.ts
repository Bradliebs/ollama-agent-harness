// Concierge-first triage.
//
// A small heuristic classifier that decides whether the main agent should
// handle a user message directly or delegate to a specialised sub-agent. The
// classifier is intentionally LLM-free — predictable, fast, and cheap. It
// returns one of:
//
//   { delegateTo: null,    reason: 'short / general turn — answer directly' }
//   { delegateTo: <agent>, reason: 'matched <signal>' }
//
// The set of available agents (built-in roles plus custom agents from
// `.harness/agents/`) is supplied by the caller so we can match against
// agent ids and free-form keyword hints declared in their definitions.
//
// Rules are ordered: the first match wins. Tweaking the rules here is the
// preferred way to bias delegation behaviour.

import * as fs from 'fs/promises';
import * as path from 'path';
import type { AgentDefinition } from '../agents/agentLoader';

export interface TriageResult {
  delegateTo: string | null;
  reason: string;
  matchedKeyword?: string;
  /**
   * 0.0–1.0 estimate of how confident the classifier is. Direct markers and
   * explicit keyword matches score high; token-fallback and long-input
   * heuristics score lower so callers can gate auto-route behind a threshold.
   */
  confidence: number;
}

export interface TriageOptions {
  /** When set, never delegate (useful when the user explicitly asked the main agent). */
  forceDirect?: boolean;
  /** Skip delegation when the message is shorter than this many characters. Defaults to 16. */
  shortMessageThreshold?: number;
  /** Hard ceiling on delegation: messages above this size still flow through (no extra penalty). */
  longMessageThreshold?: number;
  /** Optional keyword overrides per agent id. Replaces (not merges) the built-in defaults. */
  keywordOverrides?: Record<string, string[]>;
}

const SHORT_DEFAULT = 16;
const LONG_DEFAULT = 12_000;

const DEFAULT_KEYWORDS: Record<string, string[]> = {
  researcher: ['research', 'investigate', 'find documentation', 'how does', 'what is', 'compare', 'survey', 'gather sources', 'look into'],
  developer: ['implement', 'write code', 'add a function', 'fix the bug', 'patch', 'refactor', 'add tests for', 'edit the file', 'change the code'],
  qa: ['test', 'reproduce', 'verify the fix', 'qa', 'edge cases', 'regression', 'failing test'],
  writer: ['document', 'documentation', 'release notes', 'readme', 'rewrite the docs', 'explain in markdown', 'turn into a doc'],
  architect: ['plan', 'architecture', 'design a', 'sequence the work', 'phased approach', 'trade-offs', 'high-level approach', 'plan the work'],
  security: ['security review', 'owasp', 'vulnerability', 'secret leak', 'privilege escalation', 'attack surface', 'audit the security'],
};

const DIRECT_MARKERS = [
  'thanks',
  'thank you',
  'never mind',
  'cancel',
  'stop',
  'no thanks',
  'just answer',
  'just tell me',
  'directly',
  'do not delegate',
];

export function classifyIntent(
  message: string,
  agents: AgentDefinition[],
  options: TriageOptions = {},
): TriageResult {
  const trimmed = (message ?? '').trim();
  if (!trimmed) return { delegateTo: null, reason: 'empty message', confidence: 0 };

  if (options.forceDirect) {
    return { delegateTo: null, reason: 'caller forced direct handling', confidence: 1 };
  }

  const lower = trimmed.toLowerCase();
  for (const marker of DIRECT_MARKERS) {
    if (lower.includes(marker)) {
      return { delegateTo: null, reason: `matched direct marker "${marker}"`, matchedKeyword: marker, confidence: 1 };
    }
  }

  const shortThreshold = options.shortMessageThreshold ?? SHORT_DEFAULT;
  const longThreshold = options.longMessageThreshold ?? LONG_DEFAULT;
  if (trimmed.length < shortThreshold) {
    return { delegateTo: null, reason: 'message too short to delegate — answer directly', confidence: 0.9 };
  }
  if (trimmed.length > longThreshold) {
    // Still allow delegation, but prefer the architect for very long inputs.
    const architect = pickAgent('architect', agents);
    if (architect) {
      return { delegateTo: architect, reason: 'long input — routing to architect for sequencing', matchedKeyword: 'long-input', confidence: 0.5 };
    }
  }

  // Match agent-id keywords. Caller-supplied overrides win, then defaults.
  const overrides = options.keywordOverrides ?? {};
  for (const agent of orderedAgents(agents)) {
    const keywords = overrides[agent.id] ?? DEFAULT_KEYWORDS[agent.id] ?? [];
    for (const keyword of keywords) {
      if (lower.includes(keyword.toLowerCase())) {
        return { delegateTo: agent.id, reason: `matched keyword "${keyword}" → ${agent.id}`, matchedKeyword: keyword, confidence: 0.85 };
      }
    }
  }

  // Fallback: also match against agent name/description tokens for custom
  // agents that don't have a built-in keyword list. We check both "message
  // contains token" and "token contains a message word", so simple plural
  // mismatches (ledger / ledgers) still match.
  const messageWords = lower.split(/\W+/).filter((word) => word.length > 4);
  for (const agent of orderedAgents(agents)) {
    if (DEFAULT_KEYWORDS[agent.id]) continue;
    const tokens = (agent.name + ' ' + (agent.description ?? '')).toLowerCase().split(/\W+/).filter((token) => token.length > 4);
    for (const token of tokens) {
      if (lower.includes(token)) {
        return { delegateTo: agent.id, reason: `matched custom-agent token "${token}" → ${agent.id}`, matchedKeyword: token, confidence: 0.6 };
      }
      if (messageWords.some((word) => token.includes(word) || word.includes(token))) {
        return { delegateTo: agent.id, reason: `matched custom-agent token "${token}" → ${agent.id}`, matchedKeyword: token, confidence: 0.55 };
      }
    }
  }

  return { delegateTo: null, reason: 'no signal — answer directly', confidence: 0.5 };
}

function orderedAgents(agents: AgentDefinition[]): AgentDefinition[] {
  // Custom agents first so they shadow built-ins of the same id, then the
  // built-in list as supplied. Disabled agents are excluded.
  const enabled = agents.filter((agent) => agent.enabled !== false);
  const custom = enabled.filter((agent) => agent.filePath !== '<builtin>');
  const builtin = enabled.filter((agent) => agent.filePath === '<builtin>');
  return [...custom, ...builtin];
}

function pickAgent(id: string, agents: AgentDefinition[]): string | null {
  const match = orderedAgents(agents).find((agent) => agent.id === id);
  return match ? match.id : null;
}

// ─── Audit trail ────────────────────────────────────────────────────

export interface ConciergeLogEntry {
  timestamp: string;
  messagePreview: string;
  delegateTo: string | null;
  reason: string;
  matchedKeyword?: string;
  confidence: number;
  /** Set when the chat path actually executed the suggestion (auto-route mode). */
  autoRouted?: boolean;
}

const CONCIERGE_LOG_PATH = path.join('.harness', 'concierge', 'log.jsonl');
const CONCIERGE_LOG_MAX_LINES = 5_000;

function conciergeLogPath(projectDir: string): string {
  return path.join(projectDir, CONCIERGE_LOG_PATH);
}

export async function logConciergeDecision(projectDir: string, entry: Omit<ConciergeLogEntry, 'timestamp'> & { timestamp?: string }): Promise<void> {
  const fp = conciergeLogPath(projectDir);
  const full: ConciergeLogEntry = {
    timestamp: entry.timestamp ?? new Date().toISOString(),
    messagePreview: entry.messagePreview.slice(0, 240),
    delegateTo: entry.delegateTo,
    reason: entry.reason,
    matchedKeyword: entry.matchedKeyword,
    confidence: entry.confidence,
    autoRouted: entry.autoRouted,
  };
  try {
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.appendFile(fp, JSON.stringify(full) + '\n', 'utf-8');
  } catch {
    // Best-effort logging only.
  }
}

export async function readConciergeLog(projectDir: string, limit = 200): Promise<ConciergeLogEntry[]> {
  const fp = conciergeLogPath(projectDir);
  let raw: string;
  try {
    raw = await fs.readFile(fp, 'utf-8');
  } catch {
    return [];
  }
  const entries: ConciergeLogEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ConciergeLogEntry);
    } catch {
      // Skip corrupt lines.
    }
  }
  // Cap stored size: if we're way over, prune to the most recent N to keep
  // future reads fast. Best-effort.
  if (entries.length > CONCIERGE_LOG_MAX_LINES) {
    const latest = entries.slice(-CONCIERGE_LOG_MAX_LINES);
    fs.writeFile(fp, latest.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf-8').catch(() => {});
    return latest.slice(-limit);
  }
  return entries.slice(-limit);
}
