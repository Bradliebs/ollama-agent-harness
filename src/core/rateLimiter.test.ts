import { RateLimiter } from './rateLimiter';

describe('RateLimiter', () => {
  it('allows consumption up to maxTokens', () => {
    const limiter = new RateLimiter(3, 0);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
  });

  it('rejects when tokens are exhausted', () => {
    const limiter = new RateLimiter(1, 0);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
    expect(limiter.tryConsume()).toBe(false);
  });

  it('refills tokens over time', () => {
    let time = 1000;
    const clock = () => time;
    const limiter = new RateLimiter(2, 1000, clock);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
    // Advance 2 seconds — at 1000/s refill, should have 2 tokens back.
    time += 2000;
    expect(limiter.tryConsume()).toBe(true);
  });

  it('does not exceed maxTokens during refill', () => {
    let time = 1000;
    const clock = () => time;
    const limiter = new RateLimiter(2, 100, clock);
    // Wait a long time without consuming — should still cap at 2.
    time += 60000;
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
  });

  it('uses default constructor values', () => {
    const limiter = new RateLimiter();
    // Default is 10 tokens.
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryConsume()).toBe(true);
    }
    expect(limiter.tryConsume()).toBe(false);
  });
});
