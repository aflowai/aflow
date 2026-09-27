import { describe, expect, it, vi } from 'vitest';
import { QueryObserver, type QueryClient as TQueryClient } from '@tanstack/react-query';

import {
  ApiError,
  createQueryClient,
  parseRetryAfter,
  retryAfterDelay,
  retryDelay,
  shouldRetry,
  RETRY_429_MAX_RETRIES,
  RETRY_BACKOFF_CEILING_MS,
  RETRY_TOTAL_BUDGET_MS,
  RETRY_HINT_MAX_MS,
} from './query-client.js';

// ============================================================================
// parseRetryAfter
// ============================================================================

describe('parseRetryAfter', () => {
  it('parses delta-seconds form', () => {
    expect(parseRetryAfter('5')).toBe(5_000);
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('parses HTTP-date form relative to injected `now`', () => {
    const now = Date.parse('2026-05-23T10:00:00Z');
    const future = 'Sat, 23 May 2026 10:00:30 GMT';
    expect(parseRetryAfter(future, now)).toBe(30_000);
  });

  it('clamps past HTTP-dates to 0 (server told us we can retry now)', () => {
    const now = Date.parse('2026-05-23T10:00:00Z');
    const past = 'Sat, 23 May 2026 09:59:00 GMT';
    expect(parseRetryAfter(past, now)).toBe(0);
  });

  it('returns undefined for missing / empty / malformed headers', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('   ')).toBeUndefined();
    expect(parseRetryAfter('not-a-date')).toBeUndefined();
  });

  it('handles surrounding whitespace', () => {
    expect(parseRetryAfter('  10  ')).toBe(10_000);
  });
});

// ============================================================================
// shouldRetry
// ============================================================================

describe('shouldRetry', () => {
  it('retries a 429 on the bounded schedule, then gives up', () => {
    const err = new ApiError({ status: 429, message: 'rate limited' });
    expect(shouldRetry(0, err)).toBe(true);
    expect(shouldRetry(RETRY_429_MAX_RETRIES - 1, err)).toBe(true);
    expect(shouldRetry(RETRY_429_MAX_RETRIES, err)).toBe(false);
  });

  it('gives up on a 429 the server will not lift inside the budget', () => {
    const err = new ApiError({
      status: 429,
      message: 'rate limited',
      retryAfterMs: RETRY_HINT_MAX_MS + 1,
    });
    expect(shouldRetry(0, err)).toBe(false);
  });

  it('opts out of other 4xx — client errors are not transient', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const err = new ApiError({ status, message: 'no' });
      expect(shouldRetry(0, err), `status=${String(status)}`).toBe(false);
    }
  });

  it('retries 5xx up to 2 times (3 attempts total)', () => {
    const err = new ApiError({ status: 500, message: 'boom' });
    expect(shouldRetry(0, err)).toBe(true);
    expect(shouldRetry(1, err)).toBe(true);
    expect(shouldRetry(2, err)).toBe(false);
  });

  it('retries network errors (no status) up to 2 times', () => {
    const err = new Error('NetworkError');
    expect(shouldRetry(0, err)).toBe(true);
    expect(shouldRetry(1, err)).toBe(true);
    expect(shouldRetry(2, err)).toBe(false);
  });

  it('reads status from plain {status} error objects too', () => {
    expect(shouldRetry(0, { status: 429 })).toBe(true);
    expect(shouldRetry(0, { status: 503 })).toBe(true);
    expect(shouldRetry(0, { status: 404 })).toBe(false);
  });
});

// ============================================================================
// retryAfterDelay / retryDelay
// ============================================================================

