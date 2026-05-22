// Nervous System — Motor permission controller.
//
// Checks whether a tool call or action should be allowed, blocked,
// or require confirmation before execution.

import type { NervousRunState } from './reflexes';

export type MotorDecision = 'ALLOW' | 'ALLOW_DRY_RUN_ONLY' | 'REQUIRE_CONFIRMATION' | 'REQUIRE_VERIFICATION' | 'BLOCK' | 'INTERRUPT_AND_RECOVER';

export interface MotorPermission {
  decision: MotorDecision;
  reason: string;
  actionType: string;
  target: string;
}

// Tool categories for risk assessment
const READ_ONLY_TOOLS = new Set(['file_read', 'list_files', 'list_uploads', 'grep', 'web_search', 'web_read', 'rag_search', 'rag_list_indexes', 'calendar_read', 'image_analyze', 'pdf_read', 'pdf_metadata', 'pdf_extract_tables', 'audio_transcribe', 'desktop_screenshot', 'browser_bookmarks', 'email_inbox']);
const WRITE_TOOLS = new Set(['file_write', 'file_edit', 'file_move', 'file_delete', 'create_skill', 'install_skill', 'import_skill', 'memory_write', 'document_export']);
const NETWORK_TOOLS = new Set(['web_fetch', 'email_send', 'email_draft', 'telegram_notify', 'slack_notify']);
const SHELL_TOOLS = new Set(['bash']);
const DESTRUCTIVE_KEYWORDS = /\b(rm\s+-rf|del\s+\/[sfq]|remove-item.*-recurse|drop\s+table|truncate|format\s+[a-z]:|fdisk)\b/i;

export function checkMotorPermission(actionType: string, target: string, state: NervousRunState, toolInput?: Record<string, unknown>): MotorPermission {
  // Read-only tools are always allowed
  if (READ_ONLY_TOOLS.has(actionType)) {
    return { decision: 'ALLOW', reason: 'Read-only tool.', actionType, target };
  }

  // Recovery mode — only allow reads and verification
  if (state.recoveryMode && !READ_ONLY_TOOLS.has(actionType)) {
    return { decision: 'REQUIRE_VERIFICATION', reason: 'Recovery mode active. Verification required before non-read actions.', actionType, target };
  }

  // Interrupt requested — block new actions
  if (state.interruptRequested) {
    return { decision: 'INTERRUPT_AND_RECOVER', reason: 'Interrupt requested. Entering recovery.', actionType, target };
  }

  // Shell commands — check for destructive patterns
  if (SHELL_TOOLS.has(actionType)) {
    const command = String(toolInput?.command ?? '');
    if (DESTRUCTIVE_KEYWORDS.test(command)) {
      return { decision: 'BLOCK', reason: `Destructive shell command detected: ${command.slice(0, 100)}`, actionType, target };
    }
    if (state.riskLevel === 'critical') {
      return { decision: 'REQUIRE_CONFIRMATION', reason: 'Shell execution in critical-risk context.', actionType, target };
    }
  }

  // Email sending — always require confirmation in high-risk contexts
  if (actionType === 'email_send' || actionType === 'telegram_notify' || actionType === 'slack_notify') {
    if (state.riskLevel === 'high' || state.riskLevel === 'critical') {
      return { decision: 'REQUIRE_CONFIRMATION', reason: 'Notification sending in high-risk context.', actionType, target };
    }
  }

  // Dry-run required — allow only as dry-run
  if (state.dryRunRequired && (WRITE_TOOLS.has(actionType) || NETWORK_TOOLS.has(actionType) || SHELL_TOOLS.has(actionType))) {
    return { decision: 'ALLOW_DRY_RUN_ONLY', reason: 'Dry-run required for this action type.', actionType, target };
  }

  // Confirmation required for write/network/shell tools in high-risk
  if (state.confirmationRequired && (WRITE_TOOLS.has(actionType) || NETWORK_TOOLS.has(actionType) || SHELL_TOOLS.has(actionType))) {
    return { decision: 'REQUIRE_CONFIRMATION', reason: 'Confirmation required for write/network/shell actions.', actionType, target };
  }

  // Verifier required — require verification for write tools
  if (state.verifierRequired && WRITE_TOOLS.has(actionType)) {
    return { decision: 'REQUIRE_VERIFICATION', reason: 'Verification required before write actions.', actionType, target };
  }

  // Default: allow
  return { decision: 'ALLOW', reason: 'No restrictions.', actionType, target };
}
