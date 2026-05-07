import { BUILTIN_TOOL_ENTRIES } from '../tools/registry';

export type CapabilityPosture = 'available' | 'gated' | 'design-only' | 'blocked';

export type CapabilityControl =
  | 'explicit-grant'
  | 'time-limit'
  | 'audit-log'
  | 'dry-run'
  | 'sandbox'
  | 'allowlist'
  | 'kill-switch'
  | 'human-confirmation'
  | 'redaction'
  | 'rollback';

export interface CapabilityPolicy {
  id: string;
  label: string;
  category: 'computer' | 'browser' | 'credentials' | 'shell' | 'skills' | 'finance' | 'communications' | 'automation' | 'code' | 'agents';
  posture: CapabilityPosture;
  summary: string;
  readiness: string;
  existingCoverage: string[];
  missingConnectors: string[];
  requiredControls: CapabilityControl[];
}

export interface CapabilityEvaluationInput {
  capabilityId: string;
  requestedControls?: CapabilityControl[];
  explicitGrant?: boolean;
  killSwitchActive?: boolean;
}

export interface CapabilityGrant {
  id: string;
  capabilityId: string;
  controls: CapabilityControl[];
  reason: string;
  grantedAt: string;
  expiresAt: string;
  revokedAt?: string;
  /**
   * Optional per-grant command allowlist. When the grant covers a
   * shell-execution capability (e.g. `arbitrary-shell`), each entry is
   * a regex source (anchored implicitly) that operators have deliberately
   * approved alongside the built-in preset list. Patterns invalid as
   * RegExp are silently dropped at evaluation time so a corrupt entry
   * never opens the gate. Empty array (or omitted) means "rely on the
   * built-in preset list only" — the conservative default.
   */
  commandAllowlist?: string[];
}

export interface CapabilityGrantInput {
  id: string;
  capabilityId: string;
  controls: CapabilityControl[];
  reason?: string;
  expiresInMinutes?: number;
  now?: Date;
  /** See `CapabilityGrant.commandAllowlist`. */
  commandAllowlist?: string[];
}

export interface CapabilityEvaluation {
  capabilityId: string;
  decision: 'allow' | 'ask' | 'deny';
  posture: CapabilityPosture;
  reason: string;
  missingControls: CapabilityControl[];
}

