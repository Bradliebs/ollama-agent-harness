import * as fs from 'fs/promises';
import * as path from 'path';

// ─── Browser audit log ─────────────────────────────────────────────
//
// Append-only record of every browser page action (navigate, click,
// fill, read, screenshot) the agent performs, written to
// .harness/browser-audit.jsonl. Each line is a single JSON object with
// a timestamp, the tool name, the launch mode, the target URL, and the
// outcome.
//
// Redaction is applied HERE so the audit log is safe by construction:
// it NEVER stores page text or cookie values. The only potentially
// sensitive field is a `browser_fill` value, which is redacted by
// default (see `browserRedaction` in .harness/settings.json), and URLs
// can be narrowed to their origin to keep query-string tokens out.

const AUDIT_RELPATH = path.join('.harness', 'browser-audit.jsonl');
const SETTINGS_RELPATH = path.join('.harness', 'settings.json');

export interface BrowserAuditEntry {
  /** ISO 8601 timestamp of the action. */
  ts: string;
  /** Tool name, e.g. `browser_navigate`. */
  tool: string;
  /** Active launch mode at the time, e.g. `headless` or `cdp`. */
  mode: string;
  /** Page URL (redacted to origin when configured). */
  url?: string;
  /** Selector / label / text the action targeted — never page text. */
  target?: string;
  /** Whether the action succeeded or failed. */
  outcome: 'ok' | 'error';
  /** Short, non-sensitive note (char count, error head, filename). */
  detail?: string;
}

/** What a caller passes in; redaction + timestamp are applied by `recordBrowserAudit`. */
export interface BrowserAuditInput {
  tool: string;
  mode: string;
  url?: string;
  target?: string;
  outcome: 'ok' | 'error';
  detail?: string;
  /** Raw `browser_fill` value, redacted/truncated per settings before storage. */
  fillValue?: string;
}

interface RedactionConfig {
  redactValues: boolean;
  urlMode: 'full' | 'origin';
}

async function readRedactionConfig(): Promise<RedactionConfig> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), SETTINGS_RELPATH), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const r = parsed.browserRedaction;
    if (r && typeof r === 'object') {
      const rr = r as Record<string, unknown>;
      return {
        redactValues: rr.redactValues !== false,
        urlMode: rr.urlMode === 'origin' ? 'origin' : 'full',
      };
    }
  } catch {
    // Missing or malformed settings → secure defaults below.
  }
  return { redactValues: true, urlMode: 'full' };
}

function redactUrl(url: string | undefined, mode: 'full' | 'origin'): string | undefined {
  if (!url) return url;
  if (mode === 'full') return url;
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function formatFillValue(value: string, redact: boolean): string {
  if (redact) return `[redacted len=${value.length}]`;
  return value.length > 100 ? `${value.slice(0, 100)}…` : value;
}

/**
 * Append one redaction-safe entry to the browser audit log. Best-effort:
 * a failure to write the audit log must never break a tool call, so all
 * errors are swallowed.
 */
export async function recordBrowserAudit(input: BrowserAuditInput): Promise<void> {
  try {
    const cfg = await readRedactionConfig();
    let detail = input.detail;
    if (input.fillValue !== undefined) {
      const formatted = formatFillValue(input.fillValue, cfg.redactValues);
      detail = detail ? `${detail} ${formatted}` : formatted;
    }
    const entry: BrowserAuditEntry = {
      ts: new Date().toISOString(),
      tool: input.tool,
      mode: input.mode,
      url: redactUrl(input.url, cfg.urlMode),
      target: input.target,
      outcome: input.outcome,
      detail,
    };
    const dir = path.join(process.cwd(), '.harness');
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(process.cwd(), AUDIT_RELPATH), JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Never let audit logging surface as a tool failure.
  }
}

/**
 * Read the most recent audit entries, newest first. Returns at most
 * `limit` entries. Malformed lines are skipped.
 */
export async function readBrowserAudit(limit = 200): Promise<BrowserAuditEntry[]> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), AUDIT_RELPATH), 'utf-8');
    const entries: BrowserAuditEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as BrowserAuditEntry);
      } catch {
        // Skip corrupt lines rather than failing the whole read.
      }
    }
    const bounded = Math.max(1, Math.min(1000, Math.floor(limit) || 200));
    return entries.slice(-bounded).reverse();
  } catch {
    return [];
  }
}
