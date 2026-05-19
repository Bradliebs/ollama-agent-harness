import * as fs from 'fs/promises';
import * as path from 'path';
import type { SessionEvent } from '../types';
import { SessionStorage } from '../persistence/sessionStorage';
import { atomicWriteFile, withFileLock } from '../persistence/atomicFile';
import { evaluatePromotionGate, loadSafetyRules, type PromotionGateConfig, type PromotionGateResult } from './promotionGate';
import { listEvalTraceRuns } from './evalTrace';
import { recordSwallowed } from '../observability/silentFailureSink';

export interface LearningCandidateOptions {
  minToolSuccessRate?: number;
  minQualityScore?: number;
}

export interface SessionLearningCandidate {
  id: string;
  sessionId: string;
  createdAt: string;
  prompt: string;
  outcome: string;
  toolNames: string[];
  sourceEventIds: string[];
  qualityScore: number;
  accepted: boolean;
  rejectionReasons: string[];
}

export interface PromotedLearningCandidate {
  id: string;
  promotedAt: string;
  memoryPath: string;
}

export type LearningCandidateReviewAction = 'promote' | 'reject';

export interface LearningCandidateReview {
  candidateId: string;
  action: LearningCandidateReviewAction;
  reviewedAt: string;
  reason?: string;
  memoryPath?: string;
}

export interface ReviewedLearningCandidate extends SessionLearningCandidate {
  review?: LearningCandidateReview;
  reviewStatus: 'pending' | LearningCandidateReviewAction;
}

export interface LearningCandidateProvenanceEvent {
  id: string;
  timestamp: string;
  type: SessionEvent['type'];
  kind: SessionEvent['data']['kind'];
  summary: string;
}

export interface LearningCandidateProvenance {
  candidate: ReviewedLearningCandidate;
  events: LearningCandidateProvenanceEvent[];
  missingEventIds: string[];
}

const DEFAULT_MIN_TOOL_SUCCESS_RATE = 0.75;
const DEFAULT_MIN_QUALITY_SCORE = 0.6;

export function extractLearningCandidate(
  sessionId: string,
  events: SessionEvent[],
  options: LearningCandidateOptions = {},
): SessionLearningCandidate {
  const messages = events.filter((event) => event.data.kind === 'message');
  const toolResults = events.filter((event) => event.data.kind === 'tool_result');
  const userMessage = messages.find((event) => event.data.kind === 'message' && event.data.message.role === 'user');
  const assistantMessage = [...messages].reverse().find((event) => event.data.kind === 'message' && event.data.message.role === 'assistant');
  const prompt = userMessage?.data.kind === 'message' ? userMessage.data.message.content ?? '' : '';
  const outcome = assistantMessage?.data.kind === 'message' ? assistantMessage.data.message.content ?? '' : '';
  const toolNames = Array.from(new Set(toolResults.map((event) => event.data.kind === 'tool_result' ? event.data.call.name : ''))).filter(Boolean);
  const successfulTools = toolResults.filter((event) => event.data.kind === 'tool_result' && event.data.result.success).length;
  const toolSuccessRate = toolResults.length > 0 ? successfulTools / toolResults.length : 1;
  const qualityScore = scoreCandidate(prompt, outcome, toolSuccessRate, toolNames.length);
  const rejectionReasons: string[] = [];

  if (prompt.trim().length === 0) rejectionReasons.push('missing user prompt');
  if (outcome.trim().length === 0) rejectionReasons.push('missing assistant outcome');
  if (toolSuccessRate < (options.minToolSuccessRate ?? DEFAULT_MIN_TOOL_SUCCESS_RATE)) {
    rejectionReasons.push('tool success rate below threshold');
  }
  if (qualityScore < (options.minQualityScore ?? DEFAULT_MIN_QUALITY_SCORE)) {
    rejectionReasons.push('quality score below threshold');
  }

  return {
    id: `${sessionId}:${events.at(-1)?.id ?? 'empty'}`,
    sessionId,
    createdAt: new Date().toISOString(),
    prompt: prompt.slice(0, 2000),
    outcome: outcome.slice(0, 2000),
    toolNames,
    sourceEventIds: events.map((event) => event.id),
    qualityScore,
    accepted: rejectionReasons.length === 0,
    rejectionReasons,
  };
}