export const CAPABILITY_POLICIES: CapabilityPolicy[] = [
  {
    id: 'desktop-control',
    label: 'Full desktop computer control',
    category: 'computer',
    posture: 'gated',
    summary: 'Desktop screenshot capture and bounded input replay are available through disabled-by-default desktop tools with explicit grants and kill-switch checks.',
    readiness: 'desktop_screenshot and desktop_input_replay tools exist. Input replay previews by default and requires confirm=true plus an active desktop-control grant.',
    existingCoverage: ['desktop_screenshot', 'desktop_input_replay', 'before/after screenshot evidence', 'kill switch', 'permission prompts'],
    missingConnectors: ['screen region selector', 'sensitive region redaction'],
    requiredControls: ['explicit-grant', 'time-limit', 'audit-log', 'kill-switch', 'human-confirmation'],
  },
  {
    id: 'browser-profile-access',
    label: 'Browser profile access',
    category: 'browser',
    posture: 'gated',
    summary: 'Read-only bookmark access is available through browser_bookmarks. Cookie/session access is not implemented.',
    readiness: 'Bookmark reading via browser_bookmarks tool (disabled by default).',
    existingCoverage: ['browser_bookmarks', 'web_fetch', 'web_search', 'web_read'],
    missingConnectors: ['cookie/session vault', 'profile scope picker'],
    requiredControls: ['explicit-grant', 'time-limit', 'audit-log', 'redaction', 'kill-switch'],
  },
  {
    id: 'browser-page-access',
    label: 'Browser page interaction',
    category: 'browser',
    posture: 'gated',
    summary: 'Headless browser interaction via Playwright. Can navigate, click, fill forms, read content, and take screenshots on live websites. High risk — can interact with real services.',
    readiness: 'browser_navigate, browser_click, browser_fill, browser_read, browser_screenshot, browser_close tools (all disabled by default).',
    existingCoverage: ['browser_navigate', 'browser_click', 'browser_fill', 'browser_read', 'browser_screenshot', 'browser_close', 'URL allowlist', 'kill switch', 'permission prompts'],
    missingConnectors: ['domain scope picker'],
    requiredControls: ['explicit-grant', 'time-limit', 'audit-log', 'kill-switch', 'human-confirmation'],
  },
  {
    id: 'password-manager-access',
    label: 'Password manager access',
    category: 'credentials',
    posture: 'blocked',
    summary: 'Credential access is blocked by default and should remain unavailable until a one-shot scoped secret flow exists.',
    readiness: 'No password manager connector exists.',
    existingCoverage: ['kill switch'],
    missingConnectors: ['credential broker', 'secret redaction pipeline', 'one-shot consent UI'],
    requiredControls: ['explicit-grant', 'time-limit', 'audit-log', 'redaction', 'human-confirmation', 'kill-switch'],
  },
  {
    id: 'arbitrary-shell',
    label: 'Arbitrary shell',
    category: 'shell',
    posture: 'gated',
    summary: 'Shell execution exists through the bash tool, but it is high risk and should require policy gates outside dontAsk mode. Granting this capability also enables docker_exec, the sandboxed code runner.',
    readiness: 'Builtin bash tool exists and is marked high risk. Sandboxed docker_exec is bundled as the safer alternative.',
    existingCoverage: ['bash', 'docker_exec', 'permission prompts', 'tool disable toggle', 'kill switch'],
    missingConnectors: ['command allowlist presets', 'dry-run verifier'],
    requiredControls: ['explicit-grant', 'audit-log', 'allowlist', 'kill-switch'],
  },
  {
    id: 'auto-install-third-party-skills',
    label: 'Auto-installing third-party skills',
    category: 'skills',
    posture: 'gated',
    summary: 'Skill install from URL is available through install_skill. Limited to GitHub, Gist, and GitLab hosts with format validation.',
    readiness: 'install_skill tool with host allowlist and provenance tracking (disabled by default).',
    existingCoverage: ['install_skill', 'create_skill', 'list_skills', 'skill automation', 'snapshots'],
    missingConnectors: ['signature verification', 'malware scanning'],
    requiredControls: ['explicit-grant', 'audit-log', 'sandbox', 'allowlist', 'rollback', 'kill-switch'],
  },
  {
    id: 'live-broker-trading',
    label: 'Live broker trading',
    category: 'finance',
    posture: 'blocked',
    summary: 'Live trading is blocked; any future path must start with paper trading and hard risk limits.',
    readiness: 'No broker connector exists in Harness.',
    existingCoverage: ['kill switch'],
    missingConnectors: ['paper trading adapter', 'broker adapter', 'position limits', 'order confirmation UI'],
    requiredControls: ['explicit-grant', 'time-limit', 'audit-log', 'dry-run', 'allowlist', 'human-confirmation', 'kill-switch'],
  },
  {
    id: 'email-sending',
    label: 'Email sending',
    category: 'communications',
    posture: 'gated',
    summary: 'Email, Slack, and Telegram notification tools are available through email_draft, email_send, slack_notify, and telegram_notify with settings-backed delivery.',
    readiness: 'email_draft creates local .eml files; email_send, slack_notify, and telegram_notify are disabled by default and gated by permissions.',
    existingCoverage: ['email_draft', 'email_send', 'slack_notify', 'telegram_notify', 'output validation', 'permission prompts'],
    missingConnectors: ['email provider adapter', 'recipient allowlist', 'Slack channel allowlist'],
    requiredControls: ['explicit-grant', 'audit-log', 'dry-run', 'allowlist', 'human-confirmation', 'kill-switch'],
  },
  {
    id: 'calendar-editing',
    label: 'Calendar editing',
    category: 'communications',
    posture: 'gated',
    summary: 'Calendar reading is available through calendar_read. Read-only access to .ics files. Mutation is not implemented.',
    readiness: 'calendar_read tool parses local .ics files. No calendar mutation.',
    existingCoverage: ['calendar_read', 'permission prompts'],
    missingConnectors: ['calendar provider adapter', 'change preview UI', 'rollback or undo path'],
    requiredControls: ['explicit-grant', 'audit-log', 'dry-run', 'human-confirmation', 'rollback', 'kill-switch'],
  },
  {
    id: 'background-autonomous-jobs',
    label: 'Background autonomous jobs',
    category: 'automation',
    posture: 'gated',
    summary: 'Background jobs exist, but high-risk tool use during jobs must be governed by permission mode and kill switch.',
    readiness: 'Automation jobs and scheduled curator exist.',
    existingCoverage: ['automation jobs', 'curator scheduler', 'kill switch', 'run logs'],
    missingConnectors: ['capability-scoped job grants', 'per-job budget limits'],
    requiredControls: ['explicit-grant', 'time-limit', 'audit-log', 'allowlist', 'kill-switch'],
  },
  {
    id: 'self-modifying-code',
    label: 'Self-modifying code',
    category: 'code',
    posture: 'gated',
    summary: 'Code edits exist through file tools and skills, but self-modification needs snapshots and review before execution.',
    readiness: 'File edit/write tools, snapshots, and tests exist.',
    existingCoverage: ['file_edit', 'file_write', 'snapshots', 'tests', 'typecheck'],
    missingConnectors: ['mandatory pre-change snapshot policy', 'post-change validation gate'],
    requiredControls: ['explicit-grant', 'audit-log', 'dry-run', 'rollback', 'kill-switch'],
  },
  {
    id: 'internet-skill-marketplace',
    label: 'Internet skill marketplace',
    category: 'skills',
    posture: 'blocked',
    summary: 'Remote skill marketplace execution is blocked until trust, provenance, signature, sandbox, and rollback are implemented.',
    readiness: 'No marketplace connector exists.',
    existingCoverage: ['local skills', 'repo skills', 'snapshots'],
    missingConnectors: ['marketplace client', 'signature verification', 'malware scanning', 'sandbox installer'],
    requiredControls: ['explicit-grant', 'audit-log', 'sandbox', 'allowlist', 'rollback', 'kill-switch'],
  },
  {
    id: 'multi-agent-swarm',
    label: 'Multi-agent swarm',
    category: 'agents',
    posture: 'gated',
    summary: 'Subagent isolation exists; swarm execution needs bounded budgets, routing policy, and parent-controlled tool access.',
    readiness: 'Subagent routing and metrics exist, but swarm orchestration is not a separate runtime.',
    existingCoverage: ['subagent isolation', 'routing metrics', 'model routing'],
    missingConnectors: ['swarm budget manager', 'agent role registry', 'fan-out/fan-in guardrails'],
    requiredControls: ['explicit-grant', 'time-limit', 'audit-log', 'allowlist', 'kill-switch'],
  },
];

