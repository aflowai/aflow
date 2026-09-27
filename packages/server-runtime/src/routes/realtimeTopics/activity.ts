import type { TopicHandler, TopicSubscribeContext, TopicSubscribeResult } from '../realtime.js';

// ============================================================================
// Subscriber registry
// ============================================================================

interface ActivitySubscriber {
  tenantId: string;
  sessionIds: Set<string>;
  runIds: Set<string>;
  /**
   * Per-subscription emit closure. The gateway wraps the inner shape
   * with the assigned `subscriptionId` + `topicKey` (see
   * `scopedEmit` in `realtime.ts`), so the broadcaster passes only
   * the cursor + event body and the routing snaps to the right
   * client subscription automatically.
   */
  emit: TopicSubscribeContext['emit'];
}

const subscribers = new Set<ActivitySubscriber>();

export interface ActivitySignal {
  tenantId: string;
  sessionId?: string;
  runId?: string;
  stepExecutionId?: string;
  stepType?: string;
  operationId?: string;
  label: string;
  source?: 'orchestrator' | 'executor' | 'ui';
  startedAtMs: number;
  ttlMs: number;
}

export function broadcastActivityToSubscribers(signal: ActivitySignal): void {
  for (const sub of subscribers) {
    if (sub.tenantId !== signal.tenantId) continue;
    const matchesSession = signal.sessionId !== undefined && sub.sessionIds.has(signal.sessionId);
    const matchesRun = signal.runId !== undefined && sub.runIds.has(signal.runId);
    if (!matchesSession && !matchesRun) continue;
    try {
      sub.emit({
        type: 'event',
        subscriptionId: '',
        topicKey: '',
        cursor: '',
        event: signal,
      });
    } catch {
      /* drop */
    }
  }
}

// ============================================================================
// Topic handler
// ============================================================================

const MAX_ACTIVITY_SUBSCRIPTIONS_PER_CONN_TOPIC = 64;

export function createActivityTopicHandler(): TopicHandler {
  return {
    kind: 'activity',
    // eslint-disable-next-line @typescript-eslint/require-await
    async subscribe(ctx: TopicSubscribeContext): Promise<TopicSubscribeResult> {
      if (ctx.topic.kind !== 'activity') {
        return { kind: 'not_supported' };
      }
      const sessionIds = new Set(ctx.topic.sessionIds ?? []);
      const runIds = new Set(ctx.topic.runIds ?? []);

      if (sessionIds.size + runIds.size > MAX_ACTIVITY_SUBSCRIPTIONS_PER_CONN_TOPIC) {
        return {
          kind: 'denied',
          code: 'too_many_targets',
          message: `activity subscription cap is ${String(MAX_ACTIVITY_SUBSCRIPTIONS_PER_CONN_TOPIC)} ids`,
        };
      }

      const entry: ActivitySubscriber = {
        tenantId: ctx.connection.tenantId,
        sessionIds,
        runIds,
        emit: ctx.emit,
      };
      subscribers.add(entry);

      return {
        kind: 'accepted',
        // eslint-disable-next-line @typescript-eslint/require-await
        cleanup: async () => {
          subscribers.delete(entry);
        },
      };
    },
  };
}

// Test-only — clears the registry.
export function __resetActivityRegistryForTests(): void {
  subscribers.clear();
}
