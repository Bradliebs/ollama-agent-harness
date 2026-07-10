// Pluggable verification signal panel. Ports the war_loops fidelity-panel idea:
// a weighted blend of small deterministic signals (plus optionally one weighted
// LLM voice) instead of one monolithic verifier. Signals declare an axis;
// per-axis scores are reported separately and the LOWEST axis is the honest
// headline (never average a 28 with an 87 and call it 58).
//
// Scores are 0..100. Signals abstain when they have no input rather than
// faking a number; abstainers drop out of the weighted blend.

export type SignalAxis = 'correctness' | 'safety' | 'cost' | string;

export interface SignalContext {
  response: string;
  toolCallCount: number;
  toolSuccessCount: number;
  errored: boolean;
  refused: boolean;
  highRisk: boolean;
  dryRun: boolean;
  realSignals?: {
    outputValidationStatus?: 'pass' | 'warn' | 'fail';
    outputValidationScore?: number;
    testFailures?: number;
    testPasses?: number;
    lintErrors?: number;
    schemaCheckPass?: boolean;
    toolSuccessRatios?: Record<string, number>;
  };
}

export interface SignalResult {
  /** 0..100. Ignored when `abstain` is true. */
  score: number;
  findings: string[];
  /** True when the signal had no input to score; excluded from the blend. */
  abstain?: boolean;
}

export interface Signal {
  name: string;
  axis: SignalAxis;
  run(ctx: SignalContext): SignalResult;
}

export interface PanelConfig {
  /** Weights per signal name. Unlisted signals default to 1. */
  weights?: Record<string, number>;
  /** Default per-axis pass target (0..100). Default 70. */
  target?: number;
  /** Per-axis target overrides. */
  axisTargets?: Record<string, number>;
}

export interface PerSignalReport {
  score: number;
  weight: number;
  axis: SignalAxis;
  findings: string[];
  abstain: boolean;
}

export interface PerAxisReport {
  score: number;
  weightSum: number;
  signals: string[];
  target: number;
  passed: boolean;
}

export interface PanelResult {
  perSignal: Record<string, PerSignalReport>;
  perAxis: Record<string, PerAxisReport>;
  /** Lowest non-empty axis. The honest headline; null when every axis abstained. */
  lowestAxis: { axis: string; score: number } | null;
  /** Single rolled-up 0..100 across all non-abstaining signals. Informational only. */
  overall: number;
  abstained: string[];
}

const DEFAULT_TARGET = 70;

export function runPanel(signals: Signal[], cfg: PanelConfig, ctx: SignalContext): PanelResult {
  const weights = cfg.weights ?? {};
  const defaultTarget = cfg.target ?? DEFAULT_TARGET;
  const axisTargets = cfg.axisTargets ?? {};

  const perSignal: Record<string, PerSignalReport> = {};
  const perAxisAccum: Record<string, { weighted: number; weightSum: number; signals: string[] }> = {};
  const abstained: string[] = [];
  let totalWeighted = 0;
  let totalWeight = 0;

  for (const signal of signals) {
    const weight = weights[signal.name] ?? 1;
    let result: SignalResult;
    try {
      result = signal.run(ctx);
    } catch (err) {
      // A throwing signal abstains rather than tanking the panel.
      result = { score: 0, findings: [`Signal threw: ${err instanceof Error ? err.message : String(err)}`], abstain: true };
    }
    const abstain = result.abstain === true;
    perSignal[signal.name] = {
      score: clamp(result.score),
      weight,
      axis: signal.axis,
      findings: result.findings ?? [],
      abstain,
    };
    if (abstain) {
      abstained.push(signal.name);
      continue;
    }
    const bucket = (perAxisAccum[signal.axis] ??= { weighted: 0, weightSum: 0, signals: [] });
    bucket.weighted += clamp(result.score) * weight;
    bucket.weightSum += weight;
    bucket.signals.push(signal.name);
    totalWeighted += clamp(result.score) * weight;
    totalWeight += weight;
  }

  const perAxis: Record<string, PerAxisReport> = {};
  let lowestAxis: { axis: string; score: number } | null = null;
  for (const [axis, acc] of Object.entries(perAxisAccum)) {
    const score = acc.weightSum > 0 ? acc.weighted / acc.weightSum : 0;
    const target = axisTargets[axis] ?? defaultTarget;
    perAxis[axis] = {
      score,
      weightSum: acc.weightSum,
      signals: acc.signals,
      target,
      passed: score >= target,
    };
    if (lowestAxis === null || score < lowestAxis.score) {
      lowestAxis = { axis, score };
    }
  }

  const overall = totalWeight > 0 ? totalWeighted / totalWeight : 0;
  return { perSignal, perAxis, lowestAxis, overall, abstained };
}

function clamp(value: number, min = 0, max = 100): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(min, Math.min(max, value));
}
