/**
 * Fixed-window rate limiter kept in process memory. It protects the paid
 * provider calls behind refresh endpoints. A rejected call is an error
 * (HTTP 429); nothing is queued or retried.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<
    string,
    { startedAt: number; count: number }
  >();

  public constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Returns 0 when the call is allowed, otherwise the seconds to wait. */
  public take(key: string): number {
    const now = this.clock();
    const current = this.windows.get(key);
    if (!current || now - current.startedAt >= this.windowMs) {
      this.windows.set(key, { startedAt: now, count: 1 });
      this.prune(now);
      return 0;
    }
    if (current.count >= this.maxPerWindow) {
      return Math.max(
        1,
        Math.ceil((current.startedAt + this.windowMs - now) / 1000),
      );
    }
    current.count += 1;
    return 0;
  }

  private prune(now: number): void {
    if (this.windows.size < 1000) return;
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.windows.delete(key);
    }
  }
}
