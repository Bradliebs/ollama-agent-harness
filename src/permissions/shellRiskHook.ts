// PreToolUse hook factory that gates shell tool calls with the
// 3-tier shell-risk classifier.
//
// Behaviour:
//   - tier === 'dangerous' : returns { action: 'block', reason }.
//   - tier === 'safe'      : returns { action: 'continue' }. The hook does
//                            NOT bypass the permission engine; if the user
//                            wants auto-approval, they configure that there.
//                            The hook's role here is purely to surface the
//                            tier in the audit context.
//   - tier === 'write'     : returns { action: 'continue' }. The existing
//                            permission engine prompts as usual.
//
// Optional override: `.harness/shell-rules.json` (loaded eagerly at hook
// construction). Load errors are logged loudly — there is no silent fallback,
// per the locked Phase 3 decision.

import * as fs from 'fs';
import * as path from 'path';
import type { Hook, HookContext, HookResult } from '../types';
import type { ShellRule } from './defaultShellRules';
import { DEFAULT_SHELL_RULES } from './defaultShellRules';
import { classifyShellCommand, mergeRules, type RiskTier } from './shellRiskClassifier';

export interface ShellRiskHookOptions {
  /**
   * Tool names whose `toolInput.command` should be classified.
   * Defaults to `['bash', 'docker_exec']`.
   */
  shellToolNames?: ReadonlyArray<string>;
  /**
   * Rules to use instead of loading from disk. If provided, no JSON file
   * is read. Tests use this to inject deterministic rule sets.
   */
  rules?: ReadonlyArray<ShellRule>;
  /**
   * Project root used to locate `.harness/shell-rules.json` when `rules`
   * is not provided. If unset, the override file is not consulted.
   */
  projectDir?: string;
  /**
   * Logger sink for load errors. Defaults to `console.error`. Tests pass
   * an array-pusher to assert loud failure.
   */
  logError?: (msg: string) => void;
}

const DEFAULT_SHELL_TOOL_NAMES: ReadonlyArray<string> = ['bash', 'docker_exec'];

/**
 * Resolve the rule set from options. Throws nothing — load errors are
 * reported through `logError` and the defaults are used.
 */
export function resolveShellRules(opts: ShellRiskHookOptions = {}): ReadonlyArray<ShellRule> {
  if (opts.rules) return opts.rules;
  if (!opts.projectDir) return DEFAULT_SHELL_RULES;
  const filePath = path.join(opts.projectDir, '.harness', 'shell-rules.json');
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === 'ENOENT') return DEFAULT_SHELL_RULES;
    const msg = err instanceof Error ? err.message : String(err);
    (opts.logError ?? console.error)(`[shell-risk] failed to read ${filePath}: ${msg}`);
    return DEFAULT_SHELL_RULES;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    (opts.logError ?? console.error)(`[shell-risk] ${filePath} is not valid JSON: ${msg}`);
    return DEFAULT_SHELL_RULES;
  }
  const userRules = parseUserRules(parsed, opts.logError ?? console.error, filePath);
  if (userRules === null) return DEFAULT_SHELL_RULES;
  return mergeRules(userRules);
}

interface RawRule {
  id?: unknown;
  pattern?: unknown;
  flags?: unknown;
  tier?: unknown;
  reason?: unknown;
}

function parseUserRules(parsed: unknown, logError: (msg: string) => void, filePath: string): ShellRule[] | null {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { rules?: unknown }).rules)) {
    logError(`[shell-risk] ${filePath} must contain a top-level "rules": [...] array`);
    return null;
  }
  const out: ShellRule[] = [];
  const rawList = (parsed as { rules: unknown[] }).rules;
  for (let i = 0; i < rawList.length; i++) {
    const r = rawList[i];
    if (!r || typeof r !== 'object') {
      logError(`[shell-risk] ${filePath} rule[${i}] is not an object — skipped`);
      continue;
    }
    const rec = r as RawRule;
    if (typeof rec.id !== 'string' || typeof rec.pattern !== 'string' ||
        typeof rec.tier !== 'string' || typeof rec.reason !== 'string') {
      logError(`[shell-risk] ${filePath} rule[${i}] missing id/pattern/tier/reason — skipped`);
      continue;
    }
    if (rec.tier !== 'safe' && rec.tier !== 'write' && rec.tier !== 'dangerous') {
      logError(`[shell-risk] ${filePath} rule[${i}] has invalid tier '${rec.tier}' — skipped`);
      continue;
    }
    const flags = typeof rec.flags === 'string' ? rec.flags : 'i';
    let pattern: RegExp;
    try {
      pattern = new RegExp(rec.pattern, flags);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[shell-risk] ${filePath} rule[${i}] pattern is invalid: ${msg} — skipped`);
      continue;
    }
    out.push({ id: rec.id, pattern, tier: rec.tier as RiskTier, reason: rec.reason });
  }
  return out;
}

/**
 * Create the PreToolUse hook that classifies shell commands.
 * Returns an array (matching `createAuditHooks`'s shape) for symmetry, even
 * though there is currently only one hook.
 */
export function createShellRiskHooks(options: ShellRiskHookOptions = {}): Hook[] {
  const rules = resolveShellRules(options);
  const shellTools = new Set(options.shellToolNames ?? DEFAULT_SHELL_TOOL_NAMES);

  const handler = async (ctx: HookContext): Promise<HookResult> => {
    if (ctx.eventType !== 'PreToolUse') return { action: 'continue' };
    if (!ctx.toolName || !shellTools.has(ctx.toolName)) return { action: 'continue' };
    const cmd = ctx.toolInput?.command;
    if (typeof cmd !== 'string' || cmd.trim() === '') return { action: 'continue' };

    const r = classifyShellCommand(cmd, rules);
    if (r.tier === 'dangerous') {
      return {
        action: 'block',
        reason: `Shell risk classifier blocked '${ctx.toolName}': ${r.reason} (rule: ${r.matchedRule}, segment: ${truncate(r.segment, 120)})`,
      };
    }
    return { action: 'continue' };
  };

  return [
    {
      name: 'shellRisk.preToolUse',
      eventType: 'PreToolUse',
      handler,
    },
  ];
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
