export type HelperTaskType =
  | 'explore'
  | 'summarize'
  | 'test-triage'
  | 'memory-extract'
  | 'edit'
  | 'plan'
  | 'review'
  | 'general';

export type ModelTier = 'small' | 'default' | 'strong' | 'fallback';
export type TaskRisk = 'low' | 'medium' | 'high';
export type ChatRoutingMode = 'off' | 'costSaver' | 'balanced' | 'quality';
export type ChatTaskType = 'chat' | 'coding' | 'research' | 'review' | 'automation' | 'general';

export interface ModelRoutingPolicy {
  smallModel?: string;
  defaultModel?: string;
  strongModel?: string;
  fallbackModel?: string;
  promptLengthEscalationThreshold?: number;
  failureEscalationThreshold?: number;
  confidenceEscalationThreshold?: number;
  /** When true, a low-readiness turn queues a stronger model for the next
   * turn in the same session (requires a client-supplied sessionId). Default
   * off: the readiness gate stays advisory-only. */
  autoEscalateOnLowReadiness?: boolean;
  /** Runtime chat router mode. Default: balanced. off = preserve selected model. */
  chatRoutingMode?: ChatRoutingMode;
}

export interface ModelRoutingInput {
  taskType: HelperTaskType;
  prompt?: string;
  requestedRisk?: TaskRisk;
  requiresWrite?: boolean;
  previousFailures?: number;
  confidence?: number;
}

export interface ModelRoutingDecision {
  tier: ModelTier;
  model?: string;
  escalated: boolean;
  reasons: string[];
}

export interface ChatModelCandidatePool {
  small?: string;
  default?: string;
  strong?: string;
  fallback?: string;
  localAgentic?: string[];
}

export interface ChatModelRoutingInput {
  requestedModel: string;
  message: string;
  candidates?: ChatModelCandidatePool;
  requestedModelWeak?: boolean;
  previousFailures?: number;
  confidence?: number;
}

export interface ChatModelRoutingDecision {
  model: string;
  routed: boolean;
  tier: ModelTier;
  taskType: ChatTaskType;
  risk: TaskRisk;
  from?: string;
  reason?: string;
  reasons: string[];
}

export interface HelperAgentPreset {
  type: HelperTaskType;
  name: string;
  systemPrompt: string;
  maxTurns: number;
  defaultRisk: TaskRisk;
  allowWrites: boolean;
}

export interface RoutingMetricInput {
  tier?: string;
  model?: string;
  escalated?: boolean;
  reasons?: string[];
  success: boolean;
  durationMs?: number;
}

export interface RoutingMetricBucket {
  count: number;
  success: number;
  failure: number;
  successRate: number;
}

export interface RoutingMetricsSummary {
  total: number;
  success: number;
  failure: number;
  successRate: number;
  escalationRate: number;
  byTier: Record<string, RoutingMetricBucket>;
  byModel: Record<string, RoutingMetricBucket>;
  topReasons: Array<{ reason: string; count: number }>;
}

export interface ModelRoutingCalibration {
  summary: RoutingMetricsSummary;
  suggestedPolicy: Partial<ModelRoutingPolicy>;
  recommendations: string[];
}

export interface RegistryModelRoutingEntry {
  id?: string;
  model_name: string;
  role: string;
  enabled: boolean;
}

const DEFAULT_PROMPT_LENGTH_ESCALATION_THRESHOLD = 6000;
const DEFAULT_FAILURE_ESCALATION_THRESHOLD = 2;
const DEFAULT_CONFIDENCE_ESCALATION_THRESHOLD = 0.45;

export const HELPER_AGENT_PRESETS: Record<HelperTaskType, HelperAgentPreset> = {
  explore: {
    type: 'explore',
    name: 'explore',
    systemPrompt: 'You are a read-only exploration helper. Inspect the available context and return a concise summary with file paths, relevant symbols, and open questions.',
    maxTurns: 6,
    defaultRisk: 'low',
    allowWrites: false,
  },
  summarize: {
    type: 'summarize',
    name: 'summarize',
    systemPrompt: 'You compress noisy context into a short, faithful summary. Preserve decisions, errors, file paths, and next actions. Do not add new facts.',
    maxTurns: 4,
    defaultRisk: 'low',
    allowWrites: false,
  },
  'test-triage': {
    type: 'test-triage',
    name: 'explore',
    systemPrompt: 'You analyze failing test output. Return likely root causes, implicated files, and the smallest next validation command.',
    maxTurns: 5,
    defaultRisk: 'medium',
    allowWrites: false,
  },
  'memory-extract': {
    type: 'memory-extract',
    name: 'explore',
    systemPrompt: 'You extract durable lessons from a session. Return only concise candidate memories with evidence and confidence.',
    maxTurns: 4,
    defaultRisk: 'low',
    allowWrites: false,
  },
  edit: {
    type: 'edit',
    name: 'general',
    systemPrompt: 'You make a narrow code edit that directly satisfies the task. Keep changes minimal and report files changed plus validation status.',
    maxTurns: 8,
    defaultRisk: 'medium',
    allowWrites: true,
  },
  plan: {
    type: 'plan',
    name: 'plan',
    systemPrompt: 'You create a short implementation plan grounded in the provided repository context. Return phases, dependencies, risks, and validation commands.',
    maxTurns: 5,
    defaultRisk: 'medium',
    allowWrites: true,
  },
  review: {
    type: 'review',
    name: 'explore',
    systemPrompt: 'You review completed work for bugs, missing tests, and request fulfillment. Lead with findings ordered by severity.',
    maxTurns: 6,
    defaultRisk: 'high',
    allowWrites: false,
  },
  general: {
    type: 'general',
    name: 'general',
    systemPrompt: 'You are a bounded helper agent. Complete the requested task and return a concise summary of findings and actions.',
    maxTurns: 8,
    defaultRisk: 'medium',
    allowWrites: true,
  },
};

