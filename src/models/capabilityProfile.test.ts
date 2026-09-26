import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  CAPABILITY_PROFILE_VERSION,
  deriveRecommendations,
  isCapabilityProfileFresh,
  listCapabilityProfiles,
  loadCapabilityProfile,
  safeModelProfileName,
  saveCapabilityProfile,
  type CapabilityProfile,
} from './capabilityProfile';

describe('capability profiles', () => {
  it('derives conservative tool recommendations from thresholds', () => {
    expect(deriveRecommendations({
      toolCalling: 0.95,
      jsonInTextRate: 0,
      structuredPlain: 0.5,
      structuredConstrained: 0.5,
      instructionFollowing: 0.92,
      planCoherence: 0.91,
    }, 16000, 12000)).toEqual(expect.objectContaining({
      toolMode: 'native',
      promptTier: 'minimal',
      scaffoldLevel: 'light',
      contextBudgetTokens: 10200,
    }));

    expect(deriveRecommendations({
      toolCalling: 0.2,
      jsonInTextRate: 0.1,
      structuredPlain: 0.4,
      structuredConstrained: 0.85,
      instructionFollowing: 0.5,
      planCoherence: 0.4,
    }, 8000, 4000)).toEqual(expect.objectContaining({
      toolMode: 'constrained-json',
      promptTier: 'full',
      scaffoldLevel: 'heavy',
    }));
  });

  it('only caps the context budget when the usable context is a measured limit', () => {
    const scores = { toolCalling: 1, jsonInTextRate: 0, structuredPlain: 1, structuredConstrained: 1, instructionFollowing: 1, planCoherence: 1 };
    // Retrieval failed beyond 16k: a real limit.
    expect(deriveRecommendations(scores, 200_000, 16_000, true).contextBudgetTokens).toBe(13_600);
    // Passed everything up to the probe's 16k cap: a lower bound, so the detected window stands.
    expect(deriveRecommendations(scores, 200_000, 16_000, false).contextBudgetTokens).toBe(170_000);
    expect(deriveRecommendations(scores, null, 16_000, false).contextBudgetTokens).toBe(13_600);
  });

  it('stores, loads, lists, and checks freshness', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-profile-'));
    try {
      const profile: CapabilityProfile = {
        model: 'llama:3/test',
        profileVersion: CAPABILITY_PROFILE_VERSION,
        probedAt: new Date().toISOString(),
        scores: {
          toolCalling: 1,
          jsonInTextRate: 0,
          structuredPlain: 1,
          structuredConstrained: 1,
          instructionFollowing: 1,
          planCoherence: 1,
        },
        usableContextTokens: 4096,
        detectedContextTokens: 8192,
        avgLatencyMs: 10,
        tokensSpent: 20,
        recommended: deriveRecommendations({
          toolCalling: 1,
          jsonInTextRate: 0,
          structuredPlain: 1,
          structuredConstrained: 1,
          instructionFollowing: 1,
          planCoherence: 1,
        }, 8192, 4096),
      };
      await saveCapabilityProfile(profile, dir);
      expect(safeModelProfileName(profile.model)).toBe('llama_3_test');
      await expect(loadCapabilityProfile(profile.model, dir)).resolves.toEqual(profile);
      await expect(listCapabilityProfiles(dir)).resolves.toEqual([profile]);
      expect(isCapabilityProfileFresh(profile, { maxAgeDays: 1 })).toBe(true);
      expect(isCapabilityProfileFresh({ ...profile, profileVersion: -1 }, { maxAgeDays: 1 })).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
