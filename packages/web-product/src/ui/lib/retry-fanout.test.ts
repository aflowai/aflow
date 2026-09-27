/**
 * A refused request costs one retry schedule, not one per component watching
 * it. The assertion is a count: whatever the policy decides, the number of
 * requests it spends may not scale with the number of mounted observers.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { QueryObserver, type QueryClient } from '@tanstack/react-query';
import { ApiError, createQueryClient, RETRY_429_MAX_RETRIES } from './query-client.js';

/** A screen that holds one key in as many places as it has rows. */
const OBSERVERS = 120;

const KEY = ['space', 'games', 'members'];

/** Requests one refused query may spend in total: the first, then its retries. */
const ALLOWED_REQUESTS = RETRY_429_MAX_RETRIES + 1;

const FAKE_TIMER_OPTS: Parameters<typeof vi.useFakeTimers>[0] = {
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
};

/** Torn down in `afterEach` so a failed assertion cannot leak live observers. */
let open: Array<{ client: QueryClient; unmount: () => void }> = [];

function mount(count: number, queryFn: () => Promise<unknown>): QueryClient {
  const client = createQueryClient();
  const unsubscribes = Array.from({ length: count }, () =>
    new QueryObserver(client, {
      queryKey: KEY,
      queryFn,
      // The roster's own options; a stale-time refetch would confound the count.
      staleTime: 5 * 60_000,
      retryOnMount: false,
    }).subscribe(() => {
      /* a mounted component rendering whatever arrives */
    }),
  );
  open.push({ client, unmount: () => unsubscribes.forEach((u) => u()) });
  return client;
}

function refuse(retryAfterMs?: number): () => Promise<never> {
  return () =>
    Promise.reject(
      new ApiError({
        status: 429,
        message: 'rate limited',
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      }),
    );
}

afterEach(() => {
  for (const { client, unmount } of open) {
    unmount();
    client.clear();
  }
  open = [];
  vi.useRealTimers();
});

describe('429 fan-out', () => {
  it('costs one request per attempt, not one per observer', async () => {
    vi.useFakeTimers(FAKE_TIMER_OPTS);
    let requests = 0;
    mount(OBSERVERS, () => {
      requests += 1;
      return refuse(1_000)();
    });

    // The first attempt, before any retry timer has come due.
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toBe(1);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(requests).toBe(ALLOWED_REQUESTS);
  });

  it('costs the same whether 1 observer is mounted or 120', async () => {
    const countFor = async (observers: number): Promise<number> => {
      vi.useFakeTimers(FAKE_TIMER_OPTS);
      let requests = 0;
      mount(observers, () => {
        requests += 1;
        return refuse()();
      });
      await vi.advanceTimersByTimeAsync(120_000);
      return requests;
    };

    expect(await countFor(OBSERVERS)).toBe(await countFor(1));
  });

  it('stops rather than retrying forever while the server keeps refusing', async () => {
    vi.useFakeTimers(FAKE_TIMER_OPTS);
    let requests = 0;
    mount(OBSERVERS, () => {
      requests += 1;
      return refuse(1_000)();
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(requests).toBe(ALLOWED_REQUESTS);
  });

  /**
   * A list grows an observer at a time. Without the query's `retryOnMount:
   * false` each arrival starts its own schedule against a server still
   * refusing, and the cost is per-observer again by a different route.
   */
  it('does not start a fresh schedule for an observer mounting after the error', async () => {
    vi.useFakeTimers(FAKE_TIMER_OPTS);
    let requests = 0;
    const queryFn = () => {
      requests += 1;
      return refuse()();
    };

    const client = mount(1, queryFn);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(requests).toBe(ALLOWED_REQUESTS);

    // Later arrivals join the errored query rather than re-driving it.
    const late = Array.from({ length: OBSERVERS }, () =>
      new QueryObserver(client, {
        queryKey: KEY,
        queryFn,
        staleTime: 5 * 60_000,
        retryOnMount: false,
      }).subscribe(() => {
        /* render */
      }),
    );
    await vi.advanceTimersByTimeAsync(120_000);
    late.forEach((u) => u());

    expect(requests).toBe(ALLOWED_REQUESTS);
  });

  /**
   * The counts above are measured through `QueryObserver`, where the policy
   * lives — they hold even if a retry is reintroduced one layer up, inside the
   * hook, where it would run once per observer. So the hook is held to the
   * property directly.
   *
   * One property only: `useApiQuery` schedules no re-request of its own. It
   * says nothing about the rest of the file.
   */
  it('keeps the retry out of the hook, where it would run once per observer', () => {
    const hook = readFileSync(
      fileURLToPath(new URL('../hooks/useApiQuery.ts', import.meta.url)),
      'utf8',
    );
    expect(hook).not.toMatch(/setTimeout|setInterval|queueMicrotask|requestAnimationFrame/);
    expect(hook).not.toMatch(/\brefetch\b/);
  });

  it('surfaces the error once it gives up, so the screen is not left spinning', async () => {
    vi.useFakeTimers(FAKE_TIMER_OPTS);
    const client = mount(1, refuse());
    await vi.advanceTimersByTimeAsync(120_000);

    const observer = new QueryObserver(client, {
      queryKey: KEY,
      queryFn: refuse(),
      retryOnMount: false,
    });
    const result = observer.getCurrentResult();
    expect(result.isError).toBe(true);
    expect(result.error).toBeInstanceOf(ApiError);
    expect((result.error as ApiError).status).toBe(429);
  });
});
