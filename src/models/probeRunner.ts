import type { IChatClient } from '../core/chatClient';
import {
  CAPABILITY_PROFILE_VERSION,
  deriveRecommendations,
  isCapabilityProfileFresh,
  loadCapabilityProfile,
  saveCapabilityProfile,
  type CapabilityProfile,
  type CapabilityScores,
} from './capabilityProfile';
import { DEFAULT_PROBES, type Probe, type ProbeResult } from './probes';

export interface ProbeBudget {
  samples?: number;
  tokenBudgetPerProbe?: number;
  maxContextTokens?: number;
}

export interface RunProbeSuiteOptions {
  model: string;
  projectDir: string;
  detectedContextTokens?: number | null;
  budget?: ProbeBudget;
  signal?: AbortSignal;
  probes?: Probe[];
  onProgress?: (event: { probeId: string; status: 'start' | 'complete'; result?: ProbeResult }) => void;
}

export interface EnsureProfileOptions extends RunProbeSuiteOptions {
  maxAgeDays?: number;
}

export async function runProbeSuite(client: IChatClient, options: RunProbeSuiteOptions): Promise<CapabilityProfile> {
  const detectedContextTokens = options.detectedContextTokens
    ?? await client.getContextWindow().catch(() => null);
  const results: ProbeResult[] = [];
  for (const probe of options.probes ?? DEFAULT_PROBES) {
    options.signal?.throwIfAborted();
    options.onProgress?.({ probeId: probe.id, status: 'start' });
    const result = await probe.run(client, {
      signal: options.signal,
      samples: options.budget?.samples,
      tokenBudget: options.budget?.tokenBudgetPerProbe ?? probe.defaultTokenBudget,
      maxContextTokens: options.budget?.maxContextTokens,
      detectedContextTokens,
    });
    results.push(result);
    options.onProgress?.({ probeId: probe.id, status: 'complete', result });
  }

  const byId = new Map(results.map((result) => [result.id, result]));
  const structured = byId.get('structuredOutput');
  const usable = byId.get('usableContext');
  const scores: CapabilityScores = {
    toolCalling: byId.get('toolCalling')?.score ?? 0,
    jsonInTextRate: numberDetail(byId.get('toolCalling'), 'jsonInTextRate'),
    structuredPlain: numberDetail(structured, 'structuredPlain'),
    structuredConstrained: numberDetail(structured, 'structuredConstrained'),
    instructionFollowing: byId.get('instructionFollowing')?.score ?? 0,
    planCoherence: byId.get('planCoherence')?.score ?? 0,
  };
  const usableContextTokens = Math.floor(numberDetail(usable, 'usableContextTokens'));
  const tokensSpent = results.reduce((sum, result) => sum + result.tokens.totalTokens, 0);
  const avgLatencyMs = results.length > 0
    ? Math.round(results.reduce((sum, result) => sum + result.durationMs, 0) / results.length)
    : 0;

  const profile: CapabilityProfile = {
    model: options.model,
    profileVersion: CAPABILITY_PROFILE_VERSION,
    probedAt: new Date().toISOString(),
    harnessVersion: process.env.npm_package_version,
    scores,
    usableContextTokens,
    detectedContextTokens: detectedContextTokens ?? null,
    avgLatencyMs,
    tokensSpent,
    recommended: deriveRecommendations(scores, detectedContextTokens, usableContextTokens),
  };
  await saveCapabilityProfile(profile, options.projectDir);
  return profile;
}

export async function ensureProfile(client: IChatClient, options: EnsureProfileOptions): Promise<CapabilityProfile> {
  const cached = await loadCapabilityProfile(options.model, options.projectDir);
  if (isCapabilityProfileFresh(cached, { maxAgeDays: options.maxAgeDays, profileVersion: CAPABILITY_PROFILE_VERSION })) {
    return cached;
  }
  return runProbeSuite(client, options);
}

function numberDetail(result: ProbeResult | undefined, key: string): number {
  const value = result?.details[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