export async function appendLearningCandidate(
  projectDir: string,
  candidate: SessionLearningCandidate,
): Promise<string> {
  const filePath = path.join(projectDir, '.harness', 'learning', 'session-candidates.jsonl');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(candidate) + '\n', 'utf-8');
  return filePath;
}

export async function listLearningCandidates(
  projectDir: string,
  limit = 100,
): Promise<SessionLearningCandidate[]> {
  const filePath = path.join(projectDir, '.harness', 'learning', 'session-candidates.jsonl');
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return raw.trim().split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionLearningCandidate)
      .slice(-limit);
  } catch (err) {
    recordSwallowed('sessionLearning.listCandidates', err);
    return [];
  }
}

export async function listLearningCandidateReviews(
  projectDir: string,
  limit = 1000,
): Promise<LearningCandidateReview[]> {
  const filePath = candidateReviewsPath(projectDir);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return raw.trim().split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LearningCandidateReview)
      .slice(-limit);
  } catch (err) {
    recordSwallowed('sessionLearning.listCandidateReviews', err);
    return [];
  }
}

export async function listReviewedLearningCandidates(
  projectDir: string,
  limit = 100,
): Promise<ReviewedLearningCandidate[]> {
  const candidates = await listLearningCandidates(projectDir, limit);
  const reviews = await listLearningCandidateReviews(projectDir);
  const latestReview = new Map<string, LearningCandidateReview>();
  for (const review of reviews) {
    latestReview.set(review.candidateId, review);
  }
  return candidates.map((candidate) => {
    const review = latestReview.get(candidate.id);
    return {
      ...candidate,
      review,
      reviewStatus: review?.action ?? 'pending',
    };
  });
}

export async function reviewLearningCandidate(
  projectDir: string,
  candidateId: string,
  action: LearningCandidateReviewAction,
  reason?: string,
): Promise<LearningCandidateReview> {
  const candidate = (await listLearningCandidates(projectDir, 1000)).find((item) => item.id === candidateId);
  if (!candidate) {
    throw new Error(`Learning candidate not found: ${candidateId}`);
  }
  let memoryPath: string | undefined;
  if (action === 'promote') {
    // Optional Claw-Eval-style gate. Off by default so existing flows
    // are unchanged; enabling it requires HARNESS_PROMOTION_GATE_ENABLED.
    if (process.env.HARNESS_PROMOTION_GATE_ENABLED === '1') {
      const gate = await evaluatePromotionGateForCandidate(projectDir, candidateId);
      if (!gate.allowed) {
        throw new Error(`Promotion blocked by gate: ${gate.reason}`);
      }
    }
    const promoted = await promoteLearningCandidate(projectDir, candidate);
    if (!promoted) {
      throw new Error('Only accepted candidates can be promoted');
    }
    memoryPath = promoted.memoryPath;
  }
  const review: LearningCandidateReview = {
    candidateId,
    action,
    reviewedAt: new Date().toISOString(),
    reason,
    memoryPath,
  };
  const filePath = candidateReviewsPath(projectDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(review) + '\n', 'utf-8');
  return review;
}

/**
 * Stand-alone wrapper used by the promotion gate REST endpoint and by
 * `reviewLearningCandidate` above. Looks up the candidate by id, pulls
 * the recent eval-run history, and runs the pure gate evaluator.
 */
export async function evaluatePromotionGateForCandidate(
  projectDir: string,
  candidateId: string,
  config?: PromotionGateConfig,
): Promise<PromotionGateResult & { candidateId: string; candidateFound: boolean }> {
  const candidate = (await listLearningCandidates(projectDir, 1000)).find((item) => item.id === candidateId);
  if (!candidate) {
    return {
      candidateId,
      candidateFound: false,
      allowed: false,
      reason: `Learning candidate not found: ${candidateId}`,
      passCount: 0,
      consideredRuns: 0,
      requiredPasses: config?.requiredPasses ?? 3,
      safetyViolations: [],
      passAtAll: false,
    };
  }
  const recentEvalRuns = await listEvalTraceRuns(projectDir, 50).catch(() => []);
  const safetyRules = await loadSafetyRules(projectDir).catch(() => undefined);
  const verdict = evaluatePromotionGate({
    candidate,
    recentEvalRuns,
    config: { ...config, safetyRules: safetyRules ?? config?.safetyRules },
  });
  return { candidateId, candidateFound: true, ...verdict };
}

