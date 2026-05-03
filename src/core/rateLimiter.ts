import { logger } from './logger';

export class RateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRate: number;
  private lastRefill: number;
  private now: () => number;

  constructor(maxTokens: number = 10, refillPerSecond: number = 2, now?: () => number) {
    this.tokens = maxTokens;
    this.maxTokens = maxTokens;
    this.refillRate = refillPerSecond;
    this.now = now ?? Date.now;
    this.lastRefill = this.now();
  }

  tryConsume(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }

    logger.warn('RateLimiter', 'Rate limit exceeded', {
      tokens: this.tokens,
      maxTokens: this.maxTokens,
    });
    return false;
  }

  private refill(): void {
    const now = this.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}
