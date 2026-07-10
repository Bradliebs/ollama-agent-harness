// LLM-backed command classifier for permission-approval cards.
//
// When the harness decides a shell command needs the user's approval, the
// raw command string is often opaque to a non-developer. This module asks a
// small local model to:
//   1. classify the command (readonly | writes | network | destructive),
//   2. write a one-sentence, jargon-free explanation of what it does, and
//   3. suggest a safe `*`-wildcard pattern the user can "always allow".
//
// It is advisory only — it never grants or denies. The PermissionEngine still
// owns the decision; this just makes the approval card friendlier and lets the
// user broaden a grant safely. Read-only commands take a deterministic
// fast-path and never hit the model.

export type CommandCategory = 'readonly' | 'writes' | 'network' | 'destructive' | 'unknown';

export interface CommandClassification {
  /** One short, non-technical sentence describing what the command does. */
  explanation: string;
  /** Best single-fit risk category. */
  category: CommandCategory;
  /** A `*`-wildcard pattern that safely matches similar commands, or null. */
  suggestedPattern: string | null;
  /** One-sentence justification for the pattern; null iff suggestedPattern is null. */
  patternRationale: string | null;
}

/** Inference hook — returns the model's raw text completion. */
export type InferFn = (opts: {
  systemPrompt: string;
  userMessage: string;
  timeoutMs?: number;
}) => Promise<string>;

export interface ClassifierDeps {
  infer: InferFn;
  /** Predicate that returns true for commands that only read state. */
  isReadOnlyCommand?: (command: string) => boolean;
  /** Per-call inference timeout. Defaults to 8s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

const VALID_CATEGORIES: ReadonlySet<CommandCategory> = new Set<CommandCategory>([
  'readonly',
  'writes',
  'network',
  'destructive',
  'unknown',
]);

const SYSTEM_PROMPT = [
  'Classify a shell command for a permission-approval dialog.',
  'Respond with JSON only, matching: {"explanation":string,"category":"readonly"|"writes"|"network"|"destructive"|"unknown","suggestedPattern":string|null,"patternRationale":string|null}.',
  'explanation: one short non-technical sentence, no jargon.',
  'category: best single fit.',
  'suggestedPattern: a pattern using * wildcards that safely matches future similar commands; null if broadening would be unsafe.',
  'patternRationale: one-sentence justification; null iff suggestedPattern is null.',
].join(' ');

/**
 * Deterministic fallback used when the model is unavailable or returns
 * unparseable output. Never blocks the approval flow.
 */
export const FALLBACK_CLASSIFICATION: CommandClassification = {
  explanation: 'This command could not be automatically explained. Review it before approving.',
  category: 'unknown',
  suggestedPattern: null,
  patternRationale: null,
};

/**
 * Best-effort heuristic for whether a command only reads state. Conservative:
 * a command qualifies only when its leading token is a known read-only verb
 * and it contains no shell control operators or redirects.
 */
const READ_ONLY_LEADERS = new Set([
  'ls', 'dir', 'cat', 'type', 'pwd', 'echo', 'whoami', 'hostname', 'date',
  'head', 'tail', 'wc', 'grep', 'rg', 'find', 'stat', 'file', 'which', 'where',
  'env', 'printenv', 'tree', 'du', 'df', 'ps', 'top', 'uptime',
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote']);

export function defaultIsReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // Reject anything with shell chaining/redirects — could hide a write.
  if (/[;&|><`$()]/.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  const leader = tokens[0]?.toLowerCase() ?? '';
  if (leader === 'git') {
    const sub = tokens[1]?.toLowerCase() ?? '';
    return READ_ONLY_GIT_SUBCOMMANDS.has(sub);
  }
  return READ_ONLY_LEADERS.has(leader);
}

function readOnlyClassification(command: string): CommandClassification {
  const leader = command.trim().split(/\s+/)[0]?.toLowerCase() ?? 'command';
  return {
    explanation: 'This command only reads information and does not change anything.',
    category: 'readonly',
    suggestedPattern: `${leader} *`,
    patternRationale: `Read-only ${leader} commands are safe to always allow.`,
  };
}

function str(val: unknown): string | null {
  return typeof val === 'string' ? val : null;
}

/** Extract the first balanced JSON object from a (possibly noisy) completion. */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function parseLLMOutput(raw: string): CommandClassification | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  const category = rec.category;
  if (typeof category !== 'string' || !VALID_CATEGORIES.has(category as CommandCategory)) return null;
  const suggestedPattern = rec.suggestedPattern === null ? null : str(rec.suggestedPattern);
  const patternRationale = rec.patternRationale === null ? null : str(rec.patternRationale);
  return {
    explanation: str(rec.explanation) ?? '',
    category: category as CommandCategory,
    // A pattern without a rationale (or vice versa) is incoherent — drop both.
    suggestedPattern: patternRationale === null ? null : suggestedPattern,
    patternRationale: suggestedPattern === null ? null : patternRationale,
  };
}

/**
 * Classify a shell command for an approval card. Returns a friendly
 * explanation, a risk category, and an optional safe broadening pattern.
 * Always resolves — falls back to a neutral classification on any error.
 */
export async function classifyCommand(command: string, deps: ClassifierDeps): Promise<CommandClassification> {
  const isReadOnly = deps.isReadOnlyCommand ?? defaultIsReadOnlyCommand;
  if (isReadOnly(command)) {
    return readOnlyClassification(command);
  }

  try {
    const raw = await deps.infer({
      systemPrompt: SYSTEM_PROMPT,
      userMessage: command,
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return parseLLMOutput(raw) ?? FALLBACK_CLASSIFICATION;
  } catch {
    return FALLBACK_CLASSIFICATION;
  }
}
