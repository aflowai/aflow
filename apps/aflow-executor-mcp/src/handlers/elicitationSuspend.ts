import type { Redis } from 'ioredis';
import type { SlotController } from '@aflow/executor-runtime';
import {
  acquireMcpElicitationLease,
  refreshMcpElicitationLease,
  releaseMcpElicitationLease,
  publishMcpElicitationRequest,
  subscribeMcpElicitationResponse,
  type McpElicitationRequestEnvelope,
} from '@aflow/redis';
import { type McpElicitationRequest, type McpElicitationResponse } from '@aflow/schemas';

export interface SuspendForElicitationParams {
  /** Normalized Phoenix view of the inbound `elicitation/create` request. */
  request: McpElicitationRequest;
  /** Routing context from the in-flight tool call. */
  tenantId: string;
  spaceId: string;
  stepExecutionId: string;
  bindingId: string;
  serverId: string;
  sessionId?: string;
  /** Stable identifier of this executor instance (matches heartbeat key). */
  executorInstanceId: string;
  /** Lease TTL (also the elicitation timeout). */
  leaseTtlMs: number;

  /** Redis connection for lease writes + publish. */
  redis: Redis;
  /** Dedicated pub/sub subscriber connection (must be in pub/sub mode). */
  redisSubscriber: Redis;
  /** Slot controller from `ExecutorContext`. */
  slotController?: SlotController | undefined;
  /** Logger for observability. */
  log?: { info: (msg: string, meta?: object) => void; warn: (msg: string, meta?: object) => void };

  /** Test seam — when set, replaces setInterval/clearInterval timers. */
  timer?: TimerSeam;

  abortRegistry?: Set<() => void>;
}