export function selectModelForTask(
  input: ModelRoutingInput,
  policy: ModelRoutingPolicy = {},
): ModelRoutingDecision {
  const preset = HELPER_AGENT_PRESETS[input.taskType];
  const reasons: string[] = [];
  const risk = input.requestedRisk ?? preset.defaultRisk;
  const promptLength = input.prompt?.length ?? 0;
  const previousFailures = input.previousFailures ?? 0;
  const confidence = input.confidence ?? 1;
  const requiresWrite = input.requiresWrite ?? preset.allowWrites;

  const promptThreshold = policy.promptLengthEscalationThreshold ?? DEFAULT_PROMPT_LENGTH_ESCALATION_THRESHOLD;
  const failureThreshold = policy.failureEscalationThreshold ?? DEFAULT_FAILURE_ESCALATION_THRESHOLD;
  const confidenceThreshold = policy.confidenceEscalationThreshold ?? DEFAULT_CONFIDENCE_ESCALATION_THRESHOLD;

  if (risk === 'high') reasons.push('high-risk task');
  if (requiresWrite && risk !== 'low') reasons.push('state-modifying task');
  if (promptLength > promptThreshold) reasons.push('large prompt context');
  if (previousFailures >= failureThreshold) reasons.push('previous helper failures');
  if (confidence < confidenceThreshold) reasons.push('low helper confidence');

  if (reasons.length > 0) {
    return {
      tier: policy.strongModel ? 'strong' : 'default',
      model: policy.strongModel ?? policy.defaultModel,
      escalated: true,
      reasons,
    };
  }

  if (!requiresWrite && risk === 'low') {
    return {
      tier: policy.smallModel ? 'small' : 'default',
      model: policy.smallModel ?? policy.defaultModel,
      escalated: false,
      reasons: ['bounded low-risk helper task'],
    };
  }

  return {
    tier: 'default',
    model: policy.defaultModel ?? policy.fallbackModel,
    escalated: false,
    reasons: ['default model for medium-risk helper task'],
  };
}

export function getHelperAgentPreset(type: HelperTaskType): HelperAgentPreset {
  return HELPER_AGENT_PRESETS[type];
}

export function createHelperAgentConfig(
  input: ModelRoutingInput,
  policy: ModelRoutingPolicy = {},
): {
  name: string;
  systemPrompt: string;
  model?: string;
  maxTurns: number;
  routing: ModelRoutingDecision;
} {
  const preset = getHelperAgentPreset(input.taskType);
  const routing = selectModelForTask(input, policy);
  return {
    name: preset.name,
    systemPrompt: preset.systemPrompt,
    model: routing.model,
    maxTurns: preset.maxTurns,
    routing,
  };
}

