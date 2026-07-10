// Task Contract Builder — converts a freeform user message into a TaskContract.
//
// Deterministic: no model call required. Uses the Mycelium task classifier
// for intent + risk, regex patterns for constraint extraction, and
// heuristics for mode, validation, and path defaults.

import * as crypto from 'crypto';
import { classifyTask } from '../mycelium/taskClassifier';
import { classifyMode } from '../services/modeClassifier';
import type { TaskContract, TaskContractMode } from '../types/taskContract';

// ─── Constraint extraction ───────────────────────────────────────────

// Each pattern captures constraint-bearing language. The capture group
// (group 1 when present) is the constraint object/clause.

const CONSTRAINT_PATTERNS: Array<{ pattern: RegExp; template: (m: RegExpMatchArray) => string }> = [
  // "make sure (it|the|that) doesn't/don't/won't [verb phrase]"
  {
    pattern: /make sure (?:it|the|that|this)?\s*(?:does?n['']?t|won['']?t|isn['']?t)\s+([^,.\n]{3,60})/gi,
    template: (m) => `Do not ${m[1].trim()}`,
  },
  // "without touching/changing/modifying/altering/affecting X"
  {
    pattern: /without\s+(?:touching|changing|modifying|altering|affecting|breaking|messing\s+with)\s+([^,.\n]{3,60})/gi,
    template: (m) => `Do not alter ${m[1].trim()}`,
  },
  // "don't / do not [verb] X"
  {
    pattern: /(?:don['']?t|do\s+not)\s+(?:touch|modify|change|affect|alter|break|mess\s+with|delete|remove|overwrite)\s+([^,.\n]{3,60})/gi,
    template: (m) => `Do not touch ${m[1].trim()}`,
  },
  // "preserve X"
  {
    pattern: /\bpreserve\s+(?:the\s+|existing\s+)?([^,.\n]{3,60})/gi,
    template: (m) => `Preserve ${m[1].trim()}`,
  },
  // "keep X (the same|intact|unchanged|as-is)"
  {
    pattern: /\bkeep\s+(?:the\s+|existing\s+)?([^,.\n]{3,40})\s+(?:the\s+same|intact|unchanged|as[\s-]is)/gi,
    template: (m) => `Keep ${m[1].trim()} unchanged`,
  },
  // "leave X alone"
  {
    pattern: /\bleave\s+([^,.\n]{3,40})\s+alone\b/gi,
    template: (m) => `Leave ${m[1].trim()} untouched`,
  },
  // "avoid touching/changing/modifying X"
  {
    pattern: /\bavoid\s+(?:touching|changing|modifying|altering|affecting)\s+([^,.\n]{3,60})/gi,
    template: (m) => `Avoid touching ${m[1].trim()}`,
  },
];

const MAX_CONSTRAINTS = 20;

/** Extract explicit constraints from a natural-language message. */
export function extractConstraints(message: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  for (const { pattern, template } of CONSTRAINT_PATTERNS) {
    if (found.length >= MAX_CONSTRAINTS) break;
    pattern.lastIndex = 0;
    let m: RegExpMatchArray | null;
    while ((m = pattern.exec(message)) !== null) {
      if (found.length >= MAX_CONSTRAINTS) break;
      const text = template(m).replace(/\s+/g, ' ').trim();
      const key = text.toLowerCase();
      if (!seen.has(key) && text.length >= 6) {
        seen.add(key);
        found.push(text);
      }
    }
  }

  return found;
}

// ─── Goal extraction ─────────────────────────────────────────────────

const FILLER_PREFIXES = [
  /^can\s+you\s+/i,
  /^could\s+you\s+/i,
  /^please\s+/i,
  /^i\s+need\s+you\s+to\s+/i,
  /^i\s+want\s+you\s+to\s+/i,
  /^i\s+would\s+like\s+you\s+to\s+/i,
  /^i'?d\s+like\s+you\s+to\s+/i,
  /^would\s+you\s+/i,
  /^help\s+me\s+/i,
  /^can\s+we\s+/i,
  /^let'?s\s+/i,
];

/** Strip filler prefixes and return the primary goal sentence. */
export function extractGoal(message: string): string {
  // Take only up to the first sentence break that implies a pivot (and/but/make sure)
  // but not before 20 chars so we don't cut too early.
  let text = message.trim();

  // Strip leading filler
  for (const pattern of FILLER_PREFIXES) {
    text = text.replace(pattern, '');
  }

  // Trim to first natural sentence end
  const sentenceEnd = text.search(/[.!?]/);
  if (sentenceEnd > 4) {
    text = text.slice(0, sentenceEnd);
  }

  // Strip trailing filler like "and make sure X", "but don't Y"
  text = text.replace(/\s*(?:and\s+make\s+sure|,\s*make\s+sure|,?\s+but\s+(?:don['']?t|do\s+not)).+$/i, '');

  return text.trim() || message.trim().slice(0, 120);
}

