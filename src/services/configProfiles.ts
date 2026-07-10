// Config profiles — named presets that partially populate a LoopConfig.
//
// A profile is a named object with overrides for common LoopConfig fields,
// permission mode, and tool filtering. Callers apply a profile on top of
// their base config with `applyProfile()`, which shallow-merges the overrides.
//
// Built-in profiles cover the most common run modes:
//   - code_patch     — edit-focused, verification on, read-before-write enforced
//   - safe_readonly  — no writes, no shell, pure research / Q&A
//   - local_only     — restrict to Ollama models, no cloud fallback
//   - research       — web search + file read, no edits
//   - fast_draft     — short turn budget, no verification, warn-mode gate
//   - full_auto      — high autonomy, auto-continue, large turn budget
//
// Custom profiles can be defined in <projectDir>/.harness/profiles.json.
// Each entry follows the same shape and is merged over a built-in profile
// with the same name (if any), so users can extend built-ins.

import * as fs from 'fs/promises';
import * as path from 'path';
import type { LoopConfig } from '../types/loop';
import type { PermissionMode } from '../types/permission';
import type { ReadBeforeWriteMode } from '../tools/readBeforeWriteGate';

// ─── Types ──────────────────────────────────────────────────────────

export interface ConfigProfile {
  /** Unique profile name, e.g. "code_patch" or "safe_readonly". */
  name: string;
  /** Human-readable description shown in the UI / API. */
  description: string;

  // ── LoopConfig overrides ──────────────────────────────────────────

  /** Override maxTurns. */
  maxTurns?: number;
  /** Override maxTimeMs. */
  maxTimeMs?: number;
  /** Override unproductiveTurnLimit. */
  unproductiveTurnLimit?: number;
  /** Override repeatedToolFailureLimit. */
  repeatedToolFailureLimit?: number;
  /** Override readBeforeWrite. */
  readBeforeWrite?: {
    mode: ReadBeforeWriteMode;
    exemptPaths?: string[];
    allowNewFiles?: boolean;
  };
  /** Override verify. */
  verify?: {
    enabled?: boolean;
    quick?: boolean;
    timeout?: number;
  };
  /** Override autoContinue. */
  autoContinue?: boolean;
  /** Override autoContinueLimit. */
  autoContinueLimit?: number;
  /** Override outputValidation. */
  outputValidation?: {
    enabled?: boolean;
    profile?: string;
  };
  /** Override costTracking. */
  costTracking?: {
    enabled?: boolean;
    budgetUsd?: number;
  };

  // ── Permission / tool layer ────────────────────────────────────────

  /** Override the permission mode for the session. */
  permissionMode?: PermissionMode;
  /**
   * When set, only tools whose name is in this list are available.
   * Everything else is filtered out before being passed to the loop.
   * Use to restrict to read-only or safe tools.
   */
  allowedTools?: string[];
  /**
   * When set, these tool names are removed from the tool pool.
   * Applied after `allowedTools` (if both are set).
   */
  blockedTools?: string[];

  // ── Model routing ─────────────────────────────────────────────────

  /**
   * When set, override the model used for the run.
   * Set to "local" to tell the router to use Ollama only.
   */
  model?: string;
  /**
   * When true, disable cloud fallback even if configured.
   * Forces local-only execution.
   */
  localOnly?: boolean;
}

// ─── Built-in profiles ──────────────────────────────────────────────

const CODE_PATCH: ConfigProfile = {
  name: 'code_patch',
  description: 'Edit-focused mode with verification and read-before-write enforcement.',
  maxTurns: 15,
  readBeforeWrite: { mode: 'enforce', allowNewFiles: true },
  verify: { enabled: true },
  autoContinue: true,
  autoContinueLimit: 5,
  outputValidation: { enabled: true, profile: 'coding-answer' },
  permissionMode: 'acceptEdits',
};

const SAFE_READONLY: ConfigProfile = {
  name: 'safe_readonly',
  description: 'No writes, no shell — pure research and Q&A.',
  maxTurns: 10,
  readBeforeWrite: { mode: 'off' },
  verify: { enabled: false },
  autoContinue: false,
  permissionMode: 'default',
  blockedTools: [
    'file_write', 'file_edit', 'file_move', 'file_delete',
    'bash', 'make_directory', 'remember',
  ],
};

