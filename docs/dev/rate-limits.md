# API rate limits

Plan 161 §4.3 — server-side rate-limit segmentation. Replaces the pre-Plan-161
global `100 req/min / IP` cap with per-class limits keyed by user identity.

## Per-class limits

| Class                                            | Limit                                      | Key                                                                                                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **JSON reads** (GET, HEAD, OPTIONS)              | **300 req / min / user**                   | `reads:<userId>` (fallback `reads:ip:<addr>`)                                                              | Generous — client cache dedupes within a session, so the bucket fills mainly from first-page-load bursts. The Plan 161 client work (TanStack cache + brokers) keeps repeat reads off the wire.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Mutations** (POST, PUT, PATCH, DELETE)         | **60 req / min / user**                    | `mutations:<userId>` (fallback `mutations:ip:<addr>`)                                                      | Stricter — mutations are intentional acts; volume should be human-scale.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Streams** (SSE / WebSocket)                    | **Bypassed** — no per-request cap          | n/a                                                                                                        | Long-lived connections; counting them in req/min doesn't model the real resource cost. A concurrent-connection cap per user is the right shape and is tracked as a follow-up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Health / Auth**                                | **Bypassed**                               | n/a                                                                                                        | Don't gate platform observability (`/health`, `/v1/health/*`) or the login flow (`/v1/auth/*`, `/v1/oauth/*`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Signup** (JIT user provisioning)               | **10 / hour / IP**                         | `aflow:ratelimit:signup:<addr>` (Redis)                                                                    | New-user creation happens inside the auth hook on the first authenticated request — there is no signup URL to class, so a Redis fixed window is consumed at the provisioning call site before `jitProvisionUser` runs. Over-limit → 429. Existing users never touch it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Invite requests** (`POST /v1/invite-requests`) | **10 / hour / IP** AND **5 / day / email** | `aflow:ratelimit:invite-request:ip:<addr>`, `aflow:ratelimit:invite-request:email:<sha256-prefix>` (Redis) | Public, unauthenticated request-access funnel. Both fixed windows are consumed on every attempt (`consumeInviteRequestRateLimit`). Per-IP over-limit → visible 429; per-email over-limit → the neutral 202 with a silent drop (a visible rejection would leak that others recently submitted the address). The email key stores a hash of the **canonical** address (`canonicalizeEmail` — plus-tags stripped everywhere, dots stripped on Google domains), so Gmail dot-trick variants of one inbox share one window instead of minting a fresh budget each. A per-tenant pending cap (`MAX_PENDING_INVITE_REQUESTS_PER_TENANT`, default 500) also answers 429 when the queue is full. Without Redis the endpoint fails closed (503). Both windows are consumed **before** Turnstile verification, so the limiter — not the attacker — bounds how many outbound siteverify calls a caller can make the API issue. |

## Signup limiter

The signup class is not enforced by `@fastify/rate-limit`: JIT provisioning
runs during authentication of whatever request a brand-new user sends first,
and the pre-auth paths are bypassed anyway. Instead the auth hook consumes a
per-IP fixed-window counter (`consumeSignupRateLimit`, Redis `INCR` +
`EXPIRE NX`) only when identity resolution misses — i.e. an actual new-user
creation attempt, invited or open-signup alike. Rejected invite-only attempts
consume budget too; that is the abuse control.

## Invite-request limiter

`POST /v1/invite-requests` is the only unauthenticated JSON mutation, so it
gets its own class on top of the generic per-IP mutation bucket: a per-IP
window (mirrors the signup cap — both are "stranger asks to get in" acts) and
a per-email window (bounds queue churn for a single address across IPs).
Within the windows the endpoint always answers a neutral 202 — whether the
email is new, already queued, already invited, or already a member — so
nothing about account existence leaks. Duplicate pending requests collapse
into the existing row.

The neutrality extends to the per-email window itself: its counter is shared
across all IPs, so exhausting it is third-party-observable state. A caller
whose own per-IP window admits but whose target email is exhausted gets the
same neutral 202 (silently dropped); only the caller-attributable per-IP
window and the pending cap answer a visible 429. When Redis is unavailable
the endpoint answers 503 instead of running unmetered.

## Client IP behind the BFF

Per-IP windows key on `clientIp()` (`packages/server-runtime/src/lib/clientIp.ts`).
Browser traffic reaches the API through the Vercel BFF, whose egress IP would
otherwise collapse all browser users into one bucket — so the BFF forwards
the real client IP in `X-Client-IP`, trusted only alongside a verified
`X-Origin-Verify` secret (which Cloudflare never injects; only the BFF and
MCP hold it). Verified callers without `X-Client-IP` fall back to
`CF-Connecting-IP`; everything else keys on the socket address. Bare
`X-Forwarded-For` is never consulted.

## Key strategy

- Bucket key is the authenticated `userId` from `request.authUser` whenever
  present. Anonymous traffic falls back to remote IP.
- The method class (`reads` vs `mutations`) is prefixed onto the key so the
  two buckets are independent per user. A spike of cached GETs doesn't
  consume an operator's mutation budget.
- **Multi-tenant collision fix**: pre-Plan-161, operators on a shared
  NAT'd egress IP shared one bucket — heavy use by one tenant starved the
  others. With `userId` keying, each authenticated operator gets their own.

## Bypassed endpoints (`shouldBypassRateLimit`)

- `/health`
- `/v1/health/*`
- `/v1/auth/*`
- `/v1/oauth/*`
- `/v1/realtime` (WebSocket)
- `/v1/agui/*` (AG-UI streaming sessions)

Live app surfaces (session events, Action Center, entity events) use the
realtime WebSocket gateway (Plan 170). `GET /v1/sessions/:sessionId/events?limit=`
is JSON polling and is rate-limited like other REST reads.

## When Redis is unavailable

The limiter loses its counters; the API keeps serving. Its connection runs with the offline
queue disabled so a command against a dead socket fails immediately rather than stalling the
request on the way in, and `skipOnError` lets that failure through as _allow_ — without it
the plugin rethrows and every guarded route answers 500 for the length of the outage.

## Source of truth

- Policy and plugin options: [`packages/server-runtime/src/lib/rateLimitPolicy.ts`](../../packages/server-runtime/src/lib/rateLimitPolicy.ts) — `buildRateLimitOptions()`
- Wiring: [`packages/server-runtime/src/app.ts`](../../packages/server-runtime/src/app.ts) — `app.register(rateLimit, buildRateLimitOptions(...))`
- Tests: [`rateLimitPolicy.test.ts`](../../packages/server-runtime/src/lib/rateLimitPolicy.test.ts), [`rateLimitFallOpen.test.ts`](../../packages/server-runtime/src/lib/rateLimitFallOpen.test.ts)

## Follow-ups

- **SSE concurrent-connection cap** — replace the bypass with a per-user
  cap (e.g. 8 concurrent streams) so a buggy client can't open hundreds
  of EventSources. Currently relies on the client broker (Plan 161 §4.2)
  to enforce one-stream-per-channel discipline.
