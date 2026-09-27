/**
 * Redis Pub/Sub service for real-time event delivery.
 *
 * This provides:
 * - Publishing run events to Redis Pub/Sub channels
 * - Subscribing to run event channels for SSE/WebSocket delivery
 *
 * Pub/Sub is non-authoritative (best-effort) - used for low-latency wakeups.
 * The authoritative event source is always Postgres event_log.
 */
import type { Redis } from 'ioredis';
import { type TenantId, type SessionId, StreamKeys } from '@aflow/schemas';

// ============================================================================
// Types
// ============================================================================

export interface RunEventNotification {
  type: 'event';
  runId: SessionId;
  eventId: string;
  eventType: string;
  timestamp: string;
}

export interface RunStatusNotification {
  type: 'status';
  runId: SessionId;
  status: string;
  timestamp: string;
}

export type PubSubNotification = RunEventNotification | RunStatusNotification;

export type NotificationHandler = (notification: PubSubNotification) => void;

// ============================================================================
// Channel Names
// ============================================================================

/**
 * Get the Pub/Sub channel name for a run.
 * Delegates to StreamKeys for single-source-of-truth channel naming.
 */
export function getRunChannel(tenantId: TenantId, runId: SessionId): string {
  return StreamKeys.pubsubChannel(tenantId, runId);
}

/**
 * Get the Pub/Sub channel pattern for all runs in a tenant.
 */
export function getTenantRunPattern(tenantId: TenantId): string {
  return `aflow:pubsub:run:${tenantId}:*`;
}

// ============================================================================
// Publisher
// ============================================================================

export interface PubSubPublisher {
  /**
   * Publish a run event notification.
   */
  publishEvent(
    tenantId: TenantId,
    runId: SessionId,
    eventId: string,
    eventType: string,
  ): Promise<void>;

  /**
   * Publish a run status change notification.
   */
  publishStatus(tenantId: TenantId, runId: SessionId, status: string): Promise<void>;
}

/**
 * Create a Pub/Sub publisher.
 */
export function createPubSubPublisher(redis: Redis): PubSubPublisher {
  return {
    async publishEvent(tenantId, runId, eventId, eventType) {
      const channel = getRunChannel(tenantId, runId);
      const notification: RunEventNotification = {
        type: 'event',
        runId,
        eventId,
        eventType,
        timestamp: new Date().toISOString(),
      };
      await redis.publish(channel, JSON.stringify(notification));
    },

    async publishStatus(tenantId, runId, status) {
      const channel = getRunChannel(tenantId, runId);
      const notification: RunStatusNotification = {
        type: 'status',
        runId,
        status,
        timestamp: new Date().toISOString(),
      };
      await redis.publish(channel, JSON.stringify(notification));
    },
  };
}

// ============================================================================
// Subscriber
// ============================================================================

export interface PubSubSubscription {
  /**
   * Unsubscribe and clean up.
   */
  unsubscribe(): Promise<void>;
}

export interface PubSubSubscriber {
  /**
   * Subscribe to events for a specific run.
   */
  subscribeToRun(
    tenantId: TenantId,
    runId: SessionId,
    handler: NotificationHandler,
  ): Promise<PubSubSubscription>;

  /**
   * Subscribe to all run events for a tenant (pattern subscribe).
   */
  subscribeToTenant(tenantId: TenantId, handler: NotificationHandler): Promise<PubSubSubscription>;

  /**
   * Called after the subscriber connection comes back up.
   *
   * ioredis re-subscribes on reconnect, but anything published while the
   * connection was down is simply gone — Redis Pub/Sub has no backlog. A
   * subscriber that only reacts to messages therefore stays silently behind
   * for the rest of its life. This is the signal to re-read from the durable
   * cursor and close that gap.
   *
   * Returns an unsubscribe function.
   */
  onReconnect(handler: () => void): () => void;

  /**
   * Close the subscriber and clean up all subscriptions.
   */
  close(): Promise<void>;
}

/**
 * Create a Pub/Sub subscriber.
 *
 * Note: This creates a dedicated Redis connection for subscriptions
 * because Redis SUBSCRIBE blocks the connection.
 */
