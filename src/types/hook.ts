export type HookEventType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'SessionStart'
  | 'SessionEnd'
  | 'PreCompact'
  | 'PostCompact';

export interface HookContext {
  eventType: HookEventType;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  error?: string;
}

export interface HookResult {
  action: 'continue' | 'block' | 'modify';
  reason?: string;
  modifiedInput?: Record<string, unknown>;
  modifiedOutput?: string;
  additionalContext?: string;
}

export type HookHandler = (context: HookContext) => Promise<HookResult>;

export interface Hook {
  name: string;
  eventType: HookEventType;
  handler: HookHandler;
}
