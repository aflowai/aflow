import type { FastifyInstance } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, inArray } from 'drizzle-orm';
import { createTenantContext, sessions, withTenantSchema } from '@aflow/database';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  CatchUpDeltaSchema,
  PresenceParticipantSchema,
  ClientMessageIdSchema,
  ROOM_MESSAGE_MAX_LENGTH,
  SessionIdSchema,
  type ActorContext,
  type SessionId,
  type StepExecutionId,
  type TenantId,
} from '@aflow/schemas';
import {
  buildCatchUpDelta,
  getSessionStateSafe,
  getStepState,
  markSeen,
  readPresenceForSessions,
  type SessionHotState,
} from '@aflow/redis';
import type { SessionService } from '../services/sessions.js';
import { buildActorContext } from '../utils/actorContext.js';
import { classifyRunServiceError, ForbiddenError } from '../lib/errors.js';
import { assertSessionSpaceAccess } from '../lib/sessionSpaceAccess.js';
import { recordSpeechJoin } from '../lib/sessionMembership.js';

/** The only pause a wake may advance: the agent waiting for what to do next. */
const AGENT_TURN_OPERATION_ID = 'ai.agent.turn';

const PostRoomMessageRequestSchema = z.object({
  body: z.string().min(1).max(ROOM_MESSAGE_MAX_LENGTH),
  clientMessageId: ClientMessageIdSchema.optional(),
  /**
   * Whether to ask the agent to act on the room as well as speak into it.
   *
   * Defaults to false: talking is free, and advancing a run is the governed
   * act. A team can discuss for as long as it likes and then one person says
   * go.
   */
  wake: z.boolean().optional(),
});

const PostRoomMessageResponseSchema = z.object({
  messageSeq: z.number().int().positive(),
  eventId: z.string(),
  postedAt: z.string(),
  /**
   * Whether the agent was set going by this message. False for a plain post,
   * and false for a wake that arrived while the agent was already working —
   * it will read the room at its next turn either way.
   */
  woke: z.boolean(),
});

/**
 * Talking in a room is separate from driving the agent.
 *
 * Every other write to a session advances it — start, resume, retry. This one
 * appends and stops, so a teammate can say something while the agent is
 * mid-turn or parked on an approval without forcing a turn or waiting for one
 * to end.
 */
