import { QueryClient } from '@tanstack/react-query';

// ============================================================================
// Error type — what the wrappers throw on non-2xx responses
// ============================================================================

/**
 * Typed HTTP error surfaced by `useApiQuery` / `useApiMutation`.
 *
 * The `status` field is what the retry policy reads. `retryAfterMs` is
 * populated from the `Retry-After` header on 429 responses; consumers
 * (and the policy below) honour it instead of guessing a backoff.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  readonly body: unknown;

  constructor(opts: {
    status: number;
    message: string;
    // Present-and-undefined, not absent: a response without `Retry-After` still
    // reports the field, which `exactOptionalPropertyTypes` treats as distinct.
    retryAfterMs?: number | undefined;
    body?: unknown;
  }) {
    super(opts.message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.body = opts.body;
  }
}

/**
 * Build an `ApiError` from a non-2xx response, preserving the parsed body so
 * callers can read structured payloads (e.g. an allowlist denial's
 * `deniedHosts`) instead of just a message.
 */
export async function apiErrorFromResponse(res: Response, fallback: string): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => null);
  let message = fallback;
  if (body && typeof body === 'object') {
    const { message: m, error: e } = body as { message?: unknown; error?: unknown };
    if (typeof m === 'string' && m.length > 0) message = m;
    else if (typeof e === 'string' && e.length > 0) message = e;
  }
  return new ApiError({ status: res.status, message, body });
}

// ============================================================================
// Retry-After parsing
// ============================================================================

/**
 * Parse the `Retry-After` header on a 429 response into milliseconds.
 *
 * Per RFC 9110, `Retry-After` is either:
 *   - delta-seconds (e.g. `"5"`), OR
 *   - HTTP-date (e.g. `"Wed, 21 Oct 2026 07:28:00 GMT"`).
 *
 * Returns `undefined` if the header is missing or unparseable; callers
 * fall back to their default backoff in that case.
 *
 * @param headerValue Raw `Retry-After` header value or null/undefined.
 * @param now         Injected "now" timestamp for testability. Defaults
 *                    to `Date.now()`. Tests pass a fixed value so HTTP-date
 *                    parsing is deterministic.
 */
export function parseRetryAfter(
  headerValue: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (headerValue == null) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return undefined;

  // delta-seconds form: an integer (RFC 9110 §10.2.3).
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return seconds * 1000;
  }

  // HTTP-date form.
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  const delta = dateMs - now;
  return delta > 0 ? delta : 0;
}

// ============================================================================
// Retry policy
// ============================================================================

/** How many times a refused request is retried before the error is surfaced. */
export const RETRY_429_MAX_RETRIES = 5;
/** First backoff step when the server named no delay of its own. */
export const RETRY_BACKOFF_BASE_MS = 1_000;
/** Caps one exponential step. */
export const RETRY_BACKOFF_CEILING_MS = 30_000;
/**
 * Longest single delay honoured from a `Retry-After`.
 *
 * The cap is per attempt rather than accumulated because the policy is a pure
 * function of `(failureCount, error)` — it cannot see how long the schedule has
 * already waited. Capping each attempt bounds the total deterministically for
 * any sequence of hints, including a descending one that would slip past a
 * check comparing a single hint against the whole budget.
 */
export const RETRY_HINT_MAX_MS = 12_000;
/** Worst case for the whole schedule, and the reason the per-attempt cap exists. */
export const RETRY_TOTAL_BUDGET_MS = RETRY_429_MAX_RETRIES * RETRY_HINT_MAX_MS;

/** Shared by the 429 schedule and the 5xx/network one, so the curve is one curve. */
function exponentialBackoff(failureCount: number): number {
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** failureCount, RETRY_BACKOFF_CEILING_MS);
}

/**
 * Delay before the next attempt at a refused (429) request, or `null` to stop
 * retrying and surface the error.
 *
 * Retrying a 429 is the one policy that can amplify the condition it responds
 * to, so every bound here is load-bearing. `failureCount` is TanStack's 0-based
 * count of attempts already made.
 *
 * A hint at or below zero names no useful moment to return — `parseRetryAfter`
 * yields zero for any HTTP-date already past, including one that is only past
 * because of clock skew — so it falls through to the backoff rather than
 * firing every attempt into the same tick.
 *
 * A hint longer than {@link RETRY_HINT_MAX_MS} ends the retrying rather than
 * being shortened: holding a query in flight for minutes reads to the user as a
 * hang, and waiting less than the server asked spends its window again for
 * nothing. Surfacing the error says what happened.
 */
export function retryAfterDelay(
  failureCount: number,
  retryAfterMs: number | undefined,
): number | null {
  if (failureCount >= RETRY_429_MAX_RETRIES) return null;
  if (retryAfterMs === undefined || retryAfterMs <= 0) return exponentialBackoff(failureCount);
  if (retryAfterMs > RETRY_HINT_MAX_MS) return null;
  return retryAfterMs;
}

/**
 * Per-query retry policy. Returns `true` to retry, `false` to surface the
 * error to the caller.
 *
 * Rules (in evaluation order):
 *   1. 429 — retry on {@link retryAfterDelay}'s schedule, which honours the
 *      server's `Retry-After` when it named one and backs off when it did not.
 *   2. Other 4xx — do NOT retry. Client errors are not transient.
 *   3. 5xx + network errors — retry up to 2 times (3 attempts total).
 *
 * Retrying a 429 belongs to the query. TanStack runs this policy once per
 * query however many observers are mounted, so the cost of a refusal stays
 * fixed; the same policy inside a hook runs once per observer, and a screen
 * holding one key in N places then answers a single refusal with N requests
 * against the endpoint that just shed load.
 *
 * Mutations override this to `false` (mutations are not idempotent by
 * default — see `defaultOptions.mutations.retry` below).
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  const status = extractStatus(error);
  if (status === 429) return retryAfterDelay(failureCount, extractRetryAfterMs(error)) !== null;
  if (status !== undefined && status >= 400 && status < 500) return false;
  return failureCount < 2;
}

/**
 * Delay TanStack waits before the next attempt.
 *
 * The retryer computes this *before* it asks {@link shouldRetry} whether to
 * retry at all, so this is also called for errors that are about to be
 * surfaced; the `?? 0` is that case, and the value is discarded.
 */
export function retryDelay(failureCount: number, error: unknown): number {
  if (extractStatus(error) === 429) {
    return retryAfterDelay(failureCount, extractRetryAfterMs(error)) ?? 0;
  }
  return exponentialBackoff(failureCount);
}

function extractStatus(error: unknown): number | undefined {
  if (error instanceof ApiError) return error.status;
  if (error && typeof error === 'object' && 'status' in error) {
    const s = (error as { status?: unknown }).status;
    if (typeof s === 'number') return s;
  }
  return undefined;
}

function extractRetryAfterMs(error: unknown): number | undefined {
  if (error instanceof ApiError) return error.retryAfterMs;
  if (error && typeof error === 'object' && 'retryAfterMs' in error) {
    const v = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return undefined;
}

// ============================================================================
// Query client factory
// ============================================================================

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        retry: shouldRetry,
        retryDelay,
      },
      mutations: {
        // Mutations are not idempotent by default. Wrappers may override
        // per-call when the operation is safely retryable.
        retry: false,
      },
    },
  });
}
