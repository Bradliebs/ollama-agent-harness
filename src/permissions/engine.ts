import type { PermissionRule, PermissionMode, PermissionResult, ToolCall } from '../types';
import * as path from 'path';
import { BUILTIN_TOOL_ENTRIES } from '../tools/registry';
import { getAllowedExternalPaths } from '../tools/pathResolution';
import { KillSwitch } from './killSwitch';

/**
 * Optional trust-ladder provider. When wired, PermissionEngine consults the
 * ladder BEFORE evaluating allow/deny rules and converts low rungs into
 * deny / ask decisions:
 *
 *   rung 0 (shadow)  → deny (observe only)
 *   rung 1 (suggest) → deny (surface a card, do not execute)
 *   rung 2 (ask)     → defer to normal rule evaluation
 *   rung 3 (confirm) → ask (typed confirmation expected upstream)
 *   rung 4 (act)     → defer (autonomous execution permitted)
 *
 * The provider is sync to keep evaluate() sync. Callers that need async
 * loading should snapshot the ladder once at startup and refresh on changes.
 */
export interface TrustLadderProvider {
  /** Map a tool call to a capability key. Return undefined to skip the gate. */
  capabilityOf(call: ToolCall): string | undefined;
  /** Current rung for a capability. */
  rungOf(capability: string): 0 | 1 | 2 | 3 | 4;
}

const EDIT_TOOLS = new Set(['file_write', 'file_edit']);
const FILE_MUTATION_TOOLS = new Set(['file_write', 'file_edit', 'file_move', 'file_delete']);
const READ_TOOLS = new Set(BUILTIN_TOOL_ENTRIES.filter((entry) => entry.tool.isReadOnly).map((entry) => entry.tool.name));
const PROTECTED_EXTERNAL_FILENAMES = new Set([
  '.env',
  'dockerfile',
  'journal.py',
  'package.json',
  'pyproject.toml',
  'setup.py',
  'telegram_sender.py',
]);
const PROTECTED_EXTERNAL_EXTENSIONS = new Set(['.bat', '.cmd', '.cjs', '.js', '.mjs', '.ps1', '.py', '.sh', '.ts']);

/**
 * META_TOOLS are harness-internal learning/memory tools that mutate only
 * `.harness/` scratch space — never user code, never the shell. They are
 * harmless to auto-approve under `acceptEdits`, and blocking them wastes
 * autonomous turns when an agent tries to record reflections or consolidate
 * memory between substantive tool calls.
 *
 * Exported (read-only by convention) so the IterationBudget refund logic
 * in `queryLoop.ts` can recognise meta-only turns without forking the list.
 */
export const META_TOOLS = new Set([
  'reflect',
  'analyze_patterns',
  'promote_pattern',
  'consolidate',
  'evolve',
  'improve_skill',
  'create_skill',
  'memory_write',
  'memory_read',
]);

export class PermissionEngine {
  private rules: PermissionRule[];
  private mode: PermissionMode;
  /**
   * Local kill-switch state used when no shared `KillSwitch` is wired. Tests
   * and standalone callers fall back to this; the server passes its shared
   * `KillSwitch` so per-session engines see live state.
   */
  private killSwitchActive = false;
  private killSwitchReason = '';
  private killSwitch?: KillSwitch;
  private trustLadder?: TrustLadderProvider;

  constructor(
    rules: PermissionRule[] = [],
    mode: PermissionMode = 'default',
    trustLadder?: TrustLadderProvider,
    killSwitch?: KillSwitch,
  ) {
    this.rules = rules;
    this.mode = mode;
    this.trustLadder = trustLadder;
    this.killSwitch = killSwitch;
  }

  /** Replace or clear the trust-ladder provider at runtime. */
  setTrustLadder(provider: TrustLadderProvider | undefined): void {
    this.trustLadder = provider;
  }

  /**
   * Attach (or detach) a shared `KillSwitch` after construction. Any future
   * kill-switch read/write goes through the shared instance.
   */
  setKillSwitch(killSwitch: KillSwitch | undefined): void {
    this.killSwitch = killSwitch;
  }

  /** Engage the global kill switch. While active, every tool call is denied. */
  engageKillSwitch(reason: string = 'Kill switch engaged.'): void {
    if (this.killSwitch) {
      this.killSwitch.engage(reason);
      return;
    }
    this.killSwitchActive = true;
    this.killSwitchReason = reason;
  }

  /** Release the kill switch and resume normal evaluation. */
  releaseKillSwitch(): void {
    if (this.killSwitch) {
      this.killSwitch.release();
      return;
    }
    this.killSwitchActive = false;
    this.killSwitchReason = '';
  }

  isKillSwitchActive(): boolean {
    return this.killSwitch ? this.killSwitch.isActive() : this.killSwitchActive;
  }

  getKillSwitchReason(): string {
    return this.killSwitch ? this.killSwitch.getReason() : this.killSwitchReason;
  }

