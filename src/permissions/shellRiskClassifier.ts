// Deterministic 3-tier shell-command risk classifier.
//
// Sits ABOVE the deny-first PermissionEngine, not inside it. The permission
// engine decides whether a tool is allowed at all (capability grants); this
// classifier decides how to surface the prompt:
//
//   - 'safe'      : auto-approve. Read-only / observational commands.
//   - 'write'     : prompt via the existing permission engine. Default tier.
//   - 'dangerous' : hard-block. Irreversible or destructive patterns the
//                   harness will not run even with broad shell access.
//
// The classifier parses pipe / && / || / ; chains and returns the tier of
// the highest-risk segment, so `ls && rm -rf /` is correctly 'dangerous'.

import type { ShellRule } from './defaultShellRules';
import { DEFAULT_SHELL_RULES } from './defaultShellRules';

export type RiskTier = 'safe' | 'write' | 'dangerous';

const TIER_RANK: Record<RiskTier, number> = { safe: 0, write: 1, dangerous: 2 };

export interface RiskClassification {
  tier: RiskTier;
  reason: string;
  /** Rule id that produced the tier, or `'default-write'` if nothing matched. */
  matchedRule: string;
  /** The chained segment whose match drove the tier. */
  segment: string;
  /** All chained segments, in order. Useful for UI. */
  segments: string[];
}

/**
 * Split a command line into chained segments at top-level shell operators:
 * `;`, `|`, `||`, `&&`. Honours single-quote, double-quote, and backtick
 * regions so an operator inside a string is treated as a literal.
 *
 * Redirects (`>`, `>>`, `<`) are NOT segment boundaries — they belong to
 * the surrounding command and are matched by the rules themselves.
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let buf = '';
  let i = 0;
  let quote: '"' | "'" | '`' | null = null;
  while (i < command.length) {
    const ch = command[i] ?? '';
    if (quote) {
      buf += ch;
      // Backslash-escape inside double quotes only.
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        buf += command[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      buf += ch;
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      // Outside quotes a backslash escapes the next char (including operators).
      buf += ch + command[i + 1];
      i += 2;
      continue;
    }
    // Two-char operators &&, ||
    if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
      pushSegment(segments, buf);
      buf = '';
      i += 2;
      continue;
    }
    // Single-char operators ;, |
    if (ch === ';' || ch === '|') {
      pushSegment(segments, buf);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  pushSegment(segments, buf);
  return segments;
}

function pushSegment(into: string[], buf: string): void {
  const trimmed = buf.trim();
  if (trimmed.length > 0) into.push(trimmed);
}

function classifySegment(segment: string, rules: ReadonlyArray<ShellRule>): {
  tier: RiskTier;
  reason: string;
  matchedRule: string;
} {
  // Dangerous rules first — a dangerous match overrides any safe leader.
  for (const rule of rules) {
    if (rule.tier === 'dangerous' && rule.pattern.test(segment)) {
      return { tier: 'dangerous', reason: rule.reason, matchedRule: rule.id };
    }
  }
  // Then safe.
  for (const rule of rules) {
    if (rule.tier === 'safe' && rule.pattern.test(segment)) {
      return { tier: 'safe', reason: rule.reason, matchedRule: rule.id };
    }
  }
  // Then any explicit 'write' rule (rare; defaults are dangerous+safe only).
  for (const rule of rules) {
    if (rule.tier === 'write' && rule.pattern.test(segment)) {
      return { tier: 'write', reason: rule.reason, matchedRule: rule.id };
    }
  }
  return { tier: 'write', reason: 'no matching safe or dangerous rule', matchedRule: 'default-write' };
}

/**
 * Classify a shell command into a risk tier. Empty / whitespace-only commands
 * are classified as 'safe' with an explicit no-op reason.
 *
 * Rule precedence: user-supplied rules are tried in array order, so callers
 * who want to override default behaviour should prepend their rules to
 * `DEFAULT_SHELL_RULES` (the `mergeRules` helper does this).
 */
export function classifyShellCommand(
  command: string,
  rules: ReadonlyArray<ShellRule> = DEFAULT_SHELL_RULES,
): RiskClassification {
  const segments = splitCommandSegments(command);
  if (segments.length === 0) {
    return {
      tier: 'safe',
      reason: 'empty command',
      matchedRule: 'empty',
      segment: '',
      segments: [],
    };
  }
  let worst: { tier: RiskTier; reason: string; matchedRule: string; segment: string } = {
    tier: 'safe',
    reason: '',
    matchedRule: '',
    segment: segments[0] ?? '',
  };
  for (const seg of segments) {
    const r = classifySegment(seg, rules);
    if (TIER_RANK[r.tier] > TIER_RANK[worst.tier] || worst.reason === '') {
      worst = { ...r, segment: seg };
    }
  }
  // Operator-spanning dangerous patterns (curl | sh, fork bomb, eval $(curl …))
  // cannot match a single segment because the split has already consumed the
  // operator. Re-check dangerous rules against the WHOLE command as a fallback;
  // only override if per-segment matching did not already find a dangerous tier
  // (so the more-precise segment field is preserved when possible).
  if (worst.tier !== 'dangerous') {
    for (const rule of rules) {
      if (rule.tier === 'dangerous' && rule.pattern.test(command)) {
        worst = {
          tier: 'dangerous',
          reason: rule.reason,
          matchedRule: rule.id,
          segment: command.trim(),
        };
        break;
      }
    }
  }
  return { ...worst, segments };
}

/**
 * Merge user-supplied rules with the defaults, putting user rules first so
 * they win on conflict. Pure — neither array is mutated.
 */
export function mergeRules(
  userRules: ReadonlyArray<ShellRule>,
  defaults: ReadonlyArray<ShellRule> = DEFAULT_SHELL_RULES,
): ReadonlyArray<ShellRule> {
  return [...userRules, ...defaults];
}
