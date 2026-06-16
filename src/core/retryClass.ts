import { HarnessError, PermissionDeniedError } from './errors';
import { resolveLoopHardeningEnabled } from './iterationBudget';

/**
 * Coarse retry classification for an error returned by a tool call, an LLM
 * call, or an internal subsystem. Callers decide policy from the class; the
 * class itself is purely descriptive.
 *
 * - `transient`           network blip / DNS hiccup / EAI_AGAIN / 5xx — retry with backoff.
 * - `rateLimited`         429 / explicit "rate limit" / quota — retry, honour Retry-After.
 * - `auth`                401 / 403 / invalid key — do NOT retry; surface immediately.
 * - `policyDenied`        permission or safety inspector denied — do NOT retry.
 * - `permanent`           4xx other than auth/rate-limit / ENOENT / EACCES / bad input — do NOT retry.
 * - `unknown`             could not classify — caller defaults conservatively (no retry).
 * - `contextOverflow`     413 / "context too long" / "maximum context" — retry only after compression.
 * - `formatError`         malformed JSON / tool-format mismatch — retry once with reformat.
 * - `thinkingSignature`   stale reasoning/thinking signature — retry after stripping signature.
 * - `contentPolicyBlocked` provider safety filter rejected the prompt — do NOT retry.
 * - `providerOverloaded`  529 / "overloaded"/"server busy" — retry after backoff or fallback model.
 */
export type RetryClass =
  | 'transient'
  | 'rateLimited'
  | 'auth'
  | 'policyDenied'
  | 'permanent'
  | 'unknown'
  | 'contextOverflow'
  | 'formatError'
  | 'thinkingSignature'
  | 'contentPolicyBlocked'
  | 'providerOverloaded';

export interface ClassifiedError {
  /** The retry class. */
  class: RetryClass;
  /** One-line human reason, suitable for telemetry/UI. */
  reason: string;
  /**
   * When the upstream supplied a Retry-After value (delta-seconds or HTTP
   * date), the absolute delay before the next attempt. Only set when the
   * class is `rateLimited` or `transient` with a server-supplied hint.
   */
  retryAfterMs?: number;
  /**
   * Recovery hints for callers participating in the loop-hardening retry
   * branches. Each hint suggests a one-shot recovery action; the caller
   * is responsible for gating the action via {@link TurnRetryState}. All
   * hints are optional — older callers ignore them and fall through to
   * the existing retry/abort decision.
   */
  shouldCompress?: boolean;
  shouldRotateCredential?: boolean;
  shouldFallbackModel?: boolean;
  shouldStripThinkingSignature?: boolean;
  shouldShrinkImages?: boolean;
}

const TRANSIENT_NODE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EBUSY',
  'EAGAIN',
]);

const PERMANENT_NODE_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EISDIR',
  'ENOTDIR',
  'EEXIST',
  'EINVAL',
  'ENAMETOOLONG',
]);

interface ErrorShape {
  message: string;
  code?: string;
  status?: number;
  headers?: Record<string, string | string[] | undefined>;
}

function readErrorShape(err: unknown): ErrorShape {
  if (!err || typeof err !== 'object') {
    return { message: typeof err === 'string' ? err : String(err) };
  }
  const e = err as Record<string, unknown>;
  const message = typeof e.message === 'string' ? e.message : String(err);
  const code = typeof e.code === 'string' ? e.code : undefined;
  const status =
    typeof e.status === 'number'
      ? e.status
      : typeof e.statusCode === 'number'
        ? (e.statusCode as number)
        : undefined;
  const headersRaw = e.headers;
  const headers =
    headersRaw && typeof headersRaw === 'object'
      ? (headersRaw as Record<string, string | string[] | undefined>)
      : undefined;
  return { message, code, status, headers };
}

