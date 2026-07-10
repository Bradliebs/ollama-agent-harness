// Default rule set for the shell-risk classifier. Three tiers:
//   - 'safe'      : read-only / observational; can auto-approve.
//   - 'write'     : modifies state; existing permission engine prompts.
//   - 'dangerous' : irreversible / hostile patterns; hard-block above
//                   permissions (even if the user has granted broad shell).
//
// Rules are evaluated in order: dangerous → safe → fall through to 'write'.
// A user `.harness/shell-rules.json` override is merged later, with user
// rules tried before defaults so the user always wins on conflict.

import type { RiskTier } from './shellRiskClassifier';

export interface ShellRule {
  id: string;
  /** Matched against a single chained segment of the command. */
  pattern: RegExp;
  tier: RiskTier;
  /** One short phrase explaining the match — surfaced in the block reason. */
  reason: string;
}

// ─── DANGEROUS ────────────────────────────────────────────────────────
// Patterns the harness will not run regardless of permission grants.

export const DEFAULT_DANGEROUS_RULES: ReadonlyArray<ShellRule> = [
  {
    id: 'rm-rf-root',
    pattern: /\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive\s+--force|--force\s+--recursive)\s+(?:--\s+)?(?:\/|\/\*|~\/?\*?|\*)\s*$/i,
    tier: 'dangerous',
    reason: 'recursive force-delete of root, home, or wildcard',
  },
  {
    id: 'rm-rf-system-path',
    pattern: /\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(?:--\s+)?\/(?:bin|boot|etc|lib|lib32|lib64|sbin|usr|var|sys|proc|dev|root|home)(?:\b|\/)/i,
    tier: 'dangerous',
    reason: 'recursive force-delete of a system directory',
  },
  {
    id: 'fork-bomb',
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;\s*:/,
    tier: 'dangerous',
    reason: 'classic fork bomb',
  },
  {
    id: 'pipe-to-shell',
    pattern: /\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|dash|ksh|csh|tcsh)\b/i,
    tier: 'dangerous',
    reason: 'piping a remote download directly into a shell',
  },
  {
    id: 'eval-remote',
    pattern: /\beval\s+["`$(]*\s*(?:curl|wget|fetch)\b/i,
    tier: 'dangerous',
    reason: 'eval over the output of a network fetch',
  },
  {
    id: 'mkfs',
    pattern: /\bmkfs\b/i,
    tier: 'dangerous',
    reason: 'filesystem format',
  },
  {
    id: 'dd-disk-wipe',
    pattern: /\bdd\b[^\n]*\bof=\/dev\/(?:sd[a-z]|nvme\d+n\d+|hd[a-z]|disk\d+|mmcblk\d+)\b/i,
    tier: 'dangerous',
    reason: 'dd writing to a raw disk device',
  },
  {
    id: 'redirect-to-disk-device',
    pattern: />\s*\/dev\/(?:sd[a-z]|nvme\d+n\d+|hd[a-z]|disk\d+|mmcblk\d+)\b/i,
    tier: 'dangerous',
    reason: 'redirecting output to a raw disk device',
  },
  {
    id: 'chmod-recursive-root',
    pattern: /\bchmod\s+(?:-[a-z]*R[a-z]*|--recursive)\s+\d{3,4}\s+(?:--\s+)?(?:\/|\/\*)/i,
    tier: 'dangerous',
    reason: 'recursive chmod across the root filesystem',
  },
  {
    id: 'chown-recursive-root',
    pattern: /\bchown\s+(?:-[a-z]*R[a-z]*|--recursive)\s+\S+\s+(?:--\s+)?(?:\/|\/\*)/i,
    tier: 'dangerous',
    reason: 'recursive chown across the root filesystem',
  },
  {
    id: 'system-shutdown',
    pattern: /^\s*(?:sudo\s+)?(?:shutdown|reboot|halt|poweroff|init\s+0|init\s+6|telinit\s+0|telinit\s+6)\b/i,
    tier: 'dangerous',
    reason: 'system shutdown or reboot',
  },
];

// ─── SAFE ─────────────────────────────────────────────────────────────
// Read-only / observational; auto-approve when no broader grant exists.

export const DEFAULT_SAFE_RULES: ReadonlyArray<ShellRule> = [
  {
    id: 'safe-leaders',
    // Leading binary is read-only AND no shell-modifying tail
    // (already split, so no chaining survives; we only block redirects).
    pattern: /^\s*(?:ls|dir|pwd|whoami|hostname|date|uptime|id|uname|echo|printf|cat|head|tail|less|more|wc|which|where|type|command|env|printenv|stat|file|du|df|tree|ps|top|free|nproc)\b(?![^>]*>)/i,
    tier: 'safe',
    reason: 'read-only command with no redirect',
  },
  {
    id: 'safe-git-readonly',
    pattern: /^\s*git\s+(?:status|log|diff|show|branch|remote(?:\s+-v)?|config\s+(?:--get|-l|--list)|describe|rev-parse|ls-files|ls-tree|reflog|stash\s+list|tag(?:\s+(?:-l|--list))?)\b(?![^>]*>)/i,
    tier: 'safe',
    reason: 'read-only git query',
  },
  {
    id: 'safe-version-flags',
    pattern: /^\s*\S+\s+(?:--version|-V|-v|--help|-h)\s*$/i,
    tier: 'safe',
    reason: 'version or help flag',
  },
  {
    id: 'safe-grep-family',
    // grep / rg / ag / find without -delete / -exec
    pattern: /^\s*(?:grep|rg|ag|ack|fgrep|egrep)\b(?![^>]*>)|^\s*find\b(?![^>]*(?:-delete|-exec|>))/i,
    tier: 'safe',
    reason: 'search command without write side-effects',
  },
  {
    id: 'safe-sed-readonly',
    // sed with -n only (no in-place editing).
    pattern: /^\s*sed\s+-n\b(?![^>]*(?:>|-i\b))/i,
    tier: 'safe',
    reason: 'sed in print-only mode',
  },
];

export const DEFAULT_SHELL_RULES: ReadonlyArray<ShellRule> = [
  ...DEFAULT_DANGEROUS_RULES,
  ...DEFAULT_SAFE_RULES,
];
