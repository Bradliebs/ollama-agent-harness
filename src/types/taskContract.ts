// Task Contract — formal specification for a single agent task.
//
// Produced by buildTaskContract() before the loop starts.
// The contract is the measuring stick: it captures what is wanted,
// what is allowed, what must not be touched, and what counts as done.

export type TaskContractMode =
  | 'code_edit'
  | 'debug'
  | 'research'
  | 'planning'
  | 'file_analysis'
  | 'safe_read_only'
  | 'risky_action'
  | 'general';

export interface TaskContract {
  task_id: string;
  /** Primary goal, stripped of conversational filler. */
  goal: string;
  mode: TaskContractMode;
  /** Raw intent type from the Mycelium classifier. */
  intent_type: string;
  /** Explicit constraints extracted from the user message. */
  constraints: string[];
  /** Paths the agent may read/write. Empty = unrestricted within project root. */
  allowed_paths: string[];
  /** Paths the agent must never touch. */
  blocked_paths: string[];
  /** Validation commands to run after task completion (e.g. "npm run typecheck"). */
  validation: string[];
  /** What a passing outcome looks like. */
  success_criteria: string[];
  /** Conditions that mean the run has failed. */
  failure_triggers: string[];
  approval_required: boolean;
  max_turns: number;
  high_risk: boolean;
  created_at: string;
  /** "derived" = auto-built from message; "explicit" = caller provided full contract. */
  source: 'derived' | 'explicit';
}

/**
 * Renders a TaskContract as a compact Markdown block to inject into the
 * system prompt so the model always sees the operating constraints.
 */
export function renderTaskContractBlock(contract: TaskContract): string {
  const lines: string[] = [];
  lines.push('## Task Contract');
  lines.push('');
  lines.push(`**Goal:** ${contract.goal}`);
  lines.push(`**Mode:** ${contract.mode}${contract.high_risk ? '  ⚠️ HIGH RISK' : ''}`);

  if (contract.constraints.length > 0) {
    lines.push('');
    lines.push('**Constraints:**');
    for (const c of contract.constraints) {
      lines.push(`- ${c}`);
    }
  }

  if (contract.blocked_paths.length > 0) {
    lines.push('');
    lines.push(`**Blocked paths:** ${contract.blocked_paths.join(', ')}`);
  }

  if (contract.validation.length > 0) {
    lines.push('');
    lines.push(`**Validation:** ${contract.validation.join(' && ')}`);
  }

  if (contract.success_criteria.length > 0) {
    lines.push('');
    lines.push('**Success when:**');
    for (const s of contract.success_criteria) {
      lines.push(`- ${s}`);
    }
  }

  if (contract.failure_triggers.length > 0) {
    lines.push('');
    lines.push('**Failure if:**');
    for (const f of contract.failure_triggers) {
      lines.push(`- ${f}`);
    }
  }

  lines.push('');
  lines.push(`**Max turns:** ${contract.max_turns}  **Approval required:** ${contract.approval_required ? 'Yes' : 'No'}`);

  return lines.join('\n');
}