export function listCapabilityPolicies(): CapabilityPolicy[] {
  return CAPABILITY_POLICIES.map((policy) => ({ ...policy, existingCoverage: [...policy.existingCoverage], missingConnectors: [...policy.missingConnectors], requiredControls: [...policy.requiredControls] }));
}

export function summarizeCapabilityAlignment(policies: CapabilityPolicy[] = CAPABILITY_POLICIES): Record<CapabilityPosture, number> {
  return policies.reduce<Record<CapabilityPosture, number>>((summary, policy) => {
    summary[policy.posture] += 1;
    return summary;
  }, { available: 0, gated: 0, 'design-only': 0, blocked: 0 });
}

export function evaluateCapabilityPolicy(input: CapabilityEvaluationInput, policies: CapabilityPolicy[] = CAPABILITY_POLICIES): CapabilityEvaluation {
  const policy = policies.find((item) => item.id === input.capabilityId);
  if (!policy) {
    return { capabilityId: input.capabilityId, decision: 'deny', posture: 'blocked', reason: 'Unknown capability.', missingControls: [] };
  }
  if (input.killSwitchActive) {
    return { capabilityId: policy.id, decision: 'deny', posture: policy.posture, reason: 'Kill switch active.', missingControls: [] };
  }
  if (policy.posture === 'blocked') {
    return { capabilityId: policy.id, decision: 'deny', posture: policy.posture, reason: 'Capability is blocked by default.', missingControls: policy.requiredControls };
  }
  if (policy.posture === 'design-only') {
    return { capabilityId: policy.id, decision: 'deny', posture: policy.posture, reason: 'Capability is design-only; connector is not implemented.', missingControls: policy.requiredControls };
  }

  const grantedControls = new Set(input.requestedControls ?? []);
  const missingControls = policy.requiredControls.filter((control) => !grantedControls.has(control));
  if (!input.explicitGrant || missingControls.length > 0) {
    return { capabilityId: policy.id, decision: 'ask', posture: policy.posture, reason: 'Capability requires explicit grant and required controls.', missingControls };
  }
  return { capabilityId: policy.id, decision: 'allow', posture: policy.posture, reason: 'Capability grant satisfies policy controls.', missingControls: [] };
}