/** Test seam — lets specs drive the heartbeat + timeout deterministically. */
export interface TimerSeam {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export type SuspendOutcome =
  | { kind: 'resolved'; response: McpElicitationResponse }
  | { kind: 'lease_conflict' }
  | { kind: 'timeout' }
  | { kind: 'lease_lost' };

/**
 * Heartbeat fraction — refresh every `1 / HEARTBEAT_DIVISOR` of the TTL.
 * 3 gives us two-thirds buffer for Redis hiccups before the key would
 * actually expire.
 */
const HEARTBEAT_DIVISOR = 3;
/** Floor: never heartbeat slower than this (sec-scale TTLs degrade fast). */
const MIN_HEARTBEAT_MS = 5 * 1000;

export async function suspendForElicitation(
  params: SuspendForElicitationParams,
): Promise<SuspendOutcome> {
  const timer: TimerSeam = params.timer ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => {
      globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>);
    },
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (h) => {
      globalThis.clearInterval(h as ReturnType<typeof globalThis.setInterval>);
    },
  };

  // 1. Acquire the lease. A `null` here means another instance got there
  //    first — the server probably re-delivered the elicitation. Decline
  //    politely so the original holder can finish its flow.
  const lease = await acquireMcpElicitationLease(
    params.redis,
    {
      elicitationId: params.request.elicitationId,
      executorInstanceId: params.executorInstanceId,
      stepExecutionId: params.stepExecutionId,
      tenantId: params.tenantId,
      bindingId: params.bindingId,
      serverId: params.serverId,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    },
    { ttlMs: params.leaseTtlMs },
  );
  if (!lease) {
    params.log?.warn?.('[mcp-elicitation] lease conflict — declining duplicate request', {
      elicitationId: params.request.elicitationId,
    });
    return { kind: 'lease_conflict' };
  }

  // Slot must release AFTER the lease is held — otherwise an immediate
  // crash here would leave a step paused with no lease record for the
  // reconciler to find.
  const slot = params.slotController;
  slot?.release();

  // Heartbeat + timeout state — declared up front so the cleanup path
  // can clear them unconditionally.
  let heartbeatHandle: unknown = null;
  let timeoutHandle: unknown = null;
  let unsubscribe: (() => Promise<void>) | undefined;
  let registeredAborter: (() => void) | undefined;

  try {
    // 2. Subscribe to the response channel FIRST — Redis Pub/Sub drops
    //    any message published on a channel before SUBSCRIBE completes,
    //    so an orchestrator that fast-publishes a response (auto-responder,
    //    tight test loop) would otherwise leave us hanging until lease
    //    timeout. We resolve the outcome via a closure-captured `settle`,
    //    then publish, then await the race.
    let settle!: (o: SuspendOutcome) => void;
    let settled = false;
    const outcomePromise = new Promise<SuspendOutcome>((resolve) => {
      settle = (o: SuspendOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(o);
      };
    });

    try {
      unsubscribe = await subscribeMcpElicitationResponse(
        params.redisSubscriber,
        params.request.elicitationId,
        (response) => {
          if (response.elicitationId !== params.request.elicitationId) return;
          // Defense-in-depth: response channel keyed only by elicitationId,
          // so cross-tenant leakage isn't structurally prevented at the
          // channel layer. Reject responses whose tenantId, when present,
          // doesn't match the suspended call's tenant. Legacy responses
          // without `tenantId` accepted for backwards-compat — the channel
          // is internal-only.
          if (response.tenantId && response.tenantId !== params.tenantId) {
            params.log?.warn?.(`[mcp-elicitation] rejecting response with mismatched tenantId`, {
              elicitationId: params.request.elicitationId,
              expected: params.tenantId,
              got: response.tenantId,
            });
            return;
          }
          settle({ kind: 'resolved', response });
        },
      );
    } catch {
      // Subscribe setup failed — treat as lease-lost so the orchestrator's
      // reconciler eventually fails the step. The lease is still held in
      // Redis but the finally below releases it.
      return { kind: 'lease_lost' };
    }

    // 3. Now safe to publish the request envelope — the subscriber is
    //    live, no message can be missed.
    const envelope: McpElicitationRequestEnvelope = {
      request: params.request,
      tenantId: params.tenantId,
      stepExecutionId: params.stepExecutionId,
      bindingId: params.bindingId,
      serverId: params.serverId,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      executorInstanceId: params.executorInstanceId,
      leaseExpiresAt: lease.leaseExpiresAt,
      ts: new Date().toISOString(),
    };
    publishMcpElicitationRequest(params.redis, envelope);

    // 4. Register the abort callback with the pool entry (if provided)
    //    so a teardown of the warm session settles us as `lease_lost`
    //    before the transport disappears. Removal happens in the
    //    finally so abort never fires after the handler has already
    //    settled some other way.
    if (params.abortRegistry) {
      registeredAborter = (): void => {
        settle({ kind: 'lease_lost' });
      };
      params.abortRegistry.add(registeredAborter);
    }

    // 5. Arm the timeout + heartbeat alongside the in-flight subscription.
    timeoutHandle = timer.setTimeout(() => {
      settle({ kind: 'timeout' });
    }, params.leaseTtlMs);

    const heartbeatMs = Math.max(
      MIN_HEARTBEAT_MS,
      Math.floor(params.leaseTtlMs / HEARTBEAT_DIVISOR),
    );
    // Wrap the async heartbeat in a void-returning thunk — setInterval
    // expects `() => void`, and passing an async function leaks a
    // floating promise that no caller awaits.
    heartbeatHandle = timer.setInterval(() => {
      void (async (): Promise<void> => {
        const ok = await refreshMcpElicitationLease(
          params.redis,
          params.request.elicitationId,
          params.executorInstanceId,
          params.leaseTtlMs,
        ).catch(() => false);
        if (!ok) settle({ kind: 'lease_lost' });
      })();
    }, heartbeatMs);

    return await outcomePromise;
  } finally {
    // Remove the aborter from the pool entry's registry — if we never
    // registered one (no `abortRegistry` passed) this is a no-op. Done
    // first so a concurrent pool teardown can't fire it after we've
    // committed to the chosen outcome.
    if (registeredAborter && params.abortRegistry) {
      params.abortRegistry.delete(registeredAborter);
    }
    // Tear down timers + subscription unconditionally. Stop emitting
    // side effects before re-acquiring the slot so back-pressure on
    // acquire doesn't keep firing heartbeats.
    if (heartbeatHandle !== null) timer.clearInterval(heartbeatHandle);
    if (timeoutHandle !== null) timer.clearTimeout(timeoutHandle);
    if (unsubscribe) {
      try {
        await unsubscribe();
      } catch {
        /* best-effort */
      }
    }

    // 5. Release the lease FIRST — `outcomePromise` has settled, the
    //    lease has no further purpose, and keeping it held during a
    //    potentially-slow slot reacquire would block a peer trying to
    //    handle a re-delivery (they'd get `lease_conflict` and decline,
    //    which is a worse user experience than just letting them in).
    //    CAS-guarded — safe even if heartbeat detected a CAS-failure
    //    earlier (we're idempotent on missing/foreign keys).
    try {
      await releaseMcpElicitationLease(
        params.redis,
        params.request.elicitationId,
        params.executorInstanceId,
      );
    } catch {
      /* best-effort; lease will expire on its own */
    }

    // 6. Re-acquire the slot before returning to the SDK. The remaining
    //    work (sending the response, awaiting the final tool result) is
    //    bounded I/O and should count against the concurrency budget
    //    like a normal call. May block under high contention — fine,
    //    the lease is already free.
    try {
      await slot?.acquire();
    } catch {
      /* slot.acquire shouldn't throw, but never let it bubble */
    }
  }
}

export function outcomeToElicitResult(outcome: SuspendOutcome): {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, string | number | boolean | string[]>;
} {
  if (outcome.kind === 'resolved') {
    return outcome.response.content
      ? { action: outcome.response.action, content: outcome.response.content }
      : { action: outcome.response.action };
  }
  if (outcome.kind === 'lease_conflict') return { action: 'decline' };
  return { action: 'cancel' };
}
