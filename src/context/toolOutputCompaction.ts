/**
 * Conservative, signal-preserving compaction for tool output before it is cut
 * to fit a context budget.
 *
 * Adapted from the "RTK" idea in OmniRoute: instead of blindly slicing the
 * head of an oversized tool result (which discards the tail — exactly where
 * build logs, test runs, and stack traces put the failure and summary), first
 * shrink provably-redundant *noise* so more signal survives the budget, and
 * when a hard cut is still required keep the head AND the tail.
 *
 * Every transform here is lossy only in redundancy:
 *   - terminal control codes (ANSI/VT) are pure rendering noise to a model;
 *   - carriage-return progress spam (`a\rb\rc`) only the final segment is real;
 *   - runs of blank lines carry no data.
 *
 * Code, JSON, and URLs are never rewritten — these transforms remove terminal
 * escape sequences and whitespace-only redundancy, then (if still over budget)
 * slice head + tail. No content token is altered.
 */

/** Literal kept verbatim so callers (and tests) can detect a hard cut. */
export const TRUNCATION_MARKER = '...(truncated)';

// ANSI / VT control sequences: ESC [ ... <final>. Colors, cursor moves, etc.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Remove ANSI/VT escape sequences. Safe: these never appear in real data. */
export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * Collapse carriage-return progress spam. A terminal renders `a\rb\rc` as `c`
 * because each `\r` returns to column 0 and overwrites. We keep only the last
 * segment of each `\r` run within a line, matching what a human would see.
 */
export function collapseCarriageReturns(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const segments = line.split('\r');
      return segments[segments.length - 1];
    })
    .join('\n');
}

/** Collapse runs of blank (whitespace-only) lines down to `maxBlank`. */
export function collapseBlankRuns(text: string, maxBlank = 1): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let blankStreak = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      blankStreak += 1;
      if (blankStreak <= maxBlank) out.push(line);
    } else {
      blankStreak = 0;
      out.push(line);
    }
  }
  return out.join('\n');
}

/**
 * Keep the head and tail of `text`, dropping the middle, so failures/summaries
 * at the end of long logs survive. Always shorter than the input and always
 * contains {@link TRUNCATION_MARKER}.
 */
export function headTailTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const markerBase = `\n${TRUNCATION_MARKER}... [`;
  const markerEnd = ' chars omitted]\n';
  const reserve = markerBase.length + markerEnd.length + 9; // 9 = max digits
  const budget = maxChars - reserve;
  if (budget < 16) {
    // Budget too small for a head+tail split; keep a head slice plus marker.
    const headOnly = text.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length));
    return headOnly + TRUNCATION_MARKER;
  }
  const headLen = Math.ceil(budget * 0.65);
  const tailLen = budget - headLen;
  const head = text.slice(0, headLen);
  const tail = tailLen > 0 ? text.slice(text.length - tailLen) : '';
  const removed = text.length - head.length - tail.length;
  return `${head}${markerBase}${removed}${markerEnd}${tail}`;
}

/**
 * Compact tool output to fit within `maxChars`.
 *
 * Returns the original content untouched when it already fits (so small
 * results are never altered). Otherwise removes redundant noise first; if that
 * brings the content within budget the cleaned form is returned in full,
 * preserving every line of signal. Only when noise removal is insufficient is
 * a head+tail cut applied.
 */
export function compactToolOutput(
  content: string,
  maxChars: number,
): { content: string; freedChars: number } {
  if (content.length <= maxChars) return { content, freedChars: 0 };

  const cleaned = collapseBlankRuns(
    collapseCarriageReturns(stripAnsiCodes(content)),
  );

  if (cleaned.length <= maxChars) {
    return { content: cleaned, freedChars: content.length - cleaned.length };
  }

  const truncated = headTailTruncate(cleaned, maxChars);
  return { content: truncated, freedChars: content.length - truncated.length };
}