function extractStatusFromMessage(message: string): number | undefined {
  // Matches "HTTP 429", "status 503", "(401)" produced by various clients.
  const m = message.match(/\b(?:HTTP\s+)?(\d{3})\b/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (n >= 100 && n <= 599) return n;
  return undefined;
}

function parseRetryAfter(headers: Record<string, string | string[] | undefined> | undefined): number | undefined {
  if (!headers) return undefined;
  // Header name lookup is case-insensitive in practice; check both forms.
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

function classifyByStatus(status: number, retryAfterMs: number | undefined, message: string): ClassifiedError | null {
  const hardened = resolveLoopHardeningEnabled();
  if (status === 429) {
    return { class: 'rateLimited', reason: `HTTP 429 ${message || 'rate limited'}`.trim(), retryAfterMs };
  }
  if (status === 401 || status === 403) {
    const base: ClassifiedError = { class: 'auth', reason: `HTTP ${status} ${message || (status === 401 ? 'unauthorised' : 'forbidden')}`.trim() };
    if (hardened) base.shouldRotateCredential = true;
    return base;
  }
  if (hardened && status === 413) {
    return { class: 'contextOverflow', reason: `HTTP 413 ${message || 'payload too large'}`.trim(), shouldCompress: true };
  }
  if (hardened && status === 529) {
    return { class: 'providerOverloaded', reason: `HTTP 529 ${message || 'overloaded'}`.trim(), retryAfterMs, shouldFallbackModel: true };
  }
  if (status === 408 || status === 502 || status === 503 || status === 504) {
    return { class: 'transient', reason: `HTTP ${status} ${message || 'service unavailable'}`.trim(), retryAfterMs };
  }
  if (status >= 500 && status <= 599) {
    return { class: 'transient', reason: `HTTP ${status} ${message || 'server error'}`.trim(), retryAfterMs };
  }
  if (status >= 400 && status <= 499) {
    return { class: 'permanent', reason: `HTTP ${status} ${message || 'client error'}`.trim() };
  }
  return null;
}

/**
 * Classify an arbitrary error value into a {@link RetryClass}. Precedence
 * (highest wins): explicit harness types → HTTP status → node error code →
 * substring heuristics → unknown.
 */
export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof PermissionDeniedError) {
    return { class: 'policyDenied', reason: err.message };
  }
  if (err instanceof HarnessError && err.recoverable === false) {
    return { class: 'permanent', reason: err.message };
  }

  const shape = readErrorShape(err);
  const lowered = shape.message.toLowerCase();
  const retryAfterMs = parseRetryAfter(shape.headers);

  // Explicit status field beats anything embedded in the message.
  if (typeof shape.status === 'number') {
    const result = classifyByStatus(shape.status, retryAfterMs, shape.message);
    if (result) return result;
  }

  // Node-style POSIX/Windows error codes.
  if (shape.code) {
    if (TRANSIENT_NODE_CODES.has(shape.code)) {
      return { class: 'transient', reason: `${shape.code}: ${shape.message}`, retryAfterMs };
    }
    if (PERMANENT_NODE_CODES.has(shape.code)) {
      return { class: 'permanent', reason: `${shape.code}: ${shape.message}` };
    }
  }

  // Status embedded in the error message (most OpenAI/Replicate wrappers
  // do this). Lower priority than explicit status field, higher than
  // substring heuristics so a message like "HTTP 401 expired token" still
  // classifies as auth even without a status field.
  const embeddedStatus = extractStatusFromMessage(shape.message);
  if (typeof embeddedStatus === 'number') {
    const result = classifyByStatus(embeddedStatus, retryAfterMs, shape.message);
    if (result) return result;
  }

  // Substring fallbacks — last resort, narrow phrases only.
  if (/\b(rate\s*limit|too many requests|quota exceeded)\b/i.test(shape.message)) {
    return { class: 'rateLimited', reason: shape.message, retryAfterMs };
  }
  if (/\b(unauthori[sz]ed|invalid api key|invalid token|expired token|forbidden)\b/i.test(shape.message)) {
    return { class: 'auth', reason: shape.message };
  }
  if (/\b(permission denied|policy denied|not allowed|disallowed)\b/i.test(shape.message)) {
    return { class: 'policyDenied', reason: shape.message };
  }
  if (/\b(timeout|timed out|connection reset|connection refused|temporarily unavailable|dns)\b/i.test(lowered)) {
    return { class: 'transient', reason: shape.message };
  }

  // Loop-hardening substring fallbacks (additive, gated by
  // HARNESS_LOOP_HARDENING). Each branch attaches the recovery hint that
  // names the one-shot remediation appropriate to the failure mode.
  // Caller (TurnRetryState-aware retry loop) decides whether to honour
  // the hint; with the flag off we fall through to the legacy unknown
  // classification so legacy callers see byte-identical behaviour.
  if (resolveLoopHardeningEnabled()) {
    if (/(content[_\s-]?policy|policy[_\s-]?violation|safety[_\s-]?(?:filter|policy)|prohibited content)/i.test(shape.message)) {
      return { class: 'contentPolicyBlocked', reason: shape.message };
    }
    if (/(thinking[_\s.\- ]?signature|encrypted[_\s-]?content|reasoning[_\s.\- ]?signature)/i.test(shape.message)) {
      return { class: 'thinkingSignature', reason: shape.message, shouldStripThinkingSignature: true };
    }
    if (/(context.*(?:too long|length|window)|maximum.*context|exceeds.*token|prompt.*too long|reduce.*length|too many tokens)/i.test(shape.message)) {
      return { class: 'contextOverflow', reason: shape.message, shouldCompress: true };
    }
    if (/(overloaded|capacity|server.*busy|model.*unavailable|service.*degraded)/i.test(shape.message)) {
      return { class: 'providerOverloaded', reason: shape.message, retryAfterMs, shouldFallbackModel: true };
    }
    if (/(invalid format|tool.*format|json.*parse error|malformed (?:tool|response)|unexpected token in json)/i.test(shape.message)) {
      return { class: 'formatError', reason: shape.message };
    }
  }

  // HarnessError defaults to recoverable=true ⇒ treat as transient.
  if (err instanceof HarnessError) {
    return { class: 'transient', reason: err.message };
  }

  return { class: 'unknown', reason: shape.message || 'unknown error' };
}

