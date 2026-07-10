// Identity auto-update tick — wires the proposal layer into a callable
// heartbeat function. Default config disables both targets, so simply
// importing this module never causes identity to change.
//
// Wiring into a real scheduler (e.g. the curator heartbeat) is left to
// callers. This keeps the loop testable in isolation and prevents
// surprise auto-firing.

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  applyUserProposal,
  proposeSoulUpdate,
  proposeUserUpdate,
  type IdentityProposal,
  type SoulProposalRecord,
} from './identityProposals';

export interface IdentityAutoUpdateConfig {
  version: 1;
  /** When true, USER.md proposals are auto-applied (with snapshot). */
  user: boolean;
  /** When true, SOUL.md proposals are written to SOUL.proposed.md. */
  soul: boolean;
}

const DEFAULT_CONFIG: IdentityAutoUpdateConfig = {
  version: 1,
  user: false,
  soul: false,
};

function configPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'identity', 'auto-update.json');
}

/**
 * Reads the auto-update config. Missing file, parse error, or unknown
 * version all collapse to the safe default (everything off).
 */
export async function readIdentityAutoUpdateConfig(projectDir: string): Promise<IdentityAutoUpdateConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath(projectDir), 'utf-8');
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<IdentityAutoUpdateConfig>;
    if (parsed && parsed.version === 1) {
      return {
        version: 1,
        user: Boolean(parsed.user),
        soul: Boolean(parsed.soul),
      };
    }
  } catch {
    // fall through to default
  }
  return { ...DEFAULT_CONFIG };
}

export async function writeIdentityAutoUpdateConfig(
  projectDir: string,
  config: IdentityAutoUpdateConfig,
): Promise<void> {
  const fp = configPath(projectDir);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(config, null, 2), 'utf-8');
}

export interface IdentityAutoUpdateDeps {
  callModel(prompt: string): Promise<string>;
  /** Returns the observation text the proposer should reason about. */
  getObservations(): Promise<string>;
}

export interface IdentityAutoUpdateResult {
  user: {
    status: 'disabled' | 'no-change' | 'applied' | 'error';
    snapshotId?: string;
    proposal?: IdentityProposal;
    error?: string;
  };
  soul: {
    status: 'disabled' | 'no-change' | 'proposed' | 'error';
    proposal?: SoulProposalRecord;
    error?: string;
  };
}

/**
 * One pass of the identity auto-update loop. Honors the on-disk
 * config: if a target is disabled, no model call is made for it. USER
 * proposals are auto-applied (with snapshot); SOUL proposals are
 * suggest-only.
 *
 * Designed to be safe to call from any heartbeat — failures are
 * isolated per target and surfaced in the result rather than thrown.
 */
export async function runIdentityAutoUpdateTick(
  projectDir: string,
  deps: IdentityAutoUpdateDeps,
  now: Date = new Date(),
): Promise<IdentityAutoUpdateResult> {
  const config = await readIdentityAutoUpdateConfig(projectDir);
  const result: IdentityAutoUpdateResult = {
    user: { status: 'disabled' },
    soul: { status: 'disabled' },
  };
  if (!config.user && !config.soul) return result;
  let observations = '';
  try {
    observations = await deps.getObservations();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (config.user) result.user = { status: 'error', error: message };
    if (config.soul) result.soul = { status: 'error', error: message };
    return result;
  }
  if (config.user) {
    try {
      const proposal = await proposeUserUpdate(projectDir, observations, deps.callModel);
      if (!proposal) {
        result.user = { status: 'no-change' };
      } else {
        const applied = await applyUserProposal(projectDir, proposal, now);
        result.user = { status: 'applied', snapshotId: applied.snapshotId, proposal };
      }
    } catch (error) {
      result.user = { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (config.soul) {
    try {
      const proposal = await proposeSoulUpdate(projectDir, observations, deps.callModel, now);
      if (!proposal) {
        result.soul = { status: 'no-change' };
      } else {
        result.soul = { status: 'proposed', proposal };
      }
    } catch (error) {
      result.soul = { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  }
  return result;
}
