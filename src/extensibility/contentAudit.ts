// Static content audit for untrusted text that crosses a trust boundary.
//
// Two flows feed attacker-influenced text into privileged places:
//   1. MCP server definitions — the command/args/env eventually run a real
//      process under the `arbitrary-shell` grant.
//   2. Skill instructions — SKILL.md content is injected into the model
//      prompt and steers the agent.
//
// Both are vulnerable to "Trojan Source" style tricks: bidirectional control
// characters that reorder how text renders versus how it executes, and
// invisible / zero-width characters that hide payloads from a human reviewer.
// None of these characters have a legitimate place in a shell command or in
// skill instructions, so we can flag them with effectively zero false
// positives. This module is pure (no I/O) so it is trivially testable.

export type AuditSeverity = 'critical' | 'high' | 'medium';

export interface ContentAuditFinding {
  severity: AuditSeverity;
  code: 'bidi-control' | 'invisible-char' | 'control-char';
  /** Which field the suspicious text was found in. */
  field: string;
  /** Human-readable explanation. */
  message: string;
  /** Deduped, capped list of offending codepoints as `U+XXXX`. */
  codepoints: string;
}

interface Category {
  code: ContentAuditFinding['code'];
  severity: AuditSeverity;
  label: string;
  /** Global + unicode flagged regex matching the suspect codepoints. */
  regex: RegExp;
}

// Order matters only for readability; ranges are mutually exclusive.
const CATEGORIES: Category[] = [
  {
    code: 'bidi-control',
    severity: 'critical',
    label: 'bidirectional control character(s) (Trojan Source risk)',
    // LRM/RLM/ALM, embeddings/overrides (LRE..RLO), and isolates (LRI..PDI).
    regex: /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu,
  },
  {
    code: 'invisible-char',
    severity: 'high',
    label: 'invisible / zero-width character(s)',
    // Soft hyphen, Mongolian vowel separator, zero-width space/joiners,
    // word joiner + invisible math operators, BOM, and Hangul fillers.
    regex: /[\u00AD\u180E\u200B-\u200D\u2060-\u2064\uFEFF\u115F\u1160\u3164\uFFA0]/gu,
  },
  {
    code: 'control-char',
    severity: 'medium',
    label: 'control character(s)',
    // C0 controls except tab (\u0009), LF (\u000A), CR (\u000D); DEL + C1.
    regex: /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu,
  },
];

function toCodepoint(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  return 'U+' + code.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Scan a single string field for suspicious Unicode. A single leading BOM is
 * ignored because it is legitimate at the start of a UTF-8 file.
 */
export function auditText(value: unknown, field: string): ContentAuditFinding[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  const text = value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
  const findings: ContentAuditFinding[] = [];
  for (const category of CATEGORIES) {
    const matches = text.match(category.regex);
    if (!matches || matches.length === 0) continue;
    const unique = [...new Set(matches.map(toCodepoint))].slice(0, 8);
    findings.push({
      severity: category.severity,
      code: category.code,
      field,
      message: `Found ${matches.length} ${category.label} in ${field}.`,
      codepoints: unique.join(', '),
    });
  }
  return findings;
}

export interface AuditableMcpFields {
  id?: string;
  catalogName?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Audit every attacker-influenced field of an MCP server definition. */
export function auditMcpServerDefinition(def: AuditableMcpFields): ContentAuditFinding[] {
  const findings: ContentAuditFinding[] = [];
  findings.push(...auditText(def.id, 'id'));
  findings.push(...auditText(def.catalogName, 'catalogName'));
  findings.push(...auditText(def.command, 'command'));
  (def.args ?? []).forEach((arg, index) => findings.push(...auditText(arg, `args[${index}]`)));
  for (const [key, val] of Object.entries(def.env ?? {})) {
    findings.push(...auditText(key, `env key "${key}"`));
    findings.push(...auditText(val, `env "${key}"`));
  }
  return findings;
}

/** Audit the full text of a skill file (frontmatter + body). */
export function auditSkillContent(name: string, content: string): ContentAuditFinding[] {
  return auditText(content, `skill "${name}"`);
}

/** One-line summary suitable for an error message or log entry. */
export function formatAuditFindings(findings: ContentAuditFinding[]): string {
  return findings.map((f) => `[${f.severity}] ${f.message} (${f.codepoints})`).join(' ');
}
