import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolResult } from '../types';

/**
 * Large tool-response spooling.
 *
 * Borrowed from goose's `crates/goose/src/agents/large_response_handler.rs`.
 * When a tool returns more than `thresholdChars` characters of text output,
 * the body is written to a temp file and replaced in-place with a pointer
 * message instructing the agent to use file tools to examine or grep the
 * spool. Prevents `cat`/`ls`/`grep` against large repos from blowing the
 * context window in a single turn.
 *
 * Distinct from `tools/outputCompression.ts`, which shrinks text in place
 * via regex rules. Spooling is the right answer when the data is genuinely
 * needed but doesn't belong inline; compression is for shrinking inline
 * noise. Run spool BEFORE compression — once spooled, the inline payload
 * is already tiny.
 */

export const DEFAULT_LARGE_RESPONSE_THRESHOLD = 200_000;

export interface LargeResponseConfig {
  /** Char threshold (Unicode code-point count). */
  thresholdChars?: number;
  /** Override spool directory. Defaults to `<tmp>/harness_tool_responses`. */
  spoolDir?: string;
}

export interface LargeResponseOutcome {
  result: ToolResult;
  spooled: boolean;
  spoolPath?: string;
  originalChars: number;
}

export function maybeSpoolLargeResponse(
  toolName: string,
  result: ToolResult,
  config: LargeResponseConfig = {},
): LargeResponseOutcome {
  if (!result.success || typeof result.output !== 'string') {
    return { result, spooled: false, originalChars: result.output?.length ?? 0 };
  }

  const threshold = config.thresholdChars ?? DEFAULT_LARGE_RESPONSE_THRESHOLD;
  const length = codePointLength(result.output);
  if (length <= threshold) {
    return { result, spooled: false, originalChars: length };
  }

  const spoolDir = config.spoolDir ?? path.join(os.tmpdir(), 'harness_tool_responses');
  try {
    fs.mkdirSync(spoolDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = toolName.replace(/[^a-z0-9_-]/gi, '_');
    const file = path.join(spoolDir, `tool_${safeName}_${ts}_${process.pid}.txt`);
    fs.writeFileSync(file, result.output, 'utf-8');

    const pointer = [
      `The tool '${toolName}' returned a large response (${length} characters)`,
      `which was spooled to disk to keep the context window clean.`,
      ``,
      `File: ${file}`,
      ``,
      `Use file_read, grep, or another file tool to read portions of it as needed.`,
    ].join('\n');

    return {
      result: { success: true, output: pointer },
      spooled: true,
      spoolPath: file,
      originalChars: length,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const warning = `Warning: tool response exceeded ${threshold} chars but could not be spooled to disk (${reason}). Showing full content.\n\n${result.output}`;
    return {
      result: { success: true, output: warning },
      spooled: false,
      originalChars: length,
    };
  }
}

function codePointLength(s: string): number {
  let count = 0;
  for (const _ of s) count += 1;
  return count;
}
