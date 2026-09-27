import type { Redis } from 'ioredis';
import {
  appendSessionEvent,
  setMcpElicitationRequest,
  subscribeMcpElicitationRequests,
  type SessionEvent,
  type McpElicitationRequestEnvelope,
} from '@aflow/redis';
import { getOrchestratorLogger } from '../lib/orchestratorLogger.js';

export interface McpElicitationRouterOptions {
  redis: Redis;
  /** Dedicated pub/sub subscriber connection. MUST NOT be the primary. */
  subscriberRedis: Redis;
}

/**
 * Start the elicitation request subscriber. Returns an `unsubscribe`
 * function that the orchestrator's shutdown handler must invoke.
 */
export async function startMcpElicitationRouter(
  opts: McpElicitationRouterOptions,
): Promise<() => Promise<void>> {
  const log = getOrchestratorLogger();
  log.info('Starting MCP elicitation router');

  const unsubscribe = await subscribeMcpElicitationRequests(opts.subscriberRedis, (envelope) => {
    // Best-effort handle — don't await; the subscriber callback should
    // not block the pub/sub event loop. Errors swallowed (and logged)
    // because the lease is the durable backstop: if we miss this
    // envelope entirely, the executor's lease will expire and surface
    // as `elicitation_timeout` on the user side.
    void handleEnvelope(opts.redis, envelope).catch((err: unknown) => {
      log.warn('[mcp-elicitation] failed to handle request envelope', {
        elicitationId: envelope.request.elicitationId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  return unsubscribe;
}

async function handleEnvelope(
  redis: Redis,
  envelope: McpElicitationRequestEnvelope,
): Promise<void> {
  // Compute lease TTL from the envelope's `leaseExpiresAt` (ISO) — we
  // don't get it directly but the difference vs now is the slack the
  // request key needs.
  const leaseTtlMs = Math.max(0, new Date(envelope.leaseExpiresAt).getTime() - Date.now());

  // 1. Persist the request for the response route to validate against.
  //    Even for workflow-task dispatch (no sessionId) we keep this — a
  //    future headless responder can find it by elicitationId. Carry
  //    sessionId + stepExecutionId so the route can verify the URL's
  //    :sessionId matches the elicitation's actual home (defense
  //    against tenant-internal cross-session access).
  await setMcpElicitationRequest(
    redis,
    envelope.request,
    {
      tenantId: envelope.tenantId,
      stepExecutionId: envelope.stepExecutionId,
      ...(envelope.sessionId ? { sessionId: envelope.sessionId } : {}),
    },
    leaseTtlMs,
  );

  // 2. Emit the SSE event so the run UI surfaces the prompt. Skip when
  //    the call is workflow-task-dispatched — there's no session stream
  //    to render into; the future headless surface will handle that path.
  if (!envelope.sessionId) return;

  const event: SessionEvent = {
    eventId: crypto.randomUUID(),
    eventType: 'McpElicitationRequested',
    timestamp: Date.now(),
    sessionId: envelope.sessionId,
    stepExecutionId: envelope.stepExecutionId,
    stepType: 'mcp',
    metadata: {
      elicitationId: envelope.request.elicitationId,
      bindingId: envelope.bindingId,
      serverId: envelope.serverId,
      // Inline the request body so the UI can render directly off the
      // event without a second lookup. Bounded by the upstream MCP
      // server's payload size limits — typical form schemas are <2KB.
      request: envelope.request as unknown as Record<string, unknown>,
      leaseExpiresAt: envelope.leaseExpiresAt,
      executorInstanceId: envelope.executorInstanceId,
    },
  };
  await appendSessionEvent(redis, envelope.tenantId, envelope.sessionId, event);
}