export function selectModelForChatTurn(
  input: ChatModelRoutingInput,
  policy: ModelRoutingPolicy = {},
): ChatModelRoutingDecision {
  const requestedModel = input.requestedModel.trim();
  const mode = policy.chatRoutingMode ?? 'balanced';
  const classification = classifyChatTurn(input.message);
  if (mode === 'off') {
    return {
      model: requestedModel,
      routed: false,
      tier: 'default',
      taskType: classification.taskType,
      risk: classification.risk,
      reasons: ['chat routing disabled'],
    };
  }

  const reasons = [...classification.reasons];
  const promptThreshold = policy.promptLengthEscalationThreshold ?? DEFAULT_PROMPT_LENGTH_ESCALATION_THRESHOLD;
  const failureThreshold = policy.failureEscalationThreshold ?? DEFAULT_FAILURE_ESCALATION_THRESHOLD;
  const confidenceThreshold = policy.confidenceEscalationThreshold ?? DEFAULT_CONFIDENCE_ESCALATION_THRESHOLD;
  const largePrompt = input.message.length > promptThreshold;
  if (largePrompt) reasons.push('large prompt context');
  if ((input.previousFailures ?? 0) >= failureThreshold) reasons.push('previous turn failures');
  if ((input.confidence ?? 1) < confidenceThreshold) reasons.push('low confidence signal');
  if (input.requestedModelWeak && classification.requiresTools) reasons.push('selected model weak for tool/current-information turn');

  if (mode === 'balanced' && classification.taskType === 'chat' && !classification.requiresTools && !largePrompt && !input.requestedModelWeak) {
    return {
      model: requestedModel,
      routed: false,
      tier: 'default',
      taskType: classification.taskType,
      risk: classification.risk,
      reasons: ['simple chat turn'],
    };
  }

  const tier = chooseChatTier(classification, mode, largePrompt, input.requestedModelWeak === true);
  const model = chooseCandidateForTier(tier, requestedModel, input.candidates ?? {});
  const routed = Boolean(model && model !== requestedModel);
  const chosen = model || requestedModel;
  return {
    model: chosen,
    routed,
    tier: model ? tier : 'default',
    taskType: classification.taskType,
    risk: classification.risk,
    from: routed ? requestedModel : undefined,
    reason: routed ? routingReason(requestedModel, chosen, tier, reasons, mode) : undefined,
    reasons: reasons.length > 0 ? reasons : ['simple chat turn'],
  };
}

export function createModelRoutingPolicyFromRegistry(models: RegistryModelRoutingEntry[]): ModelRoutingPolicy {
  const enabled = models.filter((model) => model.enabled);
  return {
    smallModel: firstModelName(enabled, ['local.general', 'local.summariser']),
    defaultModel: firstModelName(enabled, ['local.coder', 'local.general']),
    strongModel: firstModelName(enabled, ['cloud.reasoner', 'cloud.reviewer']),
    fallbackModel: firstModelName(enabled, ['local.general', 'local.coder', 'local.summariser']),
  };
}

function classifyChatTurn(message: string): { taskType: ChatTaskType; risk: TaskRisk; requiresTools: boolean; requiresWrite: boolean; reasons: string[] } {
  const text = message.toLowerCase();
  const reasons: string[] = [];
  const requiresWrite = /\b(write|edit|modify|patch|fix|implement|create file|delete|move|rename|commit|push|apply|refactor|install|run command|execute|deploy)\b/.test(text);
  const currentInfo = /\b(news|today|latest|current|recent|weather|price|prices|score|scores|search|web|browse|look up|fetch)\b/.test(text);
  const fileOrRepo = /\b(read file|write file|edit file|repo|repository|codebase|workspace|tests?|typecheck|build|lint|terminal|shell|command)\b/.test(text);
  const requiresTools = requiresWrite || currentInfo || fileOrRepo;
  let taskType: ChatTaskType = 'chat';
  if (/\b(review|audit|security review|what is wrong|ship|readiness)\b/.test(text)) taskType = 'review';
  else if (/\b(code|bug|fix|implement|refactor|typescript|javascript|python|rust|test|typecheck|build|lint|repo|codebase)\b/.test(text)) taskType = 'coding';
  else if (/\b(research|compare|investigate|find sources|market|news|latest|current|web|browse|look up)\b/.test(text)) taskType = 'research';
  else if (/\b(automate|schedule|background|cron|watcher|agent loop|autonomy|autonomous)\b/.test(text)) taskType = 'automation';
  else if (requiresTools) taskType = 'general';

  let risk: TaskRisk = 'low';
  if (requiresWrite || taskType === 'automation') risk = 'high';
  else if (requiresTools || taskType === 'coding' || taskType === 'review' || taskType === 'research') risk = 'medium';

  if (taskType !== 'chat') reasons.push(`${taskType} task`);
  if (requiresTools) reasons.push('tool-capable turn');
  if (requiresWrite) reasons.push('state-modifying turn');
  if (currentInfo) reasons.push('current-information request');
  return { taskType, risk, requiresTools, requiresWrite, reasons };
}

function chooseChatTier(
  classification: { taskType: ChatTaskType; risk: TaskRisk; requiresTools: boolean; requiresWrite: boolean },
  mode: ChatRoutingMode,
  largePrompt: boolean,
  requestedModelWeak: boolean,
): ModelTier {
  if (mode === 'quality') {
    return classification.taskType === 'chat' && !classification.requiresTools && !largePrompt ? 'default' : 'strong';
  }
  if (mode === 'costSaver') {
    if (classification.risk === 'high' || largePrompt || (requestedModelWeak && classification.requiresTools)) return 'strong';
    if (classification.requiresTools || classification.taskType !== 'chat') return 'default';
    return 'small';
  }
  if (classification.risk === 'high' || classification.taskType === 'review' || largePrompt || (requestedModelWeak && classification.requiresTools)) return 'strong';
  if (classification.requiresTools || classification.taskType === 'coding' || classification.taskType === 'research') return 'default';
  return 'small';
}

