// ─── Inbound tool-argument validation ───────────────────────────────
//
// A deliberately conservative guard that runs at the dispatch boundary,
// before a tool executes, to catch the single most common malformed-call
// failure mode: the model omits a parameter the tool's schema declares
// `required`. Catching this here turns an opaque downstream crash (or a
// silently-wrong run on an undefined argument) into a correctable error
// the agent loop can retry.
//
// Scope is intentionally narrow to keep false-positives near zero:
//   - Only the declared `required` list is enforced.
//   - No type-checking. LLMs routinely pass `"3"` where a number is
//     declared and tools coerce; enforcing types here would reject calls
//     the tool would have accepted.
//   - Extra/unknown keys are allowed. Models add them; tools ignore them.
//
// A tool whose declared schema is stricter than its runtime tolerance
// will surface here — that is a schema bug worth fixing, not a reason to
// loosen this check.

import type { Tool } from '../types/tool';

export interface ToolInputValidation {
  valid: boolean;
  /** Human-readable reasons, one per missing required parameter. */
  errors: string[];
}

/**
 * Validate a tool call's input against the tool's declared parameter schema.
 * Returns `{ valid: true, errors: [] }` when there is nothing enforceable to
 * check (no object schema, or no `required` list), so unschema'd tools are
 * never blocked.
 */
export function validateToolInput(tool: Tool, input: Record<string, unknown>): ToolInputValidation {
  const schema = tool.parameters as { type?: unknown; properties?: unknown; required?: unknown } | undefined;
  if (!schema || schema.type !== 'object' || typeof schema.properties !== 'object' || schema.properties === null) {
    return { valid: true, errors: [] };
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  const errors: string[] = [];
  for (const key of required) {
    if (typeof key !== 'string') continue;
    if (!(key in input) || input[key] === undefined) {
      errors.push(`Missing required parameter '${key}'.`);
    }
  }

  return { valid: errors.length === 0, errors };
}
