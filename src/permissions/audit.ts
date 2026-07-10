// Audit-everything hook.
//
// Writes a JSONL line per tool call to `.harness/audit.log`. Captures the
// PreToolUse signal so we always have an entry even if the tool result is
// blocked or never returns, and a PostToolUse / PostToolUseFailure entry
// once the tool finishes (or errors).
//
// Inputs are summarised — full payloads are truncated to a fixed character
// limit per field so the log stays bounded under heavy use. Tools that
// commonly carry secrets (api keys, tokens) get redacted via a small
// allowlist of field names.

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Hook, HookContext, HookResult, HookHandler } from '../types';

export interface AuditHookOptions {
  projectDir: string;
  /** Override the audit file path. */
  filePath?: string;
  /** Max characters per stringified field (default 2000). */
  maxFieldChars?: number;
  /** Field names whose values are replaced with `[redacted]`. */
  redactFields?: string[];
}

export interface AuditEntry {
  timestamp: string;
  eventType: HookContext['eventType'];
  tool?: string;
  /** Truncated, JSON-stringified input. */
  input?: string;
  /** Truncated tool output (post events only). */
  output?: string;
  error?: string;
}

const DEFAULT_MAX_FIELD = 2000;
const DEFAULT_REDACT = new Set(['api_key', 'apiKey', 'token', 'password', 'secret', 'authorization', 'auth_token']);

export function auditFilePath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'audit.log');
}

export function createAuditHooks(options: AuditHookOptions): Hook[] {
  const filePath = options.filePath ?? auditFilePath(options.projectDir);
  const maxFieldChars = options.maxFieldChars ?? DEFAULT_MAX_FIELD;
  const redact = new Set([...DEFAULT_REDACT, ...(options.redactFields ?? [])]);

  const handler = async (context: HookContext): Promise<HookResult> => {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      eventType: context.eventType,
      tool: context.toolName,
      input: context.toolInput ? truncate(JSON.stringify(redactInput(context.toolInput, redact)), maxFieldChars) : undefined,
      output: context.toolOutput ? truncate(context.toolOutput, maxFieldChars) : undefined,
      error: context.error,
    };
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // Audit must never break the loop — swallow.
    }
    return { action: 'continue' };
  };

  const wrap = (name: string, eventType: HookContext['eventType']): Hook => ({
    name,
    eventType,
    handler: handler as HookHandler,
  });

  return [
    wrap('audit.preToolUse', 'PreToolUse'),
    wrap('audit.postToolUse', 'PostToolUse'),
    wrap('audit.postToolUseFailure', 'PostToolUseFailure'),
  ];
}

export async function readAuditLog(projectDir: string, limit = 200): Promise<AuditEntry[]> {
  const filePath = auditFilePath(projectDir);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  const entries: AuditEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as AuditEntry);
    } catch {
      // Corrupt lines are skipped rather than crashing the reader.
    }
  }
  return entries.slice(-limit);
}

/**
 * Append a single pre-built audit entry to the project's audit log.
 *
 * Use this for significant non-tool actions (e.g. a goal undo / rollback)
 * that should leave the same JSONL trail as tool calls. Best-effort: a write
 * failure is swallowed so auditing never breaks the action it records.
 */
export async function appendAuditEntry(projectDir: string, entry: AuditEntry): Promise<void> {
  const filePath = auditFilePath(projectDir);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Audit must never break the action it records — swallow.
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + `…[+${value.length - max} chars]`;
}

function redactInput(input: Record<string, unknown>, redactFields: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (redactFields.has(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactInput(value as Record<string, unknown>, redactFields);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface RenderRecentAuditOptions {
  /** Max audit entries to scan from the tail. Defaults to 50. */
  scanLimit?: number;
  /** Only entries newer than this many ms are considered. Defaults to 10 minutes. */
  windowMs?: number;
  /** Only render when at least this many failures appear in the window. Defaults to 2. */
  minFailures?: number;
  /** Override of the audit reader (test seam). */
  reader?: typeof readAuditLog;
}

/**
 * Build a compact summary of recent tool failures for inclusion in the chat
 * system prompt. Returns an empty string when nothing actionable is in the
 * window; the goal is to surface signal, not chatter.
 */
export async function renderRecentAuditForPrompt(
  projectDir: string,
  options: RenderRecentAuditOptions = {},
): Promise<string> {
  const scanLimit = options.scanLimit ?? 50;
  const windowMs = options.windowMs ?? 10 * 60 * 1000;
  const minFailures = options.minFailures ?? 2;
  const reader = options.reader ?? readAuditLog;
  const entries = await reader(projectDir, scanLimit).catch(() => []);
  if (entries.length === 0) return '';
  const cutoff = Date.now() - windowMs;
  const recentFailures = entries.filter((entry) => {
    if (entry.eventType !== 'PostToolUseFailure') return false;
    const ts = Date.parse(entry.timestamp);
    return Number.isFinite(ts) && ts >= cutoff;
  });
  if (recentFailures.length < minFailures) return '';
  const byTool = new Map<string, number>();
  for (const entry of recentFailures) {
    const key = entry.tool ?? '(unknown)';
    byTool.set(key, (byTool.get(key) ?? 0) + 1);
  }
  const lines: string[] = [`Recent tool failures (last ${Math.round(windowMs / 60_000)} min): ${recentFailures.length} total.`];
  for (const [tool, count] of [...byTool.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${tool}: ${count} failure(s)`);
  }
  // Surface up to 3 most recent error messages for context.
  const sample = recentFailures.slice(-3);
  for (const entry of sample) {
    const where = entry.tool ? `${entry.tool} ` : '';
    const why = entry.error ? entry.error.slice(0, 200) : 'no error message';
    lines.push(`- ${where}@ ${entry.timestamp}: ${why}`);
  }
  lines.push('Consider switching tools or asking the user before retrying the same call.');
  return `# Recent Audit\n${lines.join('\n')}`;
}
