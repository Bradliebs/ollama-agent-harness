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