/**
 * Whether an error class should be retried at all. Auth and policy-denied
 * never retry; permanent never retries. Transient and rate-limited retry.
 * Unknown does NOT retry by default — caller can override.
 *
 * Loop-hardening additions:
 * - `providerOverloaded` retries (with fallback-model hint).
 * - `formatError` retries once with a reformat (caller's TurnRetryState
 *   ensures one-shot).
 * - `thinkingSignature` retries once after stripping the signature.
 * - `contextOverflow` retries only after the caller compresses; without
 *   compression, the same overlong request will fail again, so it is
 *   classified retryable HERE and the caller is expected to gate the
 *   actual retry on `shouldCompress`.
 * - `contentPolicyBlocked` does NOT retry.
 */
export function isRetryable(cls: RetryClass): boolean {
  return (
    cls === 'transient' ||
    cls === 'rateLimited' ||
    cls === 'providerOverloaded' ||
    cls === 'formatError' ||
    cls === 'thinkingSignature' ||
    cls === 'contextOverflow'
  );
}

/**
 * Class-aware backoff. Returns the delay before the next attempt:
 * - rateLimited: honour `retryAfterMs` if present, else exponential.
 * - transient: exponential with jitter.
 * - all other classes: 0 (caller should not retry; computed only when
 *   forced).
 */
export function computeRetryDelayMs(
  classified: ClassifiedError,
  attempt: number,
  baseDelayMs: number,
): number {
  if (!isRetryable(classified.class)) return 0;
  if (classified.class === 'rateLimited' && typeof classified.retryAfterMs === 'number') {
    return Math.max(0, classified.retryAfterMs);
  }
  // Exponential: base * 2^(attempt-1), capped at 30s, +/-20% jitter.
  const exp = Math.min(baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)), 30_000);
  const jitter = exp * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.floor(exp + jitter));
}