export function createPubSubSubscriber(): PubSubSubscriber {
  // Will be lazily initialized
  let subscriberRedis: Redis | null = null;
  const handlers = new Map<string, Set<NotificationHandler>>();
  const reconnectHandlers = new Set<() => void>();
  // The first `ready` is the initial connect, not a reconnect: subscribers
  // attach after it and have nothing to catch up on.
  let hasConnected = false;

  async function ensureSubscriber(): Promise<Redis> {
    if (!subscriberRedis) {
      // Built through the shared helper, not from the URL: a connection made
      // here would carry no AUTH password and no TLS policy.
      const { createSubscriberConnection, getRedisConfig } = await import('@aflow/redis');
      subscriberRedis = createSubscriberConnection({
        ...getRedisConfig(),
        connectionName: 'pubsub-subscriber',
      });

      subscriberRedis.on('ready', () => {
        if (!hasConnected) {
          hasConnected = true;
          return;
        }
        for (const handler of reconnectHandlers) {
          try {
            handler();
          } catch (err) {
            console.error('Pub/Sub reconnect handler error:', err);
          }
        }
      });

      // Handle incoming messages
      subscriberRedis.on('message', (channel: string, message: string) => {
        const channelHandlers = handlers.get(channel);
        if (channelHandlers) {
          try {
            const notification = JSON.parse(message) as PubSubNotification;
            for (const handler of channelHandlers) {
              try {
                handler(notification);
              } catch (err) {
                console.error('Pub/Sub handler error:', err);
              }
            }
          } catch (err) {
            // Malformed payloads are expected occasionally (race / non-JSON).
            console.debug('Failed to parse Pub/Sub message:', err);
          }
        }
      });

      // Handle pattern messages
      subscriberRedis.on('pmessage', (_pattern: string, channel: string, message: string) => {
        // Find handlers that match this channel via pattern
        for (const [registeredPattern, patternHandlers] of handlers) {
          if (
            registeredPattern.includes('*') &&
            channelMatchesPattern(channel, registeredPattern)
          ) {
            try {
              const notification = JSON.parse(message) as PubSubNotification;
              for (const handler of patternHandlers) {
                try {
                  handler(notification);
                } catch (err) {
                  console.error('Pub/Sub handler error:', err);
                }
              }
            } catch (err) {
              console.debug('Failed to parse Pub/Sub message:', err);
            }
          }
        }
      });
    }
    return subscriberRedis;
  }

  return {
    async subscribeToRun(tenantId, runId, handler) {
      const redis = await ensureSubscriber();
      const channel = getRunChannel(tenantId, runId);

      // Add handler
      let channelHandlers = handlers.get(channel);
      if (!channelHandlers) {
        channelHandlers = new Set();
        handlers.set(channel, channelHandlers);
        // First handler for this channel - subscribe
        await redis.subscribe(channel);
      }
      channelHandlers.add(handler);

      return {
        async unsubscribe() {
          channelHandlers.delete(handler);
          if (channelHandlers.size === 0) {
            handlers.delete(channel);
            await redis.unsubscribe(channel);
          }
        },
      };
    },

    async subscribeToTenant(tenantId, handler) {
      const redis = await ensureSubscriber();
      const pattern = getTenantRunPattern(tenantId);

      // Add handler
      let patternHandlers = handlers.get(pattern);
      if (!patternHandlers) {
        patternHandlers = new Set();
        handlers.set(pattern, patternHandlers);
        // First handler for this pattern - subscribe
        await redis.psubscribe(pattern);
      }
      patternHandlers.add(handler);

      return {
        async unsubscribe() {
          patternHandlers.delete(handler);
          if (patternHandlers.size === 0) {
            handlers.delete(pattern);
            await redis.punsubscribe(pattern);
          }
        },
      };
    },

    onReconnect(handler) {
      reconnectHandlers.add(handler);
      return () => {
        reconnectHandlers.delete(handler);
      };
    },

    async close() {
      reconnectHandlers.clear();
      if (subscriberRedis) {
        await subscriberRedis.quit();
        subscriberRedis = null;
      }
      handlers.clear();
    },
  };
}

/**
 * Check if a channel matches a glob pattern.
 */
function channelMatchesPattern(channel: string, pattern: string): boolean {
  // Simple glob matching - convert * to regex
  const regexPattern = pattern.replace(/\*/g, '.*');
  return new RegExp(`^${regexPattern}$`).test(channel);
}
