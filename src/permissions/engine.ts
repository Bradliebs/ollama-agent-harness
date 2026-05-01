import type { PermissionRule, PermissionMode, PermissionResult, ToolCall } from '../types';
import { BUILTIN_TOOL_ENTRIES } from '../tools/registry';

const EDIT_TOOLS = new Set(['file_write', 'file_edit']);
const READ_TOOLS = new Set(BUILTIN_TOOL_ENTRIES.filter((entry) => entry.tool.isReadOnly).map((entry) => entry.tool.name));

export class PermissionEngine {
  private rules: PermissionRule[];
  private mode: PermissionMode;
  private killSwitchActive = false;
  private killSwitchReason = '';

  constructor(rules: PermissionRule[] = [], mode: PermissionMode = 'default') {
    this.rules = rules;
    this.mode = mode;
  }

  /** Engage the global kill switch. While active, every tool call is denied. */
  engageKillSwitch(reason: string = 'Kill switch engaged.'): void {
    this.killSwitchActive = true;
    this.killSwitchReason = reason;
  }

  /** Release the kill switch and resume normal evaluation. */
  releaseKillSwitch(): void {
    this.killSwitchActive = false;
    this.killSwitchReason = '';
  }

  isKillSwitchActive(): boolean {
    return this.killSwitchActive;
  }

  getKillSwitchReason(): string {
    return this.killSwitchReason;
  }

  evaluate(call: ToolCall): PermissionResult {
    if (this.killSwitchActive) {
      return { decision: 'deny', reason: this.killSwitchReason || 'Kill switch active.' };
    }

    // Phase 1: Deny rules always evaluated first — deny overrides everything
    for (const rule of this.rules) {
      if (rule.type === 'deny' && this.matchesRule(rule, call)) {
        return { decision: 'deny', reason: `Denied by rule: ${rule.tool}`, rule };
      }
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
        // Auto-approve reads and file edits; ask for everything else
        if (READ_TOOLS.has(call.name) || EDIT_TOOLS.has(call.name)) {
          return { decision: 'allow', reason: 'Mode: acceptEdits — read/edit auto-approved' };
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
}
