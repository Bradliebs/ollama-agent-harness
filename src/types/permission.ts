export type PermissionDecision = 'allow' | 'deny' | 'ask';

export interface PermissionRule {
  type: 'allow' | 'deny';
  tool: string;
  pattern?: string;
}

export type PermissionMode = 'default' | 'acceptEdits' | 'dontAsk';

export interface PermissionResult {
  decision: PermissionDecision;
  reason?: string;
  rule?: PermissionRule;
}
