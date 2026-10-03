/**
 * Concurrency limiter for controlling parallel job processing.
 */

/**
 * Simple semaphore-based concurrency limiter.
 */
export class ConcurrencyLimiter {
  private maxConcurrent: number;
  private currentCount = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    this.maxConcurrent = ConcurrencyLimiter.checked(maxConcurrent);
  }

  private static checked(maxConcurrent: number): number {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('maxConcurrent must be an integer of at least 1');
    }
    return maxConcurrent;
  }

  /** The most operations that run at once. */
  get limit(): number {
    return this.maxConcurrent;
  }

  /**
   * Change the limit. A raise admits waiters at once; a cut ends nothing
   * already running and admits no one until enough of it has ended.
   */
  setLimit(maxConcurrent: number): void {
    this.maxConcurrent = ConcurrencyLimiter.checked(maxConcurrent);
    while (this.currentCount < this.maxConcurrent) {
      const next = this.waitQueue.shift();
      if (!next) break;
      this.currentCount++;
      next();
    }
  }

  /**
   * Current number of active operations.
   */
  get active(): number {
    return this.currentCount;
  }

  /**
   * Number of operations waiting for a slot.
   */
  get waiting(): number {
    return this.waitQueue.length;
  }

  /**
   * Whether there are available slots.
   */
  get hasCapacity(): boolean {
    return this.currentCount < this.maxConcurrent;
  }

  /**
   * Acquire a slot. Resolves when a slot is available.
   */
  async acquire(): Promise<void> {
    if (this.currentCount < this.maxConcurrent) {
      this.currentCount++;
      return;
    }

    // Wait for a slot to become available
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  /**
   * Release a slot.
   */
  release(): void {
    if (this.currentCount <= 0) {
      return;
    }

    this.currentCount--;

    if (this.currentCount >= this.maxConcurrent) return;
    const next = this.waitQueue.shift();
    if (next) {
      this.currentCount++;
      next();
    }
  }

  /**
   * Run a function with concurrency limiting.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Try to acquire a slot without waiting.
   * Returns true if acquired, false if no slots available.
   */
  tryAcquire(): boolean {
    if (this.currentCount < this.maxConcurrent) {
      this.currentCount++;
      return true;
    }
    return false;
  }
}
