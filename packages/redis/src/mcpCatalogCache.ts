import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';

export interface McpCatalogInvalidation {
  kind: 'definition' | 'binding' | 'tool_cache';
  tenantId: string;
  spaceId: string;
  /** MCP server identifier (when scoped to a single server). */
  serverId?: string;
  /** Binding identifier (when scoped to a single binding's tool cache). */
  bindingId?: string;
  ts: number;
}

/**
 * Publish a cache invalidation signal after an MCP definition/binding/tool-cache
 * mutation. Fire-and-forget — failures are silently swallowed.
 */
export function publishMcpCatalogInvalidation(
  redis: Redis,
  tenantId: string,
  spaceId: string,
  payload: { kind: McpCatalogInvalidation['kind']; serverId?: string; bindingId?: string },
): void {
  const channel = StreamKeys.mcpCatalogInvalidateChannel(tenantId);
  const message: McpCatalogInvalidation = {
    kind: payload.kind,
    tenantId,
    spaceId,
    ts: Date.now(),
    ...(payload.serverId ? { serverId: payload.serverId } : {}),
    ...(payload.bindingId ? { bindingId: payload.bindingId } : {}),
  };
  redis.publish(channel, JSON.stringify(message)).catch(() => {
    // Best-effort — TTL cache is the fallback.
  });
}

export type McpCatalogInvalidationCallback = (msg: McpCatalogInvalidation) => void;

/**
 * Subscribe to MCP catalog invalidation signals for all tenants.
 * Uses pattern subscribe (`aflow:pubsub:mcp-catalog:*`).
 *
 * IMPORTANT: `subscriberRedis` must be dedicated to Pub/Sub — once a connection
 * enters subscriber mode it cannot issue regular commands.
 *
 * Returns an unsubscribe function for cleanup.
 */
export async function subscribeMcpCatalogInvalidation(
  subscriberRedis: Redis,
  callback: McpCatalogInvalidationCallback,
): Promise<() => Promise<void>> {
  const pattern = 'aflow:pubsub:mcp-catalog:*';

  // Named handler so the unsubscribe path can remove THIS specific listener
  // (no leak across repeated subscribe/unsubscribe — hot reload, tests).
  const handler = (_pattern: string, _channel: string, message: string) => {
    try {
      const parsed = JSON.parse(message) as Partial<McpCatalogInvalidation>;
      if (typeof parsed.tenantId !== 'string' || typeof parsed.spaceId !== 'string') return;
      if (parsed.spaceId.length === 0) return;
      callback(parsed as McpCatalogInvalidation);
    } catch {
      // Malformed message — ignore.
    }
  };

  subscriberRedis.on('pmessage', handler);
  await subscriberRedis.psubscribe(pattern);

  return async () => {
    subscriberRedis.off('pmessage', handler);
    await subscriberRedis.punsubscribe(pattern);
  };
}
