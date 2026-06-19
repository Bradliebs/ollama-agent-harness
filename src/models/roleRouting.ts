// Per-role model resolution. Distinct from src/agents/modelRouting.ts
// (which picks SIZE TIERS for helper agents). This one picks WHICH MODEL
// plays WHICH ROLE in the maker/judge/planner split borrowed from
// loop-engineering.
//
// Resolution order (first hit wins):
//   1. Explicit override passed by the caller
//   2. Environment variable HARNESS_MODEL_<ROLE> (uppercased)
//   3. models.config.json in projectDir, key `roles.<role>`
//   4. Fallback chain (judge → maker, planner → maker, readback → maker)
//   5. undefined (caller falls back to its own default)
//
// This is a pure lookup helper; it does NOT construct any client. Callers
// own model instantiation, so this stays at the boundary and adds zero
// behaviour when no config + no env vars are present.

import * as fs from 'fs';
import * as path from 'path';

export type LoopRole = 'maker' | 'judge' | 'planner' | 'readback';

export const LOOP_ROLES: readonly LoopRole[] = ['maker', 'judge', 'planner', 'readback'];

export interface ModelsConfig {
  /** Map of role → model id (e.g. "llama3.1:8b", "gpt-4o-mini"). */
  roles?: Partial<Record<LoopRole, string>>;
}

export interface ResolveModelByRoleOptions {
  role: LoopRole;
  /** Project directory to look for models.config.json. Defaults to process.cwd(). */
  projectDir?: string;
  /** Caller-supplied override; wins over env + file. */
  override?: string;
  /** Inject env reader for tests. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Inject a config loader for tests; bypasses disk read. */
  configLoader?: (projectDir: string) => ModelsConfig | undefined;
}

export interface ResolveModelByRoleResult {
  /** Final resolved model id, or undefined when no source matched. */
  model?: string;
  /** Which source the value came from, for transparency. */
  source: 'override' | 'env' | 'file' | 'fallback' | 'none';
  /** When source === 'fallback', the role we fell back FROM. */
  fellBackFrom?: LoopRole;
}

const FALLBACK_CHAIN: Record<LoopRole, LoopRole | undefined> = {
  maker: undefined,
  judge: 'maker',
  planner: 'maker',
  readback: 'maker',
};

export function resolveModelByRole(opts: ResolveModelByRoleOptions): ResolveModelByRoleResult {
  const { role, projectDir = process.cwd(), override, env = process.env, configLoader } = opts;

  if (typeof override === 'string' && override.length > 0) {
    return { model: override, source: 'override' };
  }

  const envKey = `HARNESS_MODEL_${role.toUpperCase()}`;
  const envValue = env[envKey];
  if (typeof envValue === 'string' && envValue.length > 0) {
    return { model: envValue, source: 'env' };
  }

  const cfg = configLoader ? configLoader(projectDir) : loadModelsConfig(projectDir);
  const fromFile = cfg?.roles?.[role];
  if (typeof fromFile === 'string' && fromFile.length > 0) {
    return { model: fromFile, source: 'file' };
  }

  const fallbackRole = FALLBACK_CHAIN[role];
  if (fallbackRole && fallbackRole !== role) {
    // Resolve the fallback without recursion-back-to-fallback (only one hop).
    const fallback = resolveModelByRoleNoFallback({ role: fallbackRole, projectDir, env, configLoader });
    if (fallback.model) {
      return { model: fallback.model, source: 'fallback', fellBackFrom: role };
    }
  }

  return { source: 'none' };
}

function resolveModelByRoleNoFallback(opts: {
  role: LoopRole;
  projectDir: string;
  env: NodeJS.ProcessEnv;
  configLoader?: (projectDir: string) => ModelsConfig | undefined;
}): ResolveModelByRoleResult {
  const { role, projectDir, env, configLoader } = opts;
  const envKey = `HARNESS_MODEL_${role.toUpperCase()}`;
  const envValue = env[envKey];
  if (typeof envValue === 'string' && envValue.length > 0) {
    return { model: envValue, source: 'env' };
  }
  const cfg = configLoader ? configLoader(projectDir) : loadModelsConfig(projectDir);
  const fromFile = cfg?.roles?.[role];
  if (typeof fromFile === 'string' && fromFile.length > 0) {
    return { model: fromFile, source: 'file' };
  }
  return { source: 'none' };
}

/**
 * Read and validate models.config.json from the project directory. Returns
 * undefined when missing (the common case). Throws a descriptive error
 * when the file exists but is malformed — silently swallowing config
 * errors hides genuine misconfiguration.
 */
export function loadModelsConfig(projectDir: string): ModelsConfig | undefined {
  const file = path.join(projectDir, 'models.config.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`models.config.json read failed: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`models.config.json is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('models.config.json must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const cfg: ModelsConfig = {};
  if (obj.roles !== undefined) {
    if (typeof obj.roles !== 'object' || obj.roles === null || Array.isArray(obj.roles)) {
      throw new Error('models.config.json: "roles" must be an object');
    }
    const roles = obj.roles as Record<string, unknown>;
    cfg.roles = {};
    for (const [k, v] of Object.entries(roles)) {
      if (!LOOP_ROLES.includes(k as LoopRole)) continue;
      if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`models.config.json: role "${k}" must be a non-empty string`);
      }
      cfg.roles[k as LoopRole] = v;
    }
  }
  return cfg;
}
