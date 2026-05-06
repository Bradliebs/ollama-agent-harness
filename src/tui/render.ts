// Pure render helpers for the TUI. Kept dependency-free and pure so the
// rendering logic is fully testable without spinning up readline or
// connecting to a daemon.

const ANSI_RESET = '\x1b[0m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_DIM = '\x1b[2m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_RED = '\x1b[31m';
const ANSI_MAGENTA = '\x1b[35m';
const ANSI_BLUE = '\x1b[34m';

export interface TuiSize {
  cols: number;
  rows: number;
}

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool' | 'error';

export interface ChatEntry {
  role: ChatRole;
  text: string;
  timestamp?: string;
}

export interface ActiveSubagentSummary {
  id: string;
  name: string;
  durationMs: number;
}

/**
 * Wrap `text` to `width` columns using a simple greedy word-wrap that
 * preserves explicit newlines. Pure: no terminal control characters.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    if (rawLine.length <= width) {
      out.push(rawLine);
      continue;
    }
    const words = rawLine.split(/(\s+)/);
    let current = '';
    for (const word of words) {
      if ((current + word).length > width) {
        if (current) out.push(current);
        current = word.trim();
        // Hard-break overlong individual words.
        while (current.length > width) {
          out.push(current.slice(0, width));
          current = current.slice(width);
        }
      } else {
        current += word;
      }
    }
    if (current) out.push(current);
  }
  return out;
}

/**
 * Format a single chat entry into terminal-ready lines. The first line is
 * decorated with the role prefix; continuation lines are indented to align.
 */
export function formatChatEntry(entry: ChatEntry, width: number, useColor: boolean): string[] {
  const prefix = roleLabel(entry.role, useColor);
  const indent = ' '.repeat(stripAnsi(prefix).length + 1);
  const wrapped = wrapText(entry.text, Math.max(20, width - indent.length));
  if (wrapped.length === 0) return [prefix];
  return wrapped.map((line, idx) => (idx === 0 ? `${prefix} ${line}` : `${indent}${line}`));
}

function roleLabel(role: ChatRole, useColor: boolean): string {
  switch (role) {
    case 'user': return color(useColor, ANSI_CYAN, 'you');
    case 'assistant': return color(useColor, ANSI_GREEN, 'asst');
    case 'system': return color(useColor, ANSI_DIM, 'sys');
    case 'tool': return color(useColor, ANSI_BLUE, 'tool');
    case 'error': return color(useColor, ANSI_RED, '!err');
    default: return color(useColor, ANSI_DIM, '...');
  }
}

/**
 * Render the active sub-agents bar shown above the input. Returns the
 * empty string when no sub-agents are running so the bar disappears.
 */
export function formatActiveSubagentsBar(active: ActiveSubagentSummary[], useColor: boolean): string {
  if (active.length === 0) return '';
  const pills = active.map((record) => {
    const seconds = Math.max(0, Math.round(record.durationMs / 1000));
    const label = `${record.name} ${seconds}s [${record.id.slice(0, 8)}]`;
    return color(useColor, ANSI_MAGENTA, `\u2022 ${label}`);
  });
  const header = color(useColor, ANSI_DIM, `Active sub-agents (${active.length}):`);
  return `${header} ${pills.join('  ')}`;
}

/**
 * Render the status line drawn at the bottom of the screen. Surfaces
 * connection state and any transient hint set by the client.
 */
export function formatStatusLine(input: { connected: boolean; model: string; hint?: string }, useColor: boolean): string {
  const dot = input.connected ? color(useColor, ANSI_GREEN, '\u25CF') : color(useColor, ANSI_RED, '\u25CB');
  const model = input.model ? color(useColor, ANSI_BOLD, input.model) : color(useColor, ANSI_DIM, 'no model');
  const hint = input.hint ? ` \u2014 ${color(useColor, ANSI_YELLOW, input.hint)}` : '';
  return `${dot} ${model}${hint}`;
}

function color(useColor: boolean, code: string, text: string): string {
  if (!useColor) return text;
  return `${code}${text}${ANSI_RESET}`;
}

/** Strip ANSI escape sequences. Useful for measuring rendered width. */
export function stripAnsi(text: string): string {
  // Minimal CSI stripper — covers the codes used in this module.
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Parse one Server-Sent-Events buffer chunk into JSON event payloads.
 * Returns an array of parsed events plus the unconsumed remainder so the
 * caller can stitch streaming reads together.
 */
export interface SseParseResult {
  events: Array<{ raw: string; payload: unknown }>;
  remainder: string;
}
export function parseSseChunk(buffer: string): SseParseResult {
  const events: Array<{ raw: string; payload: unknown }> = [];
  let remainder = buffer;
  while (true) {
    const newlineIdx = remainder.indexOf('\n');
    if (newlineIdx === -1) break;
    const line = remainder.slice(0, newlineIdx);
    remainder = remainder.slice(newlineIdx + 1);
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed.startsWith('data: ')) continue;
    const payloadText = trimmed.slice(6);
    if (payloadText === '[DONE]') {
      events.push({ raw: trimmed, payload: { type: 'done' } });
      continue;
    }
    try {
      events.push({ raw: trimmed, payload: JSON.parse(payloadText) });
    } catch {
      // skip malformed event
    }
  }
  return { events, remainder };
}
