import { describe, it, expect } from '@jest/globals';
import {
  classifyError,
  isRetryable,
  computeRetryDelayMs,
} from './retryClass';
import {
  HarnessError,
  PermissionDeniedError,
  OllamaConnectionError,
} from './errors';

describe('classifyError', () => {
  describe('harness types take precedence', () => {
    it('PermissionDeniedError → policyDenied', () => {
      const out = classifyError(new PermissionDeniedError('bash', 'forbidden'));
      expect(out.class).toBe('policyDenied');
      expect(out.reason).toContain('Permission denied');
    });

    it('HarnessError with recoverable=false → permanent', () => {
      const err = new HarnessError('bad input', 'BAD_INPUT', false);
      expect(classifyError(err).class).toBe('permanent');
    });

    it('OllamaConnectionError → transient (recoverable HarnessError default)', () => {
      const out = classifyError(new OllamaConnectionError('ollama down'));
      expect(out.class).toBe('transient');
    });
  });

  describe('HTTP status from explicit field', () => {
    it('429 → rateLimited and honours Retry-After seconds', () => {
      const err = Object.assign(new Error('rate limited'), {
        status: 429,
        headers: { 'retry-after': '5' },
      });
      const out = classifyError(err);
      expect(out.class).toBe('rateLimited');
      expect(out.retryAfterMs).toBe(5000);
    });

    it('Retry-After HTTP date is parsed as a delta', () => {
      const future = new Date(Date.now() + 2000).toUTCString();
      const err = Object.assign(new Error('rate limited'), {
        status: 429,
        headers: { 'retry-after': future },
      });
      const out = classifyError(err);
      expect(out.class).toBe('rateLimited');
      // HTTP dates have second-precision so the parsed delta can lose up
      // to ~1s on the low end; allow the full sub-second-rounding band.
      expect(out.retryAfterMs).toBeGreaterThanOrEqual(900);
      expect(out.retryAfterMs).toBeLessThanOrEqual(2100);
    });

    it('401 → auth', () => {
      const err = Object.assign(new Error('unauth'), { status: 401 });
      expect(classifyError(err).class).toBe('auth');
    });

    it('403 → auth', () => {
      const err = Object.assign(new Error('forbidden'), { status: 403 });
      expect(classifyError(err).class).toBe('auth');
    });

    it('503 → transient', () => {
      const err = Object.assign(new Error('unavailable'), { status: 503 });
      expect(classifyError(err).class).toBe('transient');
    });

    it('500 → transient', () => {
      const err = Object.assign(new Error('boom'), { status: 500 });
      expect(classifyError(err).class).toBe('transient');
    });

    it('400 → permanent (client error)', () => {
      const err = Object.assign(new Error('bad request'), { status: 400 });
      expect(classifyError(err).class).toBe('permanent');
    });

    it('statusCode field is read as a fallback', () => {
      const err = Object.assign(new Error('boom'), { statusCode: 502 });
      expect(classifyError(err).class).toBe('transient');
    });
  });

  describe('node error codes', () => {
    it.each([
      ['ECONNREFUSED'],
      ['ECONNRESET'],
      ['ETIMEDOUT'],
      ['EAI_AGAIN'],
      ['ENOTFOUND'],
    ])('%s → transient', (code) => {
      const err = Object.assign(new Error(code), { code });
      expect(classifyError(err).class).toBe('transient');
    });

    it.each([
      ['ENOENT'],
      ['EACCES'],
      ['EISDIR'],
      ['ENAMETOOLONG'],
    ])('%s → permanent', (code) => {
      const err = Object.assign(new Error(code), { code });
      expect(classifyError(err).class).toBe('permanent');
    });
  });

  describe('embedded HTTP status in message', () => {
    it('extracts HTTP 429 from a wrapper message', () => {
      const out = classifyError(new Error('TestProv HTTP 429 rate exceeded'));
      expect(out.class).toBe('rateLimited');
    });

    it('extracts HTTP 401 from a wrapper message', () => {
      const out = classifyError(new Error('Replicate HTTP 401 token expired'));
      expect(out.class).toBe('auth');
    });
  });

  describe('substring fallbacks', () => {
    it('“rate limit” phrase → rateLimited', () => {
      expect(classifyError(new Error('You have hit a rate limit')).class).toBe('rateLimited');
    });

    it('“invalid api key” → auth', () => {
      expect(classifyError(new Error('invalid api key provided')).class).toBe('auth');
    });

    it('“permission denied” → policyDenied', () => {
      expect(classifyError(new Error('permission denied by policy')).class).toBe('policyDenied');
    });

    it('“connection refused” → transient', () => {
      expect(classifyError(new Error('connection refused while dialing')).class).toBe('transient');
    });

    it('truly unrecognised → unknown', () => {
      expect(classifyError(new Error('asdf qwerty')).class).toBe('unknown');
    });

    it('string and non-Error values do not crash', () => {
      expect(classifyError('boom').class).toBe('unknown');
      expect(classifyError(null).class).toBe('unknown');
      expect(classifyError(undefined).class).toBe('unknown');
      expect(classifyError(42).class).toBe('unknown');
    });
  });
});