  evaluate(call: ToolCall): PermissionResult {
    if (this.isKillSwitchActive()) {
      return { decision: 'deny', reason: this.getKillSwitchReason() || 'Kill switch active.' };
    }

    // Trust-ladder pre-check (no-op when not provided).
    if (this.trustLadder) {
      const cap = this.trustLadder.capabilityOf(call);
      if (cap) {
        const rung = this.trustLadder.rungOf(cap);
        if (rung === 0) return { decision: 'deny', reason: `Trust ladder rung 0 (shadow) for capability \`${cap}\` — observe only.` };
        if (rung === 1) return { decision: 'deny', reason: `Trust ladder rung 1 (suggest) for capability \`${cap}\` — surface a card, do not execute.` };
        if (rung === 3) return { decision: 'ask', reason: `Trust ladder rung 3 (confirm) for capability \`${cap}\` — typed confirmation required.` };
        // rungs 2 and 4 fall through to standard evaluation
      }
    }

    // Phase 1: Deny rules always evaluated first — deny overrides everything
    for (const rule of this.rules) {
      if (rule.type === 'deny' && this.matchesRule(rule, call)) {
        return { decision: 'deny', reason: `Denied by rule: ${rule.tool}`, rule };
      }
    }

    if (this.requiresProtectedExternalFileConfirmation(call)) {
      return { decision: 'ask', reason: 'Protected external program file requires confirmation.' };
    }

    // Phase 2: Allow rules
    for (const rule of this.rules) {
      if (rule.type === 'allow' && this.matchesRule(rule, call)) {
        return { decision: 'allow', reason: `Allowed by rule: ${rule.tool}`, rule };
      }
    }

    // Phase 3: Mode-based default
    return this.modeDefault(call);
  }

  async evaluateAsync(call: ToolCall): Promise<{ allowed: boolean; reason?: string }> {
    const result = this.evaluate(call);
    return {
      allowed: result.decision === 'allow',
      reason: result.reason,
    };
  }

  private matchesRule(rule: PermissionRule, call: ToolCall): boolean {
    // Wildcard match
    if (rule.tool === '*') return true;

    // Exact tool name match
    if (rule.tool === call.name) {
      // If rule has a pattern, check it against the serialized input
      if (rule.pattern) {
        const inputStr = JSON.stringify(call.input);
        return inputStr.includes(rule.pattern);
      }
      return true;
    }

    return false;
  }

  private modeDefault(call: ToolCall): PermissionResult {
    switch (this.mode) {
      case 'dontAsk':
        // Allow everything not explicitly denied
        return { decision: 'allow', reason: 'Mode: dontAsk — no matching deny rule' };

      case 'acceptEdits':
        // Auto-approve reads, file edits, and harness-internal meta tools;
        // ask for everything else (notably bash and arbitrary executors).
        if (READ_TOOLS.has(call.name) || EDIT_TOOLS.has(call.name) || META_TOOLS.has(call.name)) {
          return { decision: 'allow', reason: 'Mode: acceptEdits — read/edit/meta auto-approved' };
        }
        return { decision: 'ask', reason: 'Mode: acceptEdits — requires approval' };

      case 'default':
      default:
        // Read-only tools auto-approved; everything else asks
        if (READ_TOOLS.has(call.name)) {
          return { decision: 'allow', reason: 'Mode: default — read-only auto-approved' };
        }
        return { decision: 'ask', reason: 'Mode: default — requires approval' };
    }
  }

  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  getRules(): ReadonlyArray<PermissionRule> {
    return this.rules;
  }

  private requiresProtectedExternalFileConfirmation(call: ToolCall): boolean {
    if (!FILE_MUTATION_TOOLS.has(call.name)) return false;
    return mutationPaths(call).some((targetPath) => isProtectedExternalProgramPath(targetPath));
  }
}

function mutationPaths(call: ToolCall): string[] {
  const input = call.input ?? {};
  return [input.path, input.from, input.to, input.source, input.destination]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function isProtectedExternalProgramPath(rawPath: string): boolean {
  const target = path.resolve(rawPath);
  if (isInsideOrEqualPath(target, process.cwd())) return false;
  const externalRoot = getAllowedExternalPaths().find((allowedPath) => isInsideOrEqualPath(target, allowedPath));
  if (!externalRoot) return false;
  const basename = path.basename(target).toLowerCase();
  if (PROTECTED_EXTERNAL_FILENAMES.has(basename)) return true;
  // Check every dotted suffix so that 'malware.bat.txt' or 'evil.tar.sh' is
  // still treated as protected — a trailing-extension-only check (`.txt`)
  // would let attackers chain extensions to bypass.
  const segments = basename.split('.');
  for (let i = 1; i < segments.length; i++) {
    const ext = '.' + segments.slice(i).join('.');
    const lastExt = '.' + segments[i];
    if (PROTECTED_EXTERNAL_EXTENSIONS.has(ext)) return true;
    if (PROTECTED_EXTERNAL_EXTENSIONS.has(lastExt)) return true;
  }
  return false;
}

function isInsideOrEqualPath(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