export function createCapabilityGrant(input: CapabilityGrantInput, policies: CapabilityPolicy[] = CAPABILITY_POLICIES): { grant?: CapabilityGrant; evaluation: CapabilityEvaluation } {
  const now = input.now ?? new Date();
  // Grants that carry a commandAllowlist are operator-curated narrow
  // approvals (e.g. "this exact daily-brief script for the next year").
  // The allowlist regex is itself the bound, so we don't force the
  // 24h ceiling that applies to open-ended shell grants. Anything
  // without an allowlist still maxes out at 24h.
  const hasAllowlist = Array.isArray(input.commandAllowlist) && input.commandAllowlist.some((entry) => typeof entry === 'string' && entry.trim().length > 0);
  const expiresInMinutes = hasAllowlist
    ? clampLongLivedGrantMinutes(input.expiresInMinutes)
    : clampGrantMinutes(input.expiresInMinutes);
  const controls = normalizeControls(input.controls);
  const evaluation = evaluateCapabilityPolicy({
    capabilityId: input.capabilityId,
    explicitGrant: true,
    requestedControls: controls,
  }, policies);
  if (evaluation.decision !== 'allow') return { evaluation };

  return {
    evaluation,
    grant: {
      id: input.id,
      capabilityId: input.capabilityId,
      controls,
      reason: (input.reason ?? '').trim().slice(0, 500) || 'Capability grant approved.',
      grantedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expiresInMinutes * 60_000).toISOString(),
      ...(Array.isArray(input.commandAllowlist) && input.commandAllowlist.length > 0
        ? { commandAllowlist: sanitizeCommandAllowlist(input.commandAllowlist) }
        : {}),
    },
  };
}

export function evaluateCapabilityGrant(capabilityId: string, grants: CapabilityGrant[], options: { now?: Date; killSwitchActive?: boolean } = {}, policies: CapabilityPolicy[] = CAPABILITY_POLICIES): CapabilityEvaluation {
  const activeGrants = listActiveCapabilityGrants(grants, options.now).filter((grant) => grant.capabilityId === capabilityId);
  const controls = normalizeControls(activeGrants.flatMap((grant) => grant.controls));
  return evaluateCapabilityPolicy({
    capabilityId,
    explicitGrant: activeGrants.length > 0,
    requestedControls: controls,
    killSwitchActive: options.killSwitchActive,
  }, policies);
}

export function listActiveCapabilityGrants(grants: CapabilityGrant[], now = new Date()): CapabilityGrant[] {
  return grants.filter((grant) => isCapabilityGrantActive(grant, now));
}

