import { sleep } from "../utils/time.ts";

/**
 * Per-source request pacing: a token bucket for the published rate limit plus a
 * hard concurrency cap, both required by section 4.1. Sources are only ever
 * called through this, so a runaway loop cannot exceed the documented limits.
 */
export class RateLimiter {
  private readonly perMinute: number;
  private readonly maxConcurrent: number;
  private tokens: number;
  private lastRefill = Date.now();
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(perMinute: number, maxConcurrent: number) {
    this.perMinute = perMinute;
    this.maxConcurrent = maxConcurrent;
    this.tokens = perMinute;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    while (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      if (signal?.aborted) throw new Error("Aborted while waiting for a request slot");
    }

    this.active += 1;
    await this.consumeToken(signal);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }

  private async consumeToken(signal?: AbortSignal): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((60_000 / this.perMinute) * (1 - this.tokens));
      await sleep(Math.max(50, waitMs), signal);
      if (signal?.aborted) throw new Error("Aborted while rate limited");
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.lastRefill = now;
    this.tokens = Math.min(this.perMinute, this.tokens + (elapsed / 60_000) * this.perMinute);
  }
}