const LOCAL_ONLY: ConfigProfile = {
  name: 'local_only',
  description: 'Restrict to local Ollama models — no cloud API calls.',
  localOnly: true,
};

const RESEARCH: ConfigProfile = {
  name: 'research',
  description: 'Web search + file reading, no file edits.',
  maxTurns: 12,
  readBeforeWrite: { mode: 'off' },
  verify: { enabled: false },
  autoContinue: true,
  autoContinueLimit: 3,
  permissionMode: 'default',
  blockedTools: [
    'file_write', 'file_edit', 'file_move', 'file_delete',
    'make_directory',
  ],
};

const FAST_DRAFT: ConfigProfile = {
  name: 'fast_draft',
  description: 'Quick iteration — short budget, no verification, warn-only gate.',
  maxTurns: 6,
  maxTimeMs: 2 * 60 * 1000,
  readBeforeWrite: { mode: 'warn', allowNewFiles: true },
  verify: { enabled: false },
  autoContinue: true,
  autoContinueLimit: 2,
  permissionMode: 'acceptEdits',
};

const FULL_AUTO: ConfigProfile = {
  name: 'full_auto',
  description: 'High autonomy — large turn budget, auto-continue, verification enabled.',
  maxTurns: 30,
  maxTimeMs: 10 * 60 * 1000,
  readBeforeWrite: { mode: 'enforce', allowNewFiles: true },
  verify: { enabled: true },
  autoContinue: true,
  autoContinueLimit: 10,
  permissionMode: 'dontAsk',
  outputValidation: { enabled: true },
};

export const BUILTIN_PROFILES: ReadonlyArray<ConfigProfile> = [
  CODE_PATCH,
  SAFE_READONLY,
  LOCAL_ONLY,
  RESEARCH,
  FAST_DRAFT,
  FULL_AUTO,
];

// ─── Apply ──────────────────────────────────────────────────────────

/**
 * Apply a profile's overrides onto a base `LoopConfig`.
 * Returns a new config; does not mutate the input.
 *
 * Only fields explicitly set on the profile are applied; `undefined`
 * fields are skipped so the base config's values are preserved.
 */
export function applyProfile(base: LoopConfig, profile: ConfigProfile): LoopConfig {
  const result = { ...base };

  if (profile.maxTurns !== undefined) result.maxTurns = profile.maxTurns;
  if (profile.maxTimeMs !== undefined) result.maxTimeMs = profile.maxTimeMs;
  if (profile.unproductiveTurnLimit !== undefined) result.unproductiveTurnLimit = profile.unproductiveTurnLimit;
  if (profile.repeatedToolFailureLimit !== undefined) result.repeatedToolFailureLimit = profile.repeatedToolFailureLimit;
  if (profile.readBeforeWrite !== undefined) result.readBeforeWrite = profile.readBeforeWrite;
  if (profile.verify !== undefined) result.verify = profile.verify;
  if (profile.autoContinue !== undefined) result.autoContinue = profile.autoContinue;
  if (profile.autoContinueLimit !== undefined) result.autoContinueLimit = profile.autoContinueLimit;
  if (profile.costTracking !== undefined) {
    result.costTracking = { ...result.costTracking, ...profile.costTracking };
  }
  if (profile.outputValidation !== undefined) {
    result.outputValidation = {
      ...result.outputValidation,
      ...profile.outputValidation,
    } as LoopConfig['outputValidation'];
  }

  return result;
}

// ─── Lookup ─────────────────────────────────────────────────────────

/**
 * Get a profile by name. Checks custom profiles first, then built-ins.
 * Returns `undefined` if no profile with that name exists.
 */
export async function getProfile(
  name: string,
  projectDir?: string,
): Promise<ConfigProfile | undefined> {
  if (projectDir) {
    const custom = await loadCustomProfiles(projectDir);
    const found = custom.find((p) => p.name === name);
    if (found) {
      // Merge custom on top of built-in with the same name (if any)
      const builtin = BUILTIN_PROFILES.find((p) => p.name === name);
      return builtin ? mergeProfiles(builtin, found) : found;
    }
  }
  return BUILTIN_PROFILES.find((p) => p.name === name);
}

