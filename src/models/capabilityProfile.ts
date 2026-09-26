import * as fs from 'fs/promises';
import * as path from 'path';
import { getWorkspaceDataRoot } from '../tools/pathResolution';

export const CAPABILITY_PROFILE_VERSION = 1;

export type ToolModeRecommendation = 'native' | 'json-in-text' | 'constrained-json';
export type PromptTierRecommendation = 'full' | 'compact' | 'minimal';
export type ScaffoldLevelRecommendation = 'light' | 'medium' | 'heavy';

export interface CapabilityScores {
  toolCalling: number;
  jsonInTextRate: number;
  structuredPlain: number;
  structuredConstrained: number;
  instructionFollowing: number;
  planCoherence: number;
}

export interface CapabilityRecommendations {
  toolMode: ToolModeRecommendation;
  maxToolsPerStep: number;
  promptTier: PromptTierRecommendation;
  scaffoldLevel: ScaffoldLevelRecommendation;
  contextBudgetTokens: number;
}

export interface CapabilityProfile {
  model: string;
  profileVersion: number;
  probedAt: string;
  harnessVersion?: string;
  scores: CapabilityScores;
  usableContextTokens: number;
  detectedContextTokens: number | null;
  avgLatencyMs: number;
  tokensSpent: number;
  recommended: CapabilityRecommendations;
}

export interface FreshnessOptions {
  maxAgeDays?: number;
  profileVersion?: number;
}

/**
 * Recommendation thresholds are intentionally conservative:
 * - native tools require >=0.90 because a single bad tool call can derail an
 *   agent loop.
 * - constrained JSON is preferred when schema-following is >=0.80 but native
 *   tools are weak, because the harness can parse/validate that shape.
 * - compact/minimal prompting requires strong instruction + plan scores; weaker
 *   models get fuller scaffolding instead of assuming unstated context.
 */
export function deriveRecommendations(
  scores: CapabilityScores,
  detectedContextTokens: number | null | undefined,
  usableContextTokens = 0,
): CapabilityRecommendations {
  const toolMode: ToolModeRecommendation = scores.toolCalling >= 0.9
    ? 'native'
    : scores.structuredConstrained >= 0.8
      ? 'constrained-json'
      : 'json-in-text';

  const maxToolsPerStep = toolMode === 'native'
    ? (scores.toolCalling >= 0.98 ? 8 : 5)
    : (scores.structuredConstrained >= 0.8 ? 3 : 2);

  const reasoningScore = Math.min(scores.instructionFollowing, scores.planCoherence);
  const promptTier: PromptTierRecommendation = reasoningScore >= 0.9
    ? 'minimal'
    : reasoningScore >= 0.7
      ? 'compact'
      : 'full';
  const scaffoldLevel: ScaffoldLevelRecommendation = reasoningScore >= 0.85
    ? 'light'
    : reasoningScore >= 0.6
      ? 'medium'
      : 'heavy';

  const usable = usableContextTokens > 0
    ? usableContextTokens
    : Math.max(1024, Math.floor((detectedContextTokens ?? 8192) * 0.5));

  return {
    toolMode,
    maxToolsPerStep,
    promptTier,
    scaffoldLevel,
    contextBudgetTokens: Math.max(1024, Math.floor(usable * 0.85)),
  };
}

export function safeModelProfileName(model: string): string {
  const cleaned = model.trim().replace(/[:/\\]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned || 'unknown-model';
}

export function modelProfilesDir(projectDir = getWorkspaceDataRoot()): string {
  return path.join(projectDir, '.harness', 'model-profiles');
}

export function modelProfilePath(model: string, projectDir = getWorkspaceDataRoot()): string {
  return path.join(modelProfilesDir(projectDir), `${safeModelProfileName(model)}.json`);
}

export async function saveCapabilityProfile(profile: CapabilityProfile, projectDir = getWorkspaceDataRoot()): Promise<void> {
  const filePath = modelProfilePath(profile.model, projectDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(profile, null, 2), 'utf-8');
}

export async function loadCapabilityProfile(model: string, projectDir = getWorkspaceDataRoot()): Promise<CapabilityProfile | null> {
  try {
    const raw = await fs.readFile(modelProfilePath(model, projectDir), 'utf-8');
    return JSON.parse(raw) as CapabilityProfile;
  } catch {
    return null;
  }
}

export async function listCapabilityProfiles(projectDir = getWorkspaceDataRoot()): Promise<CapabilityProfile[]> {
  try {
    const dir = modelProfilesDir(projectDir);
    const entries = await fs.readdir(dir);
    const profiles = await Promise.all(entries
      .filter((entry) => entry.endsWith('.json'))
      .map(async (entry) => {
        try {
          return JSON.parse(await fs.readFile(path.join(dir, entry), 'utf-8')) as CapabilityProfile;
        } catch {
          return null;
        }
      }));
    return profiles.filter((profile): profile is CapabilityProfile => profile !== null)
      .sort((a, b) => a.model.localeCompare(b.model));
  } catch {
    return [];
  }
}

export function isCapabilityProfileFresh(
  profile: CapabilityProfile | null | undefined,
  options: FreshnessOptions = {},
): profile is CapabilityProfile {
  if (!profile) return false;
  if (profile.profileVersion !== (options.profileVersion ?? CAPABILITY_PROFILE_VERSION)) return false;
  const maxAgeDays = options.maxAgeDays ?? 30;
  const probedAt = Date.parse(profile.probedAt);
  if (!Number.isFinite(probedAt)) return false;
  return Date.now() - probedAt <= maxAgeDays * 24 * 60 * 60 * 1000;
}