describe('isRetryable', () => {
  it('only transient and rateLimited retry', () => {
    expect(isRetryable('transient')).toBe(true);
    expect(isRetryable('rateLimited')).toBe(true);
    expect(isRetryable('auth')).toBe(false);
    expect(isRetryable('policyDenied')).toBe(false);
    expect(isRetryable('permanent')).toBe(false);
    expect(isRetryable('unknown')).toBe(false);
  });
});

describe('computeRetryDelayMs', () => {
  it('returns 0 for non-retryable classes', () => {
    for (const cls of ['auth', 'policyDenied', 'permanent', 'unknown'] as const) {
      expect(
        computeRetryDelayMs({ class: cls, reason: 'x' }, 1, 1000),
      ).toBe(0);
    }
  });

  it('rateLimited honours retryAfterMs verbatim when present', () => {
    const d = computeRetryDelayMs(
      { class: 'rateLimited', reason: 'x', retryAfterMs: 7000 },
      1,
      1000,
    );
    expect(d).toBe(7000);
  });

  it('rateLimited without header falls back to exponential', () => {
    const d = computeRetryDelayMs({ class: 'rateLimited', reason: 'x' }, 2, 1000);
    // 1000 * 2^1 = 2000 base, ±20% jitter => [1600, 2400]
    expect(d).toBeGreaterThanOrEqual(1600);
    expect(d).toBeLessThanOrEqual(2400);
  });

  it('transient exponential is capped at 30 seconds', () => {
    const d = computeRetryDelayMs({ class: 'transient', reason: 'x' }, 20, 1000);
    // Cap 30000 ±20% jitter => [24000, 36000].
    expect(d).toBeLessThanOrEqual(36_000);
    expect(d).toBeGreaterThanOrEqual(24_000);
  });
});