describe('retryAfterDelay', () => {
  it('honours a server-supplied Retry-After exactly', () => {
    expect(retryAfterDelay(0, 5_000)).toBe(5_000);
  });

  it('backs off exponentially when the server supplies nothing', () => {
    expect([0, 1, 2, 3, 4].map((n) => retryAfterDelay(n, undefined))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000,
    ]);
  });

  it('never waits longer than the ceiling', () => {
    for (let n = 0; n < RETRY_429_MAX_RETRIES; n++) {
      expect(retryAfterDelay(n, undefined) as number).toBeLessThanOrEqual(RETRY_BACKOFF_CEILING_MS);
    }
  });

  it('stops rather than looping forever', () => {
    expect(retryAfterDelay(RETRY_429_MAX_RETRIES, undefined)).toBeNull();
    expect(retryAfterDelay(RETRY_429_MAX_RETRIES + 10, undefined)).toBeNull();
  });

  it('does not let a server-supplied delay escape the attempt ceiling', () => {
    expect(retryAfterDelay(RETRY_429_MAX_RETRIES, 1_000)).toBeNull();
  });

  it('gives up rather than waiting past the per-attempt cap', () => {
    expect(retryAfterDelay(0, RETRY_HINT_MAX_MS + 1)).toBeNull();
    expect(retryAfterDelay(0, 3_600_000)).toBeNull();
  });

  /**
   * A cap compared against the whole budget lets a descending sequence walk
   * past it — each hint looks affordable on its own while the total does not.
   */
  it.each([
    ['constant', () => RETRY_HINT_MAX_MS],
    ['descending', (n: number) => Math.ceil(30_000 / (n + 1))],
    ['ascending', (n: number) => 1_000 * (n + 1)],
    ['alternating', (n: number) => (n % 2 === 0 ? 11_000 : 2_000)],
  ])('bounds the accumulated wait for %s hints', (_label, hintFor) => {
    let total = 0;
    for (let n = 0; n < RETRY_429_MAX_RETRIES; n++) {
      const d = retryAfterDelay(n, hintFor(n));
      if (d === null) break;
      total += d;
    }
    expect(total).toBeLessThanOrEqual(RETRY_TOTAL_BUDGET_MS);
  });

  it('backs off instead of firing instantly on a zero or past-dated hint', () => {
    // `parseRetryAfter` yields 0 for any HTTP-date already past.
    expect(retryAfterDelay(0, 0)).toBe(1_000);
    expect(retryAfterDelay(1, 0)).toBe(2_000);
  });

  it('gives up in bounded total time', () => {
    let total = 0;
    for (let n = 0; n < RETRY_429_MAX_RETRIES; n++)
      total += retryAfterDelay(n, undefined) as number;
    // Long enough to ride out a blip, short enough that the user is told.
    expect(total).toBeLessThanOrEqual(60_000);
  });
});

describe('retryDelay', () => {
  it('uses the 429 schedule for a 429', () => {
    const err = new ApiError({ status: 429, message: 'rl', retryAfterMs: 2_500 });
    expect(retryDelay(0, err)).toBe(2_500);
  });

  it('backs off for everything else', () => {
    const err = new ApiError({ status: 500, message: 'boom' });
    expect(retryDelay(0, err)).toBe(1_000);
    expect(retryDelay(1, err)).toBe(2_000);
  });

  it('never returns a delay above the ceiling', () => {
    const err = new ApiError({ status: 500, message: 'boom' });
    expect(retryDelay(50, err)).toBe(RETRY_BACKOFF_CEILING_MS);
  });
});

// ============================================================================
// ApiError
// ============================================================================

describe('ApiError', () => {
  it('preserves status, message, retryAfterMs, and body', () => {
    const err = new ApiError({
      status: 429,
      message: 'rate limited',
      retryAfterMs: 5_000,
      body: { code: 'RATE_LIMIT' },
    });
    expect(err.status).toBe(429);
    expect(err.message).toBe('rate limited');
    expect(err.retryAfterMs).toBe(5_000);
    expect(err.body).toEqual({ code: 'RATE_LIMIT' });
    expect(err.name).toBe('ApiError');
    expect(err instanceof Error).toBe(true);
  });

  it('omits retryAfterMs when not provided', () => {
    const err = new ApiError({ status: 500, message: 'boom' });
    expect(err.retryAfterMs).toBeUndefined();
  });
});

// ============================================================================
// createQueryClient
// ============================================================================

