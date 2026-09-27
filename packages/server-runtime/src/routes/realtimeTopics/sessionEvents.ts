import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from 'ioredis';
import {
  type ApiSessionEvent,
  type ReconcileReason,
  type SessionEventsTopic,
  type SessionId,
  type TenantId,
} from '@aflow/schemas';
import { buildSessionCatchupEvents } from '../../services/workflowRunCatchup.js';
import { createSessionTailService, SessionTailReconcileError } from '../../services/sessionTail.js';
import type {
  LatestResult,
  SessionTailService,
  TailAfterResult,
} from '../../services/sessionTail.js';
import type { PubSubSubscriber } from '../../services/pubsub.js';
import type { TopicHandler, TopicSubscribeContext, TopicSubscribeResult } from '../realtime.js';
import { canReadSession } from './authz.js';

/**
 * Events delivered when a session is opened.
 *
 * A turn emits several, so this is a bound on the page rather than on the
 * conversation — `hasOlder` reports what sits behind it.
 */
const MOUNT_PAGE = 500;

export interface SessionEventsTopicDeps {
  db: PostgresJsDatabase;
  redis: Redis | null;
  payloadStore: PayloadStore | null;
  pubsubSubscriber: PubSubSubscriber | null;
}

/**
 * Which end of the history a subscriber gets.
 *
 * A subscriber holding a cursor is resuming and wants what followed it. One
 * without a cursor is opening the session fresh and wants its END: asking for a
 * page from the start answers with the oldest events and then tails live from
 * the newest, so everything between the two is unreachable — the longer the
 * session, the more of it goes missing.
 *
 * Extracted so that choice is assertable without standing up a database, a
 * Redis, and a socket.
 */
export async function readForSubscribe(
  tailService: Pick<SessionTailService, 'tailAfter' | 'tailBefore'>,
  tenantId: TenantId,
  sessionId: SessionId,
  cursor: string | undefined,
  limit: number = MOUNT_PAGE,
): Promise<
  | TailAfterResult
  | LatestResult
  | { kind: 'reconcile_required'; reason: ReconcileReason; cursor?: string }
> {
  // `undefined` as the backward position means "from the end", which is the
  // newest page — the same read a scroll-back uses, entered at its start.
  return cursor === undefined
    ? tailService.tailBefore(tenantId, sessionId, undefined, { limit })
    : tailService.tailAfter(tenantId, sessionId, cursor, { limit });
}