describe('classifyError — HARNESS_LOOP_HARDENING extensions', () => {
  const original = process.env.HARNESS_LOOP_HARDENING;
  afterEach(() => {
    if (original === undefined) delete process.env.HARNESS_LOOP_HARDENING;
    else process.env.HARNESS_LOOP_HARDENING = original;
  });

  describe('with HARNESS_LOOP_HARDENING=0 (default)', () => {
    beforeEach(() => {
      delete process.env.HARNESS_LOOP_HARDENING;
    });

    it('413 still classifies as permanent (legacy behaviour preserved)', () => {
      const err = Object.assign(new Error('payload too large'), { status: 413 });
      expect(classifyError(err).class).toBe('permanent');
    });

    it('529 still classifies as transient (legacy behaviour preserved)', () => {
      const err = Object.assign(new Error('overloaded'), { status: 529 });
      expect(classifyError(err).class).toBe('transient');
    });

    it('“context too long” substring still classifies as unknown', () => {
      // Without the flag, the new contextOverflow pattern is dormant and
      // the caller falls through to the unknown bucket.
      expect(classifyError(new Error('the context is too long for this model')).class).toBe('unknown');
    });

    it('401 does NOT carry shouldRotateCredential hint', () => {
      const err = Object.assign(new Error('unauth'), { status: 401 });
      const out = classifyError(err);
      expect(out.class).toBe('auth');
      expect(out.shouldRotateCredential).toBeUndefined();
    });
  });

  describe('with HARNESS_LOOP_HARDENING=1', () => {
    beforeEach(() => {
      process.env.HARNESS_LOOP_HARDENING = '1';
    });

    it('413 → contextOverflow with shouldCompress=true', () => {
      const err = Object.assign(new Error('payload too large'), { status: 413 });
      const out = classifyError(err);
      expect(out.class).toBe('contextOverflow');
      expect(out.shouldCompress).toBe(true);
    });

    it('529 → providerOverloaded with shouldFallbackModel=true', () => {
      const err = Object.assign(new Error('overloaded'), { status: 529 });
      const out = classifyError(err);
      expect(out.class).toBe('providerOverloaded');
      expect(out.shouldFallbackModel).toBe(true);
    });

    it('401 carries shouldRotateCredential=true', () => {
      const err = Object.assign(new Error('unauth'), { status: 401 });
      const out = classifyError(err);
      expect(out.class).toBe('auth');
      expect(out.shouldRotateCredential).toBe(true);
    });

    it('“context too long” → contextOverflow with shouldCompress', () => {
      const out = classifyError(new Error('error: the context is too long for this model'));
      expect(out.class).toBe('contextOverflow');
      expect(out.shouldCompress).toBe(true);
    });

    it('“maximum context length” → contextOverflow', () => {
      expect(classifyError(new Error('exceeds maximum context length')).class).toBe('contextOverflow');
    });

    it('“thinking signature” → thinkingSignature with shouldStripThinkingSignature', () => {
      const out = classifyError(new Error('thinking_signature mismatch on retry'));
      expect(out.class).toBe('thinkingSignature');
      expect(out.shouldStripThinkingSignature).toBe(true);
    });

    it('“encrypted_content invalid” → thinkingSignature', () => {
      expect(classifyError(new Error('encrypted_content invalid for this turn')).class).toBe('thinkingSignature');
    });

    it('“content policy violation” → contentPolicyBlocked', () => {
      expect(classifyError(new Error('blocked: content_policy violation')).class).toBe('contentPolicyBlocked');
    });

    it('“server overloaded” → providerOverloaded with shouldFallbackModel', () => {
      const out = classifyError(new Error('the model is overloaded, try again later'));
      expect(out.class).toBe('providerOverloaded');
      expect(out.shouldFallbackModel).toBe(true);
    });

    it('“json parse error” → formatError', () => {
      expect(classifyError(new Error('json parse error in tool call')).class).toBe('formatError');
    });

    it('legacy “rate limit” pattern still wins over new patterns', () => {
      // "rate limit" is a more specific legacy-fallback match and runs
      // BEFORE the new patterns.
      expect(classifyError(new Error('rate limit exceeded — overloaded')).class).toBe('rateLimited');
    });

    it('genuinely unknown text remains unknown', () => {
      expect(classifyError(new Error('asdf qwerty')).class).toBe('unknown');
    });
  });
});

describe('isRetryable — extended classes', () => {
  it('providerOverloaded, formatError, thinkingSignature, contextOverflow are retryable', () => {
    expect(isRetryable('providerOverloaded')).toBe(true);
    expect(isRetryable('formatError')).toBe(true);
    expect(isRetryable('thinkingSignature')).toBe(true);
    expect(isRetryable('contextOverflow')).toBe(true);
  });

  it('contentPolicyBlocked is NOT retryable', () => {
    expect(isRetryable('contentPolicyBlocked')).toBe(false);
  });
});