export function isCapabilityGrantActive(grant: CapabilityGrant, now = new Date()): boolean {
  if (grant.revokedAt) return false;
  const expiresAt = Date.parse(grant.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

export function revokeCapabilityGrant(grants: CapabilityGrant[], grantId: string, now = new Date()): CapabilityGrant[] {
  return grants.map((grant) => grant.id === grantId && !grant.revokedAt ? { ...grant, revokedAt: now.toISOString() } : grant);
}

export function findExpiredGrants(grants: CapabilityGrant[], now = new Date()): CapabilityGrant[] {
  return grants.filter((grant) => {
    if (grant.revokedAt) return false;
    const expiresAt = Date.parse(grant.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
  });
}

export function sanitizeCapabilityGrants(value: unknown, policies: CapabilityPolicy[] = CAPABILITY_POLICIES): CapabilityGrant[] {
  if (!Array.isArray(value)) return [];
  const knownCapabilities = new Set(policies.map((policy) => policy.id));
  return value.map((item) => sanitizeCapabilityGrant(item, knownCapabilities)).filter((item): item is CapabilityGrant => item !== null);
}

function sanitizeCapabilityGrant(value: unknown, knownCapabilities: Set<string>): CapabilityGrant | null {
  if (typeof value !== 'object' || value === null) return null;
  const source = value as Record<string, unknown>;
  const id = String(source.id ?? '').trim();
  const capabilityId = String(source.capabilityId ?? '').trim();
  const grantedAt = sanitizeIsoDate(source.grantedAt);
  const expiresAt = sanitizeIsoDate(source.expiresAt);
  const revokedAt = source.revokedAt === undefined ? undefined : sanitizeIsoDate(source.revokedAt);
  if (!id || !knownCapabilities.has(capabilityId) || !grantedAt || !expiresAt) return null;
  const grant: CapabilityGrant = {
    id: id.slice(0, 120),
    capabilityId,
    controls: normalizeControls(Array.isArray(source.controls) ? source.controls : []),
    reason: String(source.reason ?? '').trim().slice(0, 500),
    grantedAt,
    expiresAt,
  };
  if (revokedAt) grant.revokedAt = revokedAt;
  if (Array.isArray(source.commandAllowlist)) {
    const sanitized = sanitizeCommandAllowlist(source.commandAllowlist);
    if (sanitized.length > 0) grant.commandAllowlist = sanitized;
  }
  return grant;
}

/**
 * Validates a list of regex sources for the per-grant command allowlist.
 * Each entry is trimmed, length-capped, and compiled with `new RegExp` —
 * any pattern that fails to compile is silently dropped so a corrupt
 * grant file can never widen the security surface. Duplicates collapse.
 */
function sanitizeCommandAllowlist(value: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 500) continue;
    if (seen.has(trimmed)) continue;
    try {
      // Compile to validate; we discard the RegExp here and recompile at
      // match time so the persisted form is always the source string.
      // eslint-disable-next-line no-new
      new RegExp(trimmed);
    } catch {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Returns true when at least one active grant for `capabilityId` has a
 * commandAllowlist entry that matches `command`. Used by the automation
 * runner to admit operator-approved scripts that fall outside the static
 * preset list.
 */
export function commandMatchesGrantAllowlist(
  capabilityId: string,
  grants: CapabilityGrant[],
  command: string,
  now: Date = new Date(),
): { matched: boolean; grantId?: string; pattern?: string } {
  const normalized = command.trim().replace(/\s+/g, ' ');
  if (!normalized) return { matched: false };
  const active = listActiveCapabilityGrants(grants, now).filter((grant) => grant.capabilityId === capabilityId);
  for (const grant of active) {
    for (const pattern of grant.commandAllowlist ?? []) {
      try {
        if (new RegExp(pattern).test(normalized)) return { matched: true, grantId: grant.id, pattern };
      } catch {
        // Invalid at runtime (corrupted between sanitize and use) — skip.
      }
    }
  }
  return { matched: false };
}

function normalizeControls(controls: unknown[]): CapabilityControl[] {
  const known = new Set<CapabilityControl>(['explicit-grant', 'time-limit', 'audit-log', 'dry-run', 'sandbox', 'allowlist', 'kill-switch', 'human-confirmation', 'redaction', 'rollback']);
  return Array.from(new Set(controls.map((control) => String(control).trim()).filter((control): control is CapabilityControl => known.has(control as CapabilityControl))));
}

function clampGrantMinutes(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 60;
  return Math.min(24 * 60, Math.max(1, Math.floor(parsed)));
}

/**
 * Cap for grants that carry a per-grant commandAllowlist. Such grants
 * are deliberately narrow (an explicit regex) and meant to outlive a
 * single chat session — the obvious example is a daily-brief automation
 * that runs every day at 09:00. Capped at 1 year so a forgotten grant
 * still has a finite expiry, and at minimum 1 minute so accidental zero
 * values cannot silently disable a job at the next tick.
 */
function clampLongLivedGrantMinutes(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 24 * 60; // default: same as ordinary grants
  return Math.min(525_600, Math.max(1, Math.floor(parsed))); // 525600 minutes = ~365 days
}

function sanitizeIsoDate(value: unknown): string | null {
  const text = String(value ?? '').trim();
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function mapToolsToCapabilityCoverage(): Record<string, string[]> {
  const builtinTools = new Set(BUILTIN_TOOL_ENTRIES.map((entry) => entry.tool.name));
  const coverage: Record<string, string[]> = {};
  for (const policy of CAPABILITY_POLICIES) {
    coverage[policy.id] = policy.existingCoverage.filter((item) => builtinTools.has(item));
  }
  return coverage;
}

export function autoGrantGatedCapabilities(existingGrants: CapabilityGrant[], now = new Date()): CapabilityGrant[] {
  const gatedPolicies = CAPABILITY_POLICIES.filter((p) => p.posture === 'gated');
  const activeGrants = listActiveCapabilityGrants(existingGrants, now);
  const grantedCapabilities = new Set(activeGrants.map((g) => g.capabilityId));
  const newGrants: CapabilityGrant[] = [];

  for (const policy of gatedPolicies) {
    if (grantedCapabilities.has(policy.id)) continue;
    const result = createCapabilityGrant({
      id: `auto-${policy.id}-${now.getTime()}`,
      capabilityId: policy.id,
      controls: policy.requiredControls,
      reason: 'Auto-granted in dontAsk mode.',
      expiresInMinutes: 480,
      now,
    });
    if (result.grant) newGrants.push(result.grant);
  }

  return newGrants;
}
