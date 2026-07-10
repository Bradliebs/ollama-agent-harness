/**
 * Skill template variable expansion (Phase 4.1 — skill ergonomics).
 *
 * Skill authors can reference a small, fixed set of harness-provided paths
 * inside SKILL.md using `${NAME}` tokens. Only the allowlisted tokens below are
 * ever substituted; every other `${...}` sequence (shell variables, template
 * literals in code examples, etc.) is left byte-identical. This guarantees that
 * any skill which does not literally contain one of these tokens renders exactly
 * as it did before.
 *
 * No shell execution is performed — this is pure string substitution.
 */

export interface SkillTemplateVars {
  /** Absolute path to the directory containing the invoked skill's SKILL.md. */
  skillDir?: string;
  /** Absolute path to the active project root, when known. */
  projectDir?: string;
}

/**
 * Token name → resolver. Only these tokens are substituted; anything else is
 * returned verbatim. Keep this set small and path-oriented — it is intentionally
 * not a general templating engine.
 */
const TEMPLATE_TOKENS: Record<string, (vars: SkillTemplateVars) => string | undefined> = {
  HARNESS_SKILL_DIR: (vars) => vars.skillDir,
  HARNESS_PROJECT_DIR: (vars) => vars.projectDir,
};

/**
 * Replace allowlisted `${HARNESS_*}` tokens in `content` with their resolved
 * values. Unknown tokens, and known tokens whose value is unavailable, are left
 * untouched so the output is byte-identical for any skill that does not opt in.
 */
export function expandSkillTemplateVars(content: string, vars: SkillTemplateVars): string {
  if (!content || content.indexOf('${') === -1) return content;
  return content.replace(/\$\{([A-Z0-9_]+)\}/g, (match, token: string) => {
    const resolver = TEMPLATE_TOKENS[token];
    if (!resolver) return match; // unknown token → leave untouched
    const value = resolver(vars);
    return value === undefined ? match : value; // no value available → leave untouched
  });
}
