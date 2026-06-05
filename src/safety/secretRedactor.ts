// Secret redactor — deterministic scrubber for credentials in free text.
//
// Runs a fixed set of regexes over a string and replaces any match with a
// `[REDACTED:<kind>]` marker. Pure and synchronous — safe to put on hot
// paths like tool output, trace spans, and log sinks so secrets never reach
// disk or the UI.
//
// Ordering matters: more specific patterns (fine-grained GitHub PAT,
// Anthropic key) must come before their generic counterparts so the broad
// pattern doesn't claim the match first.

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // GitHub fine-grained PAT must come before the generic ghp_ family.
  { name: 'github-fine-grained', pattern: /github_pat_[A-Za-z0-9_]{22}_[A-Za-z0-9_]{59}/g },
  { name: 'github-pat', pattern: /ghp_[A-Za-z0-9_]{36,}/g },
  { name: 'github-oauth', pattern: /ghu_[A-Za-z0-9_]{36,}/g },
  { name: 'github-actions', pattern: /ghs_[A-Za-z0-9_]{36,}/g },
  { name: 'github-refresh', pattern: /ghr_[A-Za-z0-9_]{36,}/g },
  // JWTs: header and payload both decode to `{…` so both start with eyJ.
  { name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: 'aws-access-key', pattern: /(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}/g },
  { name: 'slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  // Anthropic must come before the generic sk- pattern.
  { name: 'anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]{90,}/g },
  { name: 'openai-key', pattern: /sk-[A-Za-z0-9_-]{40,}/g },
  { name: 'google-api-key', pattern: /AIza[A-Za-z0-9_-]{35}/g },
  { name: 'azure-sas-sig', pattern: /(?<=sig=)[A-Za-z0-9%+/]{40,}/g },
  { name: 'npm-token', pattern: /npm_[A-Za-z0-9]{36}/g },
];

export interface RedactionResult {
  /** The input with every matched secret replaced by a marker. */
  result: string;
  /** Total number of secrets replaced. */
  count: number;
}

/**
 * Replace any recognized secret in `text` with a `[REDACTED:<kind>]` marker.
 * Returns the scrubbed string plus a count of how many secrets were removed.
 */
export function redactSecrets(text: string): RedactionResult {
  let result = text;
  let count = 0;

  for (const { name, pattern } of SECRET_PATTERNS) {
    result = result.replace(pattern, () => {
      count++;
      return `[REDACTED:${name}]`;
    });
  }

  return { result, count };
}

/**
 * Convenience wrapper that returns only the scrubbed string. Use when the
 * redaction count is not needed (e.g. inline in a log call).
 */
export function redact(text: string): string {
  return redactSecrets(text).result;
}