export function registerSessionRoomMessageRoutes(
  fastify: FastifyInstance,
  sessionService: SessionService,
): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /v1/sessions/presence?sessionIds=… — who is in each of these rooms.
  //
  // Space-scoped rather than per-session: the Workbench asks about a list, and
  // a request per row would be a round trip per row.
  app.get(
    '/presence',
    {
      config: {
        authz: { resource: 'session', action: 'read', spaceIdFrom: 'requireSpace' },
      },
      schema: {
        tags: ['Sessions'],
        summary: 'Who is currently in each of the given rooms',
        querystring: z.object({
          sessionIds: z.string().min(1).max(2000),
          spaceId: z.string().uuid().optional(),
        }),
        response: {
          200: z.object({
            rooms: z.record(z.array(PresenceParticipantSchema)),
            unread: z.record(z.number().int().nonnegative()),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const redis = fastify.appContext.redis;
      if (!redis) {
        reply.send({ rooms: {}, unread: {} });
        return;
      }

      // Only rooms in the caller's own space — presence says who is looking at
      // something, which is itself a fact about that thing.
      const requested = request.query.sessionIds.split(',').filter(Boolean).slice(0, 50);
      const ownedBySpace = await filterSessionsInSpace(
        fastify,
        tenant.tenantId,
        space.spaceId,
        requested,
      );

      const userId = request.authUser?.userId;
      const unread: Record<string, number> = {};
      if (userId) {
        // Peeked, never marked: looking at a list of rooms is not reading
        // them, and advancing markers here would make the news vanish before
        // anyone opened the room it belonged to. Counting is arithmetic on
        // the room's own message positions, so a list of rooms costs a read
        // each rather than a walk each.
        await Promise.all(
          ownedBySpace.map(async (sessionId) => {
            const state = await getSessionStateSafe(redis, tenant.tenantId, sessionId);
            const { delta } = await buildCatchUpDelta(
              redis,
              tenant.tenantId,
              sessionId,
              userId,
              state.ok ? state.state : null,
            );
            if (delta.messagesFromOthers > 0) unread[sessionId] = delta.messagesFromOthers;
          }),
        );
      }

      reply.send({
        rooms: await readPresenceForSessions(redis, tenant.tenantId, ownedBySpace),
        unread,
      });
    },
  );

  // GET /v1/sessions/:sessionId/catch-up — what changed while you were away.
  //
  // Reading advances your marker, because the answer to "what did I miss" is
  // only true at the moment it is asked; leaving the marker behind would
  // repeat the same news on every visit.
  app.get(
    '/:sessionId/catch-up',
    {
      config: {
        authz: {
          resource: 'session',
          action: 'read',
          spaceIdFrom: 'requireSpace',
          resourceIdFrom: 'param',
        },
      },
      schema: {
        tags: ['Sessions'],
        summary: 'What changed in a session since you last looked',
        params: z.object({ sessionId: SessionIdSchema }),
        querystring: z.object({ spaceId: z.string().uuid().optional() }),
        response: {
          200: CatchUpDeltaSchema,
          403: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      await request.requireSpace();
      const { sessionId } = request.params;

      if (
        !(await assertSessionSpaceAccess(fastify, request, reply, { action: 'read', sessionId }))
      ) {
        return;
      }

      const redis = fastify.appContext.redis;
      const userId = request.authUser?.userId;
      if (!redis || !userId) {
        reply.send({
          hasNews: false,
          messagesFromOthers: 0,
          seenMessageSeq: 0,
          stepsCompleted: 0,
          stepsFailed: 0,
          awaitingInput: false,
        });
        return;
      }

      const state = await getSessionStateSafe(redis, tenant.tenantId, sessionId);
      const { delta, cursor } = await buildCatchUpDelta(
        redis,
        tenant.tenantId,
        sessionId,
        userId,
        state.ok ? state.state : null,
        // Entering a room is the one place worth walking the log for what the
        // run did while you were away.
        { scanActivity: true },
      );
      await markSeen(redis, tenant.tenantId, sessionId, userId, cursor);
      reply.send(delta);
    },
  );

  app.post(
    '/:sessionId/messages',
    {
      config: {
        authz: {
          resource: 'session',
          action: 'write',
          spaceIdFrom: 'requireSpace',
          resourceIdFrom: 'param',
        },
      },
      schema: {
        tags: ['Sessions'],
        summary: 'Post a message into a session room',
        description:
          'Append an attributed message to the session timeline without advancing the agent. ' +
          'Works while the agent is running, paused, or waiting. Use resume to advance the agent.',
        params: z.object({ sessionId: SessionIdSchema }),
        querystring: z.object({ spaceId: z.string().uuid().optional() }),
        body: PostRoomMessageRequestSchema,
        response: {
          200: PostRoomMessageResponseSchema,
          400: z.object({ error: z.string(), message: z.string() }),
          403: z.object({ error: z.string(), message: z.string() }),
          404: z.object({ error: z.string(), message: z.string() }),
          409: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const { sessionId } = request.params;

      try {
        // The space the caller presented is not necessarily the space the
        // session lives in — it is resolved from a request header. Without
        // this the room would be writable from any space in the tenant, and
        // the agent reads room messages, so it would be an injection channel
        // into another team's work.
        if (
          !(await assertSessionSpaceAccess(fastify, request, reply, { action: 'write', sessionId }))
        ) {
          return;
        }

        const actorContext = buildActorContext(request, tenant, space);
        if (!actorContext) {
          throw new ForbiddenError('An identified actor is required to post a message');
        }

        const result = await sessionService.postRoomMessage({
          tenantId: tenant.tenantId,
          sessionId: sessionId as SessionId,
          body: request.body.body,
          actorContext,
          ...(request.body.wake ? { wakeHelmsman: true } : {}),
          ...(request.body.clientMessageId
            ? { clientMessageId: request.body.clientMessageId }
            : {}),
        });

        void recordSpeechJoin(fastify, tenant.tenantId, sessionId, actorContext.userId);

        // A wake carries no payload of its own: the message is already in the
        // room and the agent reads the room. So this only has to set a resting
        // run going — a running one reaches the same messages at its next turn
        // boundary, which is what keeps "no live in-turn injection" true.
        const woke = request.body.wake
          ? await wakeAgent(
              fastify,
              sessionService,
              tenant.tenantId,
              sessionId,
              actorContext,
              result.eventId,
            )
          : false;

        reply.send({ ...result, woke });
      } catch (err) {
        request.log.error({ err, sessionId }, 'Failed to post room message');
        throw classifyRunServiceError(err);
      }
    },
  );
}

/**
 * Whether a wake may advance this run.
 *
 * A wake carries no answer — the message is in the room, and the agent reads
 * the room. That is only true when the thing the run is waiting for IS the
 * agent's next turn. Every other pause is waiting for a specific answer from a
 * specific person: an approval, a sub-agent's question, a credential. Resuming
 * one of those with an empty payload does not decline to answer it, it answers
 * it emptily — a decision-less resume of an approval step reads as approved,
 * so "hmm, not sure about this" would ship the thing it doubted. Those pauses
 * keep their own rails; a wake leaves them exactly as it found them.
 */
export function mayWake(
  runState: Pick<SessionHotState, 'status' | 'delegationPauseSource' | 'currentStepExecutionId'>,
  pausedStep: { operationId: string } | null,
): boolean {
  if (runState.status !== 'PAUSED') return false;
  // Waiting on a child's question: the resume is forwarded to the child, whose
  // room is not this one, so the answer would never reach whoever asked.
  if (runState.delegationPauseSource) return false;
  if (!runState.currentStepExecutionId) return false;
  return pausedStep?.operationId === AGENT_TURN_OPERATION_ID;
}

/**
 * Set a resting run going, so a wake lands as a turn rather than a message
 * nobody reads until someone clicks resume.
 */
async function wakeAgent(
  fastify: FastifyInstance,
  sessionService: SessionService,
  tenantId: TenantId,
  sessionId: string,
  actorContext: ActorContext,
  eventId: string,
): Promise<boolean> {
  const redis = fastify.appContext.redis;
  if (!redis) return false;

  const state = await getSessionStateSafe(redis, tenantId, sessionId);
  if (!state.ok) return false;
  const stepExecutionId = state.state.currentStepExecutionId;
  const step = stepExecutionId ? await getStepState(redis, tenantId, stepExecutionId) : null;
  if (!mayWake(state.state, step) || !stepExecutionId) return false;

  await sessionService.resumeSession({
    tenantId,
    sessionId: sessionId as SessionId,
    stepExecutionId: stepExecutionId as StepExecutionId,
    // No payload: the message is in the room and the agent reads the room.
    // Sending it here as well would put it in front of the agent twice, once
    // attributed and once not.
    input: {},
    idempotencyKey: `wake:${eventId}`,
    actorContext,
  });
  return true;
}

/**
 * Narrow a caller-supplied list of session ids to the ones that actually live
 * in their space.
 *
 * Knowing who is looking at something is knowing something about it, so a
 * roster is gated exactly like the room it describes. The ids arrive from the
 * client, and a tenant has many spaces.
 */
async function filterSessionsInSpace(
  fastify: FastifyInstance,
  tenantId: string,
  spaceId: string,
  sessionIds: string[],
): Promise<string[]> {
  const db = fastify.appContext.db as PostgresJsDatabase | null;
  if (!db || sessionIds.length === 0) return [];

  const rows = await withTenantSchema(db, createTenantContext(tenantId as TenantId), async (tx) =>
    tx
      .select({ sessionId: sessions.sessionId })
      .from(sessions)
      .where(and(eq(sessions.spaceId, spaceId), inArray(sessions.sessionId, sessionIds))),
  );
  return rows.map((r) => r.sessionId);
}
