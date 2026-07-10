import type { ToolResult } from '../types';

/**
 * Tool-output compression.
 *
 * Rule-based, deterministic, no LLM call. Runs at the tool-dispatch
 * boundary (see `dispatcher.ts`) so verbose tool output is shrunk
 * before it ever enters the conversation history. This is distinct
 * from `context/compaction.ts`, which fires late and only when the
 * whole conversation nears the token budget. Compressing here means
 * compaction has to fire far less often.
 *
 * Design constraints:
 * - Idempotent rules: applying twice yields the same result as once.
 * - Never inflates: compressed output is always <= original length.
 * - Structure-safe: JSON-looking payloads pass through untouched
 *   (except the final length clamp), so machine-readable tool output
 *   is never corrupted.
 * - Grapheme-safe: the length clamp splits on code-point boundaries,
 *   never mid-surrogate, preserving emoji / CJK / multi-byte text.
 *
 * On by default in the harness; set `HARNESS_TOOL_COMPRESSION_ENABLED=0`
 * to disable. (The dispatcher option itself defaults off; the caller in
 * `queryLoop.ts` decides.)
 */

export interface CompressionRule {
  name: string;
  /** When set, the rule only applies to tools whose name matches. */
  appliesTo?: (toolName: string) => boolean;
  apply(text: string): string;
}

export interface CompressionConfig {
  /** Hard cap on output length (code points). Default 12000. */
  maxChars?: number;
  /** Override the default rule overlay. */
  rules?: CompressionRule[];
}

export interface CompressionResult {
  output: string;
  originalChars: number;
  compressedChars: number;
  rulesApplied: string[];
}

const DEFAULT_MAX_CHARS = 12_000;

const WEB_TOOLS = new Set(['web_fetch', 'web_read', 'web_search']);

/** Strip HTML tags and collapse to readable text. Web tools only. */
const htmlToText: CompressionRule = {
  name: 'html-to-text',
  appliesTo: (tool) => WEB_TOOLS.has(tool),
  apply(text) {
    if (!/<[a-z!/][\s\S]*?>/i.test(text)) return text;
    return text
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, '\n')
      .replace(/<br\s*\/?>(?=\s*\S)/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
  },
};

/** Collapse runs of blank lines and trailing whitespace. */
const collapseWhitespace: CompressionRule = {
  name: 'collapse-whitespace',
  apply(text) {
    return text
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
  },
};

/** Drop consecutive identical lines (common in logs / grep / listings). */
const dedupeLines: CompressionRule = {
  name: 'dedupe-lines',
  apply(text) {
    const lines = text.split('\n');
    const out: string[] = [];
    let prev: string | undefined;
    let repeat = 0;
    const flush = () => {
      if (repeat > 1 && prev !== undefined) {
        out.push(`${prev}\n... (${repeat - 1} identical line${repeat - 1 === 1 ? '' : 's'} elided)`);
      } else if (prev !== undefined) {
        out.push(prev);
      }
    };
    for (const line of lines) {
      if (line === prev) {
        repeat += 1;
      } else {
        flush();
        prev = line;
        repeat = 1;
      }
    }
    flush();
    return out.join('\n');
  },
};

/** Shorten long query-string URLs to host + truncated path. */
const shortenUrls: CompressionRule = {
  name: 'shorten-urls',
  apply(text) {
    return text.replace(/https?:\/\/[^\s)"']{80,}/g, (url) => {
      try {
        const u = new URL(url);
        const path = u.pathname.length > 40 ? `${u.pathname.slice(0, 40)}…` : u.pathname;
        return `${u.protocol}//${u.host}${path}${u.search ? '?…' : ''}`;
      } catch {
        return url.slice(0, 80) + '…';
      }
    });
  },
};

export const DEFAULT_RULES: CompressionRule[] = [
  htmlToText,
  collapseWhitespace,
  dedupeLines,
  shortenUrls,
];

/** Best-effort check: does this output look like a structured JSON payload? */
function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || !/^[[{]/.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clamp to `maxChars` keeping BOTH head and tail, on code-point
 * boundaries. Unlike a blind slice, the end of a file / log is never
 * lost. Returns the input unchanged if already within budget.
 */
function headTailClamp(text: string, maxChars: number): string {
  const points = Array.from(text);
  if (points.length <= maxChars) return text;
  const marker = (n: number) => `\n... [${n} characters elided] ...\n`;
  // Reserve room for the marker; split remaining budget head/tail.
  const budget = Math.max(0, maxChars - 40);
  const headLen = Math.ceil(budget * 0.6);
  const tailLen = budget - headLen;
  const head = points.slice(0, headLen).join('');
  const tail = points.slice(points.length - tailLen).join('');
  const elided = points.length - headLen - tailLen;
  return head + marker(elided) + tail;
}

/**
 * Compress a single tool output. Pure and synchronous.
 */
export function compressToolOutput(
  toolName: string,
  output: string,
  config: CompressionConfig = {},
): CompressionResult {
  const maxChars = config.maxChars ?? DEFAULT_MAX_CHARS;
  const originalChars = Array.from(output).length;
  const rulesApplied: string[] = [];

  let text = output;

  // Structure guard: skip content-mutating rules for JSON payloads so we
  // never corrupt machine-readable output. The length clamp still applies.
  if (!looksLikeJson(text)) {
    const rules = config.rules ?? DEFAULT_RULES;
    for (const rule of rules) {
      if (rule.appliesTo && !rule.appliesTo(toolName)) continue;
      const next = rule.apply(text);
      if (next !== text) {
        rulesApplied.push(rule.name);
        text = next;
      }
    }
  }

  const clamped = headTailClamp(text, maxChars);
  if (clamped !== text) {
    rulesApplied.push('head-tail-clamp');
    text = clamped;
  }

  const compressedChars = Array.from(text).length;

  // Never inflate: if rules somehow grew the output, return the original.
  if (compressedChars > originalChars) {
    return { output, originalChars, compressedChars: originalChars, rulesApplied: [] };
  }

  return { output: text, originalChars, compressedChars, rulesApplied };
}

/**
 * Apply compression to a `ToolResult`, returning a new result when the
 * output was actually shrunk. Only successful string outputs are
 * touched; failures and empty output pass through unchanged.
 */
export function compressToolResult(
  toolName: string,
  result: ToolResult,
  config?: CompressionConfig,
): { result: ToolResult; saved: number } {
  if (!result.success || !result.output) return { result, saved: 0 };
  const c = compressToolOutput(toolName, result.output, config);
  if (c.compressedChars >= c.originalChars) return { result, saved: 0 };
  return {
    result: { ...result, output: c.output },
    saved: c.originalChars - c.compressedChars,
  };
}
