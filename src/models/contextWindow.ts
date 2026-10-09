// Context window resolution shared by the web daemon and the CLI.
//
// A configured value is a user-set cap, not a target: 0 (or a known legacy
// default) means "auto", which uses the window the model reports. A
// deliberate value caps the reported window. Without a reported window the
// configured value (or the 8192 default in auto mode) is used.

import * as fs from 'fs/promises';
import * as path from 'path';
import { getModelProfile } from '../services/modelProfiles';
import { isCapabilityProfileFresh, loadCapabilityProfile } from './capabilityProfile';

export const DEFAULT_CONTEXT_MAX_TOKENS = 8192;
/** Largest window auto mode will request, whatever the model reports. */
export const AUTO_CONTEXT_MAX_TOKENS = 200_000;
const LEGACY_CONTEXT_DEFAULTS = new Set<number>([8192, 4096]);

export function isAutoContextMode(configured: number): boolean {
  return !configured || configured <= 0 || LEGACY_CONTEXT_DEFAULTS.has(configured);
}

export function resolveEffectiveContextMaxTokensFromKnown(configured: number, detected: number | null): number {
  if (isAutoContextMode(configured)) {
    return detected && detected > 0 ? Math.min(detected, AUTO_CONTEXT_MAX_TOKENS) : DEFAULT_CONTEXT_MAX_TOKENS;
  }
  return detected && detected > 0 ? Math.min(configured, detected) : configured;
}

/**
 * The context window to request and budget for, by the same rules as the web
 * chat: a per-model cap (.harness/model-profiles.json) or else the global
 * `contextMaxTokens` setting (.harness/settings.json) caps the window the
 * model reports, and a fresh capability profile caps it at what the model
 * can actually use.
 */
export async function resolveContextMaxTokens(projectDir: string, model: string, detected: number | null): Promise<number> {
  const profile = await getModelProfile(projectDir, model).catch(() => undefined);
  let globalCap = DEFAULT_CONTEXT_MAX_TOKENS;
  try {
    const settings = JSON.parse(await fs.readFile(path.join(projectDir, '.harness', 'settings.json'), 'utf-8')) as { contextMaxTokens?: unknown };
    if (typeof settings.contextMaxTokens === 'number' && Number.isFinite(settings.contextMaxTokens)) globalCap = Math.max(0, Math.min(AUTO_CONTEXT_MAX_TOKENS, settings.contextMaxTokens));
  } catch { /* no settings: auto mode */ }
  const configured = typeof profile?.contextMaxTokens === 'number' ? profile.contextMaxTokens : globalCap;
  const effective = resolveEffectiveContextMaxTokensFromKnown(configured, detected);
  const capability = await loadCapabilityProfile(model, projectDir).catch(() => null);
  return capability && isCapabilityProfileFresh(capability) && capability.recommended.contextBudgetTokens > 0
    ? Math.min(effective, capability.recommended.contextBudgetTokens)
    : effective;
}