export async function getLearningCandidateProvenance(
  projectDir: string,
  candidateId: string,
  eventLimit = 25,
): Promise<LearningCandidateProvenance> {
  const candidate = (await listReviewedLearningCandidates(projectDir, 1000)).find((item) => item.id === candidateId);
  if (!candidate) {
    throw new Error(`Learning candidate not found: ${candidateId}`);
  }
  const storage = new SessionStorage(projectDir, 'unknown', candidate.sessionId);
  const events = await storage.readAll();
  const eventById = new Map(events.map((event) => [event.id, event]));
  const sourceEvents = candidate.sourceEventIds
    .map((id) => eventById.get(id))
    .filter((event): event is SessionEvent => Boolean(event))
    .slice(-eventLimit);
  return {
    candidate,
    events: sourceEvents.map(summarizeSourceEvent),
    missingEventIds: candidate.sourceEventIds.filter((id) => !eventById.has(id)),
  };
}

export async function promoteLearningCandidate(
  projectDir: string,
  candidate: SessionLearningCandidate,
): Promise<PromotedLearningCandidate | null> {
  if (!candidate.accepted) {
    return null;
  }
  const memoryPath = path.join(projectDir, '.harness', 'memory', 'patterns.md');
  await fs.mkdir(path.dirname(memoryPath), { recursive: true });
  await withFileLock(memoryPath, async () => {
    const existing = await fs.readFile(memoryPath, 'utf-8').catch(() => '# Learned Patterns\n');
    const entry = [
      '',
      `## Session Candidate ${candidate.id}`,
      '',
      `* Promoted: ${new Date().toISOString()}`,
      `* Quality: ${Math.round(candidate.qualityScore * 100)}%`,
      `* Tools: ${candidate.toolNames.length ? candidate.toolNames.join(', ') : 'none'}`,
      '',
      '### Prompt',
      '',
      candidate.prompt || '[empty]',
      '',
      '### Outcome',
      '',
      candidate.outcome || '[empty]',
      '',
    ].join('\n');
    await atomicWriteFile(memoryPath, existing.trimEnd() + entry);
  });
  return { id: candidate.id, promotedAt: new Date().toISOString(), memoryPath };
}

function scoreCandidate(prompt: string, outcome: string, toolSuccessRate: number, toolCount: number): number {
  const hasPrompt = prompt.trim().length > 0 ? 0.3 : 0;
  const hasOutcome = outcome.trim().length > 0 ? 0.3 : 0;
  const toolSignal = toolCount > 0 ? 0.15 : 0.05;
  const successSignal = Math.max(0, Math.min(1, toolSuccessRate)) * 0.25;
  return Number((hasPrompt + hasOutcome + toolSignal + successSignal).toFixed(3));
}

function summarizeSourceEvent(event: SessionEvent): LearningCandidateProvenanceEvent {
  return {
    id: event.id,
    timestamp: event.timestamp,
    type: event.type,
    kind: event.data.kind,
    summary: eventSummaryText(event).slice(0, 500),
  };
}

function eventSummaryText(event: SessionEvent): string {
  if (event.data.kind === 'message') {
    return `${event.data.message.role}: ${event.data.message.content ?? ''}`;
  }
  if (event.data.kind === 'tool_call') {
    return `tool call ${event.data.call.name}: ${JSON.stringify(event.data.call.input ?? {})}`;
  }
  if (event.data.kind === 'tool_result') {
    return `tool result ${event.data.call.name}: ${event.data.result.success ? 'success' : 'failure'} ${event.data.result.output ?? ''}`;
  }
  if (event.data.kind === 'compact_boundary') {
    return `compact boundary: ${event.data.summary}`;
  }
  if (event.data.kind === 'continuity_checkpoint') {
    return `continuity checkpoint: ${event.data.checkpoint.currentGoal}`;
  }
  return event.data.content;
}

function candidateReviewsPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'learning', 'session-candidate-reviews.jsonl');
}