export function createSessionEventsTopicHandler(deps: SessionEventsTopicDeps): TopicHandler {
  const tailService = createSessionTailService({
    db: deps.db,
    redis: deps.redis,
    pubsubSubscriber: deps.pubsubSubscriber,
  });

  return {
    kind: 'session.events',
    async subscribe(ctx: TopicSubscribeContext): Promise<TopicSubscribeResult> {
      if (ctx.topic.kind !== 'session.events') {
        // Type guard — registry routes by kind so this is unreachable.
        return { kind: 'not_supported' };
      }
      const topic: SessionEventsTopic = ctx.topic;
      const tenantId = ctx.connection.tenantId as TenantId;
      const sessionId = topic.sessionId as SessionId;

      if (topic.tenantId && topic.tenantId !== tenantId) {
        return {
          kind: 'denied',
          code: 'subscribe_denied',
          message: 'session.events tenantId must match connection tenant',
        };
      }

      const userId = ctx.connection.userId;
      const allowed = await canReadSession(
        deps.db,
        deps.redis,
        tenantId,
        userId,
        sessionId,
        ctx.connection.token.authMethod,
      );
      if (!allowed) {
        // Gated diagnostic (NOT shipped to the client). Captures the
        // (tenant, user, session) tuple that was denied so the
        // "Connecting to agent…" stuck-state can be diagnosed in
        // `yarn dev:core` logs. Gated behind `REALTIME_VERBOSE_LOGS=1`
        // because the tuple is identifier-bearing and we don't want it
        // in steady-state production logs — only opt-in during a repro.
        // The public reply is deliberately opaque to avoid leaking
        // session existence to attackers regardless of log gate.
        if (process.env['REALTIME_VERBOSE_LOGS'] === '1') {
          console.warn(
            `[session.events] subscribe_denied tenantId=${tenantId} userId=${userId} sessionId=${sessionId}`,
          );
        }
        return {
          kind: 'denied',
          code: 'subscribe_denied',
          // Same opaque message regardless of "session not found" vs.
          // "user lacks read access" — never leak existence of a
          // session the user can't see.
          message: 'No read access to this session',
        };
      }

      const initialCursor: string | undefined = topic.cursor;
      const abortController = new AbortController();
      let liveTask: Promise<void> | null = null;

      const start = async () => {
        let runningCursor: string = initialCursor ?? '';
        let emittedCount = 0;
        // Handed to the live tail so its buffer reader sees the run state this
        // page already described — a task running before the tail existed is
        // one whose feed the reader must know to read.
        const seedEvents: ApiSessionEvent[] = [];
        try {
          const drain = await readForSubscribe(tailService, tenantId, sessionId, initialCursor);
          if ('kind' in drain && drain.kind === 'reconcile_required') {
            ctx.emit({
              type: 'reconcile_required',
              subscriptionId: ctx.subscriptionId,
              topicKey: ctx.topicKey,
              reason: drain.reason,
              ...(drain.cursor ? { cursor: drain.cursor } : {}),
            });
            return;
          }
          for (const [i, event] of drain.events.entries()) {
            if (abortController.signal.aborted) return;
            // The reader's position for this event, never the event's id: an
            // event id is not seekable, and resuming from one is refused.
            const cursor = drain.eventCursors[i] ?? drain.nextCursor;
            ctx.emit({
              type: 'event',
              subscriptionId: ctx.subscriptionId,
              topicKey: ctx.topicKey,
              cursor,
              event,
            });
            runningCursor = cursor;
            emittedCount++;
            seedEvents.push(event);
          }
          // The reader can advance without emitting anything — a page of
          // envelopes this revision cannot parse. Taking its position after the
          // loop, rather than only from the last emitted event, is what stops
          // the live tail below from restarting on the page just stepped over.
          if (drain.nextCursor.length > 0) runningCursor = drain.nextCursor;
          if (process.env['REALTIME_VERBOSE_LOGS'] === '1') {
            console.info(
              `[session.events] subscribe drain sessionId=${sessionId} initialCursor=${
                initialCursor ?? 'null'
              } drainedEvents=${String(drain.events.length)} runningCursor=${
                runningCursor || 'empty'
              }`,
            );
          }
        } catch (err) {
          console.warn('[session.events] initial drain failed', err);
          return;
        }

        if (!topic.skipCatchup && deps.payloadStore) {
          try {
            const allowedSpaces = ctx.connection.token.allowedSpaceIds;
            if (allowedSpaces?.length === 1) {
              const catchup = await buildSessionCatchupEvents(
                deps.db,
                deps.payloadStore,
                tenantId,
                sessionId,
                allowedSpaces[0]!,
                deps.redis,
              );
              for (const event of catchup.events) {
                if (abortController.signal.aborted) return;
                ctx.emit({
                  type: 'event',
                  subscriptionId: ctx.subscriptionId,
                  topicKey: ctx.topicKey,
                  cursor: runningCursor,
                  event,
                });
                seedEvents.push(event);
              }
            }
          } catch (err) {
            console.warn('[session.events] catch-up failed; falling back to live-only', err);
          }
        }

        // Live tail — durable events and the in-flight step's partial output on
        // one subscription and one loop. Live frames carry no cursor, so they
        // never move the client's resume position; the durable event's terminal
        // for a step is always emitted before any late live frame for it. The
        // abort controller drives cleanup; we hold the promise so `cleanup` can
        // await it on close.
        liveTask = (async () => {
          try {
            for await (const item of tailService.live(tenantId, sessionId, {
              cursor: runningCursor,
              signal: abortController.signal,
              seedEvents,
            })) {
              if (abortController.signal.aborted) return;
              if (item.kind === 'live_delta') {
                ctx.emit({
                  type: 'live_delta',
                  subscriptionId: ctx.subscriptionId,
                  topicKey: ctx.topicKey,
                  stepExecutionId: item.frame.stepExecutionId,
                  channel: item.frame.channel,
                  offset: item.frame.offset,
                  delta: item.frame.delta,
                });
                continue;
              }
              const event = item.event;
              ctx.emit({
                type: 'event',
                subscriptionId: ctx.subscriptionId,
                topicKey: ctx.topicKey,
                cursor: item.cursor,
                event,
              });
              runningCursor = item.cursor;
              emittedCount++;
              if (process.env['REALTIME_VERBOSE_LOGS'] === '1' && emittedCount % 5 === 1) {
                console.info(
                  `[session.events] live emit sessionId=${sessionId} eventType=${
                    event.eventType
                  } cursor=${item.cursor} total=${String(emittedCount)}`,
                );
              }
            }
          } catch (err) {
            if (err instanceof SessionTailReconcileError) {
              ctx.emit({
                type: 'reconcile_required',
                subscriptionId: ctx.subscriptionId,
                topicKey: ctx.topicKey,
                reason: err.reason,
                ...(err.cursor ? { cursor: err.cursor } : {}),
              });
            } else if (!abortController.signal.aborted) {
              console.warn('[session.events] live tail errored', err);
            }
          }
        })();
      };

      return {
        kind: 'accepted',
        ...(initialCursor ? { cursor: initialCursor } : {}),
        start,
        cleanup: async () => {
          abortController.abort();
          if (liveTask) await liveTask;
        },
      };
    },
  };
}
