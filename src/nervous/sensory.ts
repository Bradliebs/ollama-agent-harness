// Nervous System — Sensory layer.
//
// Watches user input, tool outputs, verifier results, and system state.
// Converts observations into structured signals.

import { createSignal, type NervousSignal, type SignalSeverity } from './signals';

// ─── User query inspection ──────────────────────────────────────────

const CORRECTION_PATTERNS = /\b(wrong|no[,.]?\s|not that|you misunderstood|that('s| is) not|seriously|are you sure|incorrect|mistake|redo|undo|revert)\b/i;
const CONFUSION_PATTERNS = /\b(confused|don'?t understand|what do you mean|huh\??|unclear|lost me)\b/i;
const ESCALATION_PATTERNS = /\b(urgent|asap|emergency|critical|immediately|right now|time[- ]sensitive)\b/i;
const CONFIRMATION_PATTERNS = /\b(yes|go ahead|do it|confirmed?|proceed|approved?|ok|sure)\b/i;

const IRREVERSIBLE_ACTIONS = /\b(delete|remove|wipe|reset|overwrite|destroy|drop|truncate|send|submit|deploy|publish|transfer|execute|buy|sell|place order)\b/i;
const PRIVACY_TERMS = /\b(password|secret|credential|token|private key|api[- ]?key|ssn|social security|bank account|credit card)\b/i;
const HIGH_RISK_DOMAINS = /\b(production|live system|real money|patient|diagnosis|medication|lawsuit|contract|legal advice)\b/i;

export function inspectUserQuery(query: string, taskType?: string): NervousSignal[] {
  const signals: NervousSignal[] = [];
  const lower = query.toLowerCase();

  // User intent
  signals.push(createSignal('USER_INTENT', 'sensory.user', 'info', `User request: ${query.slice(0, 120)}`, { taskType }));

  // Correction detection
  if (CORRECTION_PATTERNS.test(lower)) {
    signals.push(createSignal('USER_CORRECTION', 'sensory.user', 'high', 'User rejected or corrected previous output.', { query: query.slice(0, 200) }));
  }

  // Confusion detection
  if (CONFUSION_PATTERNS.test(lower)) {
    signals.push(createSignal('USER_CONFUSION', 'sensory.user', 'medium', 'User appears confused or unclear about previous response.'));
  }

  // Escalation detection
  if (ESCALATION_PATTERNS.test(lower)) {
    signals.push(createSignal('USER_ESCALATION', 'sensory.user', 'high', 'User indicated urgency.'));
  }

  // Confirmation detection
  if (CONFIRMATION_PATTERNS.test(lower) && lower.length < 40) {
    signals.push(createSignal('USER_CONFIRMATION', 'sensory.user', 'info', 'User confirmed or approved.'));
  }

  // Irreversible action detection
  if (IRREVERSIBLE_ACTIONS.test(lower)) {
    signals.push(createSignal('IRREVERSIBLE_ACTION', 'sensory.user', 'critical', 'Request may involve irreversible actions.', { matched: lower.match(IRREVERSIBLE_ACTIONS)?.[0] }));
    signals.push(createSignal('DRY_RUN_REQUIRED', 'sensory.user', 'high', 'Dry-run recommended for irreversible action.'));
    signals.push(createSignal('CONFIRMATION_REQUIRED', 'sensory.user', 'high', 'Confirmation recommended before irreversible action.'));
  }

  // Privacy risk
  if (PRIVACY_TERMS.test(lower)) {
    signals.push(createSignal('PRIVACY_RISK', 'sensory.user', 'high', 'Query may involve sensitive/private data.', { matched: lower.match(PRIVACY_TERMS)?.[0] }));
  }

  // High-risk domain
  if (HIGH_RISK_DOMAINS.test(lower)) {
    signals.push(createSignal('TASK_RISK', 'sensory.user', 'high', 'Query touches a high-risk domain.', { matched: lower.match(HIGH_RISK_DOMAINS)?.[0] }));
  }

  return signals;
}

// ─── Tool result inspection ─────────────────────────────────────────

export function inspectToolResult(toolName: string, success: boolean, output: string, callCount: number): NervousSignal[] {
  const signals: NervousSignal[] = [];

  if (success) {
    signals.push(createSignal('TOOL_SUCCESS', 'sensory.tool', 'info', `Tool ${toolName} succeeded.`, { toolName }));
  } else {
    const severity: SignalSeverity = callCount > 2 ? 'high' : 'medium';
    signals.push(createSignal('TOOL_ERROR', 'sensory.tool', severity, `Tool ${toolName} failed.`, { toolName, output: output.slice(0, 300) }));
    if (callCount > 2) {
      signals.push(createSignal('REPEATED_FAILURE', 'sensory.tool', 'high', `Tool ${toolName} has failed ${callCount} times.`, { toolName, callCount }));
    }
  }

  // Privacy in output
  if (PRIVACY_TERMS.test(output)) {
    signals.push(createSignal('PRIVACY_RISK', 'sensory.tool', 'high', `Tool output may contain sensitive data.`, { toolName }));
  }

  return signals;
}

// ─── Verifier result inspection ─────────────────────────────────────

export function inspectVerifierResult(status: string, score: number, notes?: string[]): NervousSignal[] {
  const signals: NervousSignal[] = [];

  if (status === 'pass' || score >= 0.8) {
    signals.push(createSignal('VERIFIER_PASS', 'sensory.verifier', 'info', `Verifier passed (score ${score}).`, { score }));
  } else if (status === 'fail' || score < 0.5) {
    signals.push(createSignal('VERIFIER_FAIL', 'sensory.verifier', 'high', `Verifier failed (score ${score}).`, { score, notes }));
    signals.push(createSignal('RECOVERY_REQUIRED', 'sensory.verifier', 'medium', 'Recovery may be needed after verifier failure.'));
  } else {
    signals.push(createSignal('LOW_CONFIDENCE', 'sensory.verifier', 'medium', `Verifier marginal (score ${score}).`, { score }));
  }

  return signals;
}

// ─── Loop / stall detection ─────────────────────────────────────────

export function inspectLoopBehavior(toolCallSequence: string[], maxRepeats = 3): NervousSignal[] {
  const signals: NervousSignal[] = [];

  if (toolCallSequence.length < 2) return signals;

  // Detect repeated identical tool calls
  const last = toolCallSequence[toolCallSequence.length - 1];
  let repeatCount = 0;
  for (let i = toolCallSequence.length - 1; i >= 0; i--) {
    if (toolCallSequence[i] === last) repeatCount++;
    else break;
  }

  if (repeatCount >= maxRepeats) {
    signals.push(createSignal('AGENT_LOOP', 'sensory.loop', 'high', `Tool ${last} called ${repeatCount} times in a row.`, { toolName: last, repeatCount }));
    signals.push(createSignal('RECOVERY_REQUIRED', 'sensory.loop', 'medium', 'Agent may be stuck in a loop.'));
  }

  // Detect excessive total tool calls
  if (toolCallSequence.length > 30) {
    signals.push(createSignal('COST_SPIKE', 'sensory.loop', 'medium', `${toolCallSequence.length} tool calls in this run.`, { count: toolCallSequence.length }));
  }

  return signals;
}

// ─── Context pressure inspection ────────────────────────────────────

export function inspectContextPressure(tokenCount: number, maxTokens: number): NervousSignal[] {
  const signals: NervousSignal[] = [];
  const ratio = tokenCount / Math.max(1, maxTokens);

  if (ratio > 0.9) {
    signals.push(createSignal('CONTEXT_OVERLOAD', 'sensory.context', 'critical', `Context at ${Math.round(ratio * 100)}% capacity.`, { tokenCount, maxTokens }));
    signals.push(createSignal('COMPRESSION_REQUIRED', 'sensory.context', 'high', 'Context compression needed.'));
  } else if (ratio > 0.75) {
    signals.push(createSignal('TOKEN_PRESSURE', 'sensory.context', 'medium', `Context at ${Math.round(ratio * 100)}% capacity.`, { tokenCount, maxTokens }));
  }

  return signals;
}