// ─── Mode mapping ────────────────────────────────────────────────────

function intentToMode(intentType: string, harnessMode: string, harnessConfidence: number): TaskContractMode {
  // High-risk intents always map to risky_action
  if (['financial_execution', 'safety_critical', 'medical', 'legal'].includes(intentType)) {
    return 'risky_action';
  }

  // When harness mode confidently says research, trust it over Mycelium
  // 'coding' — which can fire on "implement" even in research contexts
  // like "research the best way to implement X".
  if (harnessMode === 'research' && harnessConfidence >= 0.6) {
    return 'research';
  }

  switch (intentType) {
    case 'coding':    return 'code_edit';
    case 'debugging': return 'debug';
    case 'planning':  return 'planning';
    case 'research':  return 'research';
    case 'financial_analysis': return 'file_analysis';
  }

  // Fall back to harness mode
  switch (harnessMode) {
    case 'build':    return 'code_edit';
    case 'research': return 'research';
    case 'maintain': return 'safe_read_only';
  }

  return 'general';
}

// ─── Validation inference ────────────────────────────────────────────

function inferValidation(mode: TaskContractMode): string[] {
  if (mode === 'code_edit' || mode === 'debug') {
    // Lightweight defaults — callers can override with project-specific commands.
    return ['npm run typecheck', 'npm test'];
  }
  return [];
}

// ─── Max turns ───────────────────────────────────────────────────────

function inferMaxTurns(mode: TaskContractMode): number {
  const table: Record<TaskContractMode, number> = {
    code_edit:     12,
    debug:         15,
    research:       8,
    planning:       6,
    file_analysis: 10,
    safe_read_only: 6,
    risky_action:   5,
    general:       10,
  };
  return table[mode];
}

// ─── Default blocked paths ───────────────────────────────────────────

const DEFAULT_BLOCKED_PATHS = [
  '.env',
  '.env.*',
  'secrets/',
  'node_modules/',
  '.git/',
];

// ─── Public API ──────────────────────────────────────────────────────

export interface ContractBuildOptions {
  /** Extra paths the agent is explicitly allowed to touch. */
  allowed_paths?: string[];
  /** Extra paths to block beyond the defaults. */
  extra_blocked_paths?: string[];
  /** Override validation commands. */
  validation?: string[];
  /** Override max turns. */
  max_turns?: number;
  /** Override approval_required. */
  approval_required?: boolean;
}

/**
 * Convert a freeform user message into a TaskContract.
 *
 * The result is deterministic and requires no model call, making it
 * safe to call before the loop starts and in pre-flight checks.
 */
export function buildTaskContract(
  message: string,
  options: ContractBuildOptions = {},
): TaskContract {
  const mycelium  = classifyTask(message);
  const harness   = classifyMode(message);
  const mode      = intentToMode(mycelium.type, harness.mode, harness.confidence);
  const highRisk  = mycelium.highRisk;

  const goal        = extractGoal(message);
  const constraints = extractConstraints(message);
  const validation  = options.validation ?? inferValidation(mode);
  const maxTurns    = options.max_turns ?? inferMaxTurns(mode);
  const approvalRequired = options.approval_required ?? highRisk;

  const blockedPaths = Array.from(new Set([
    ...DEFAULT_BLOCKED_PATHS,
    ...(options.extra_blocked_paths ?? []),
  ]));

  // Default success criteria derived from mode
  const successCriteria: string[] = [];
  if (validation.length > 0) {
    successCriteria.push(`All validation commands pass (${validation.join(', ')})`);
  }
  successCriteria.push('Goal is achieved as stated');
  if (constraints.length > 0) {
    successCriteria.push('All constraints respected');
  }

  const failureTriggers: string[] = [
    'Blocked path was modified',
  ];
  if (validation.length > 0) {
    failureTriggers.push('Validation command fails');
  }
  if (highRisk) {
    failureTriggers.push('High-risk action taken without approval');
  }

  return {
    task_id:          crypto.randomUUID().slice(0, 8),
    goal,
    mode,
    intent_type:      mycelium.type,
    constraints,
    allowed_paths:    options.allowed_paths ?? [],
    blocked_paths:    blockedPaths,
    validation,
    success_criteria: successCriteria,
    failure_triggers: failureTriggers,
    approval_required: approvalRequired,
    max_turns:        maxTurns,
    high_risk:        highRisk,
    created_at:       new Date().toISOString(),
    source:           'derived',
  };
}