/**
 * List all available profiles (built-in + custom from project dir).
 * Custom profiles with the same name as a built-in shadow the built-in.
 */
export async function listProfiles(
  projectDir?: string,
): Promise<ConfigProfile[]> {
  const custom = projectDir ? await loadCustomProfiles(projectDir) : [];
  const customNames = new Set(custom.map((p) => p.name));
  const builtins = BUILTIN_PROFILES.filter((p) => !customNames.has(p.name));
  return [...builtins, ...custom];
}

// ─── Persistence ────────────────────────────────────────────────────

const PROFILES_FILENAME = 'profiles.json';

/**
 * Load custom profiles from `<projectDir>/.harness/profiles.json`.
 * Returns [] if the file is absent or corrupt.
 */
export async function loadCustomProfiles(projectDir: string): Promise<ConfigProfile[]> {
  const filePath = path.join(projectDir, '.harness', PROFILES_FILENAME);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const profiles = parsed.filter(isValidProfile);
    // Log warnings for dangerous profiles
    for (const profile of profiles) {
      const warnings = auditCustomProfile(profile);
      for (const warning of warnings) {
        console.warn(`[configProfiles] ⚠️  ${warning}`);
      }
    }
    return profiles;
  } catch {
    return [];
  }
}

/**
 * Save custom profiles to `<projectDir>/.harness/profiles.json`.
 */
export async function saveCustomProfiles(
  projectDir: string,
  profiles: ConfigProfile[],
): Promise<void> {
  const dir = path.join(projectDir, '.harness');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, PROFILES_FILENAME),
    JSON.stringify(profiles, null, 2),
    'utf8',
  );
}

// ─── Filter tools by profile ────────────────────────────────────────

import type { Tool } from '../types/tool';

/**
 * Filter a tool pool according to a profile's `allowedTools` / `blockedTools`.
 * Returns a new array; does not mutate the input.
 */
export function filterToolsByProfile(tools: Tool[], profile: ConfigProfile): Tool[] {
  let filtered = tools;
  if (profile.allowedTools && profile.allowedTools.length > 0) {
    const allowed = new Set(profile.allowedTools);
    filtered = filtered.filter((t) => allowed.has(t.name));
  }
  if (profile.blockedTools && profile.blockedTools.length > 0) {
    const blocked = new Set(profile.blockedTools);
    filtered = filtered.filter((t) => !blocked.has(t.name));
  }
  return filtered;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function mergeProfiles(base: ConfigProfile, override: ConfigProfile): ConfigProfile {
  return {
    ...base,
    ...override,
    // Preserve description from override if provided, otherwise base
    description: override.description || base.description,
  };
}

function isValidProfile(obj: unknown): obj is ConfigProfile {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof (obj as ConfigProfile).name === 'string' &&
    typeof (obj as ConfigProfile).description === 'string'
  );
}

const DANGEROUS_TOOLS = new Set(['bash', 'shell', 'execute', 'run_command', 'file_write', 'file_edit', 'make_directory']);

/**
 * Returns a list of warnings for a custom profile that grants dangerous tools.
 * Built-in profiles are trusted and exempt.
 */
export function auditCustomProfile(profile: ConfigProfile): string[] {
  const warnings: string[] = [];
  if (profile.allowedTools && profile.allowedTools.length > 0) {
    const dangerous = profile.allowedTools.filter((t) => DANGEROUS_TOOLS.has(t));
    if (dangerous.length > 0) {
      warnings.push(`Profile "${profile.name}" explicitly allows dangerous tools: ${dangerous.join(', ')}. Review before use.`);
    }
  }
  if (profile.blockedTools && profile.blockedTools.length > 0) {
    // Warn if blockedTools is empty (unblocks everything) when allowedTools is also unset
    if (profile.blockedTools.length === 0 && !profile.allowedTools) {
      warnings.push(`Profile "${profile.name}" has empty blockedTools — all tools are accessible.`);
    }
  }
  return warnings;
}
