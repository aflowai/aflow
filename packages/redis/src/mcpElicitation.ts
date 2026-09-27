import type { Redis } from 'ioredis';
import {
  StreamKeys,
  McpElicitationRequestSchema,
  McpElicitationResponseSchema,
  type McpElicitationRequest,
  type McpElicitationResponse,
} from '@aflow/schemas';

// ============================================================================
// Request channel (executor → orchestrator)
// ============================================================================

/**
 * Envelope for the executor→orchestrator request publish. Wraps the SDK-
 * normalized `McpElicitationRequest` with the routing context the
 * orchestrator needs to find the right session + emit the session event.
 */
export interface McpElicitationRequestEnvelope {
  /** Carries the elicitationId + mode-specific payload. */
  request: McpElicitationRequest;
  tenantId: string;
  /** Step that owns the in-flight `mcp.tool.call`. */
  stepExecutionId: string;
  /** Set for session-scoped runs; absent for workflow-task dispatch. */
  sessionId?: string;
  bindingId: string;
  serverId: string;
  /** Executor instance ID that holds the warm session. */
  executorInstanceId: string;
  /** ISO timestamp the lease expires (mirrors the Redis TTL). */
  leaseExpiresAt: string;
  /** ISO publish time — for monotonic ordering at the orchestrator. */
  ts: string;
}

export function publishMcpElicitationRequest(
  redis: Redis,
  envelope: McpElicitationRequestEnvelope,
): void {
  const channel = StreamKeys.mcpElicitationRequestChannel(envelope.tenantId);
  redis.publish(channel, JSON.stringify(envelope)).catch(() => {
    // Best-effort; the lease + boot reconciler are the durability backstop.
  });
}

export type McpElicitationRequestCallback = (msg: McpElicitationRequestEnvelope) => void;

/**
 * Subscribe to elicitation requests for ALL tenants. Pattern-subscribe so a
 * single orchestrator subscriber handles every tenant without per-tenant
 * setup. `subscriberRedis` MUST be dedicated to pub/sub.
 */
export async function subscribeMcpElicitationRequests(
  subscriberRedis: Redis,
  callback: McpElicitationRequestCallback,
): Promise<() => Promise<void>> {
  const pattern = 'aflow:pubsub:mcp-elicitation-request:*';
  subscriberRedis.on('pmessage', (_p: string, _channel: string, message: string) => {
    try {
      const parsed = JSON.parse(message) as McpElicitationRequestEnvelope;
      if (!parsed?.request) return;
      const reqCheck = McpElicitationRequestSchema.safeParse(parsed.request);
      if (!reqCheck.success) return;
      callback(parsed);
    } catch {
      // Malformed payload — ignore.
    }
  });
  await subscriberRedis.psubscribe(pattern);
  return async () => {
    await subscriberRedis.punsubscribe(pattern);
  };
}

// ============================================================================
// Response channel (orchestrator → executor)
// ============================================================================

/**
 * Publish a user response to the leaseholder executor. Per-elicitation
 * channel — only the suspended handler for THIS id subscribes, so no
 * fanout filtering is needed.
 *
 * Fire-and-forget. If the holder has died between subscribe and publish,
 * the lease TTL will eventually expire and the orchestrator can transition
 * the paused step to `elicitation_executor_lost`.
 */
export function publishMcpElicitationResponse(
  redis: Redis,
  response: McpElicitationResponse,
): void {
  const channel = StreamKeys.mcpElicitationResponseChannel(response.elicitationId);
  redis.publish(channel, JSON.stringify(response)).catch(() => {
    // Best-effort.
  });
}

/**
 * Subscribe to a single elicitationId's response. Returns an unsubscribe
 * function — the caller (the suspended request handler) is responsible
 * for invoking it on resolve or on lease loss.
 *
 * `subscriberRedis` MUST be dedicated to pub/sub. Multiple concurrent
 * elicitations on the same executor instance each get their own
 * subscription via SUBSCRIBE — the handler dispatches by elicitationId so
 * sharing one subscriberRedis is safe.
 */
export async function subscribeMcpElicitationResponse(
  subscriberRedis: Redis,
  elicitationId: string,
  callback: (response: McpElicitationResponse) => void,
): Promise<() => Promise<void>> {
  const channel = StreamKeys.mcpElicitationResponseChannel(elicitationId);
  const handler = (msgChannel: string, message: string): void => {
    if (msgChannel !== channel) return;
    try {
      const parsed = McpElicitationResponseSchema.safeParse(JSON.parse(message));
      if (!parsed.success) return;
      callback(parsed.data);
    } catch {
      // Malformed payload — ignore.
    }
  };
  subscriberRedis.on('message', handler);
  await subscriberRedis.subscribe(channel);
  return async () => {
    subscriberRedis.off('message', handler);
    await subscriberRedis.unsubscribe(channel);
  };
}