describe('createQueryClient', () => {
  it('wires the Plan 161 §4.1.1 defaults', () => {
    const client = createQueryClient();
    const defaults = client.getDefaultOptions();
    expect(defaults.queries?.staleTime).toBe(10_000);
    expect(defaults.queries?.gcTime).toBe(5 * 60_000);
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
    expect(defaults.queries?.refetchOnReconnect).toBe(true);
    expect(defaults.mutations?.retry).toBe(false);
  });

  // Suppressing it globally would also strand a query that exhausted its
  // retries on a transient 5xx: coming back to that screen must retry.
  it('leaves remount recovery on by default, scoping the opt-out per query', () => {
    expect(createQueryClient().getDefaultOptions().queries?.retryOnMount).toBeUndefined();
  });

  it('routes query retry through `shouldRetry` (429 and 5xx retry, 404 does not)', () => {
    const client = createQueryClient();
    const retryOpt = client.getDefaultOptions().queries?.retry;
    expect(typeof retryOpt).toBe('function');
    // Cast through unknown — TanStack's union is wider than the function shape we ship.
    const retryFn = retryOpt as (failureCount: number, err: unknown) => boolean;
    expect(retryFn(0, new ApiError({ status: 429, message: 'rl' }))).toBe(true);
    expect(retryFn(0, new ApiError({ status: 500, message: 'boom' }))).toBe(true);
    expect(retryFn(2, new ApiError({ status: 500, message: 'boom' }))).toBe(false);
    expect(retryFn(0, new ApiError({ status: 404, message: 'nope' }))).toBe(false);
  });

  // The delay must come off the same policy the retry decision does, or the
  // two disagree about how long a refusal lasts.
  it('wires `retryDelay` so the server hint is honoured by the query itself', () => {
    const client = createQueryClient();
    const delayOpt = client.getDefaultOptions().queries?.retryDelay;
    expect(typeof delayOpt).toBe('function');
    const delayFn = delayOpt as (failureCount: number, err: unknown) => number;
    expect(delayFn(0, new ApiError({ status: 429, message: 'rl', retryAfterMs: 7_000 }))).toBe(
      7_000,
    );
  });
});

// ============================================================================

describe('TanStack QueryClient dedupe — the contract useApiQuery relies on', () => {
  it('fetchQuery dedupes N concurrent same-key calls into one queryFn invocation', async () => {
    const client = createQueryClient();
    const queryFn = vi.fn(async () => ({ value: 42 }));

    const results = await Promise.all([
      client.fetchQuery({ queryKey: ['t', 'dedupe', 'a'], queryFn }),
      client.fetchQuery({ queryKey: ['t', 'dedupe', 'a'], queryFn }),
      client.fetchQuery({ queryKey: ['t', 'dedupe', 'a'], queryFn }),
      client.fetchQuery({ queryKey: ['t', 'dedupe', 'a'], queryFn }),
      client.fetchQuery({ queryKey: ['t', 'dedupe', 'a'], queryFn }),
    ]);

    expect(queryFn).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r).toEqual({ value: 42 });
  });

  it('different keys do NOT dedupe (each gets its own fetch)', async () => {
    const client = createQueryClient();
    const queryFn = vi.fn(async ({ queryKey }: { queryKey: readonly unknown[] }) => ({
      key: queryKey,
    }));

    await Promise.all([
      client.fetchQuery({ queryKey: ['t', 'a'], queryFn }),
      client.fetchQuery({ queryKey: ['t', 'b'], queryFn }),
      client.fetchQuery({ queryKey: ['t', 'c'], queryFn }),
    ]);

    expect(queryFn).toHaveBeenCalledTimes(3);
  });

  it('QueryObserver — N subscribers to the same key share one fetch', async () => {
    // `useQuery` is a React binding over QueryObserver — pinning dedupe
    // at this layer covers the wrapper hook's path without needing
    // jsdom. Each observer here stands in for one component that
    // mounted `useApiQuery({ key: ['t', 'obs'] })` concurrently.
    const client: TQueryClient = createQueryClient();
    const queryFn = vi.fn(async () => ({ ok: true }));

    const observers = Array.from(
      { length: 4 },
      () => new QueryObserver(client, { queryKey: ['t', 'obs'], queryFn }),
    );

    // Wire one subscriber per observer to drive them into "active" state
    // — that's what makes them fetch (a passive Observer doesn't fire).
    const unsubs = observers.map((o) =>
      o.subscribe(() => {
        /* no-op listener; subscription itself is what triggers fetch */
      }),
    );

    // Wait for in-flight settlement. fetchOptimistic isn't public; the
    // simplest "are we done?" probe is to await getCurrentResult until
    // status leaves 'pending'. A small backoff loop is sufficient and
    // mirrors how TanStack's own tests poll.
    await waitFor(() => observers[0]!.getCurrentResult().status !== 'pending');

    for (const o of observers) {
      const r = o.getCurrentResult();
      expect(r.status).toBe('success');
      expect(r.data).toEqual({ ok: true });
    }
    expect(queryFn).toHaveBeenCalledTimes(1);

    for (const u of unsubs) u();
  });
});

async function waitFor(cond: () => boolean, opts: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 1_000;
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${String(timeoutMs)}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