function chooseCandidateForTier(tier: ModelTier, requestedModel: string, candidates: ChatModelCandidatePool): string | undefined {
  const ordered = tier === 'strong'
    ? [candidates.strong, candidates.default, requestedModel, candidates.fallback, ...(candidates.localAgentic ?? [])]
    : tier === 'default'
      ? [candidates.default, requestedModel, candidates.strong, candidates.fallback, ...(candidates.localAgentic ?? [])]
      : [candidates.small, requestedModel, candidates.default, candidates.fallback, ...(candidates.localAgentic ?? [])];
  return firstDistinctModel(ordered, requestedModel);
}

function firstDistinctModel(candidates: Array<string | undefined>, requestedModel: string): string | undefined {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const model = (candidate ?? '').trim();
    if (!model) continue;
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (key === requestedModel.toLowerCase()) continue;
    return model;
  }
  return undefined;
}

function routingReason(from: string, to: string, tier: ModelTier, reasons: string[], mode: ChatRoutingMode): string {
  const why = reasons.length > 0 ? reasons.join('; ') : 'routing policy matched';
  return `${from} routed to ${to} (${tier}, ${mode}) because ${why}.`;
}

export function summarizeRoutingMetrics(metrics: RoutingMetricInput[]): RoutingMetricsSummary {
  const summary: RoutingMetricsSummary = {
    total: metrics.length,
    success: metrics.filter((metric) => metric.success).length,
    failure: metrics.filter((metric) => !metric.success).length,
    successRate: rate(metrics.filter((metric) => metric.success).length, metrics.length),
    escalationRate: rate(metrics.filter((metric) => metric.escalated).length, metrics.length),
    byTier: {},
    byModel: {},
    topReasons: [],
  };
  const reasonCounts = new Map<string, number>();
  for (const metric of metrics) {
    addBucket(summary.byTier, metric.tier ?? 'unknown', metric.success);
    addBucket(summary.byModel, metric.model ?? 'unknown', metric.success);
    for (const reason of metric.reasons ?? []) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }
  summary.topReasons = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 5);
  return summary;
}

export function calibrateModelRoutingPolicy(
  metrics: RoutingMetricInput[],
  currentPolicy: ModelRoutingPolicy = {},
): ModelRoutingCalibration {
  const summary = summarizeRoutingMetrics(metrics);
  const suggestedPolicy: Partial<ModelRoutingPolicy> = {};
  const recommendations: string[] = [];
  const small = summary.byTier.small;
  const nonEscalatedFailures = metrics.filter((metric) => !metric.escalated && !metric.success).length;

  if (small && small.count >= 3 && small.successRate < 0.7) {
    suggestedPolicy.confidenceEscalationThreshold = Math.max(currentPolicy.confidenceEscalationThreshold ?? DEFAULT_CONFIDENCE_ESCALATION_THRESHOLD, 0.6);
    recommendations.push('Small helper success is below 70%; raise the confidence escalation threshold before using the small tier.');
  }

  if (nonEscalatedFailures >= 2) {
    suggestedPolicy.failureEscalationThreshold = 1;
    recommendations.push('Repeated non-escalated failures were observed; escalate after the first helper failure.');
  }

  if (summary.escalationRate > 0.8 && summary.successRate > 0.8) {
    suggestedPolicy.promptLengthEscalationThreshold = Math.max(currentPolicy.promptLengthEscalationThreshold ?? DEFAULT_PROMPT_LENGTH_ESCALATION_THRESHOLD, 9000);
    recommendations.push('Most helper work escalates successfully; raise the prompt-length threshold to give smaller helpers more bounded opportunities.');
  }

  if (recommendations.length === 0) {
    recommendations.push('No threshold changes suggested from the available routing metrics.');
  }

  return { summary, suggestedPolicy, recommendations };
}

function addBucket(target: Record<string, RoutingMetricBucket>, key: string, success: boolean): void {
  const bucket = target[key] ?? { count: 0, success: 0, failure: 0, successRate: 0 };
  bucket.count++;
  if (success) bucket.success++;
  else bucket.failure++;
  bucket.successRate = rate(bucket.success, bucket.count);
  target[key] = bucket;
}

function rate(value: number, total: number): number {
  return total > 0 ? Number((value / total).toFixed(3)) : 0;
}

function firstModelName(models: RegistryModelRoutingEntry[], roles: string[]): string | undefined {
  for (const role of roles) {
    const model = models.find((candidate) => candidate.role === role);
    if (model) return model.model_name;
  }
  return undefined;
}