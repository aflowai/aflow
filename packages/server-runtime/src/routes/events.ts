import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  SessionIdSchema,
  type SessionId,
  type TenantId,
  ApiSessionEventSchema,
} from '@aflow/schemas';
import { createSessionService, type SessionService } from '../services/sessions.js';

const EventsPollingResponseSchema = z.object({
  events: z.array(ApiSessionEventSchema),
  nextCursor: z.string().optional(),
  hasMore: z.boolean(),
  /** Position for the next page BACK, absent when nothing older exists. */
  olderCursor: z.string().optional(),
  hasOlder: z.boolean().optional(),
});

export const eventsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const sessionService = createSessionService(app.appContext);

  app.addHook('preHandler', app.authenticate);

  // GET /v1/sessions/:sessionId/events — paginated JSON (no SSE)
  app.get(
    '/:sessionId/events',
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
        tags: ['Events'],
        summary: 'Poll session events (JSON)',
        description: `
Return a finite page of session events as JSON. Requires \`?limit=\`.

Direction is set by the cursor. \`?after=\` walks forward from a position;
\`?before=\` walks backward from one. **With neither, the page is the NEWEST
one** — a reader with no position wants the end of a history, and answering
with its beginning is what leaves the middle of a long session unreachable.

Live tail uses the realtime WebSocket \`session.events\` topic (Plan 170).
        `.trim(),
        params: z.object({
          sessionId: SessionIdSchema,
        }),
        querystring: z.object({
          after: z.string().optional(),
          before: z.string().optional(),
          limit: z.coerce.number().int().positive().max(1000),
          spaceId: z.string().uuid().optional(),
        }),
        headers: z.object({
          'last-event-id': z.string().optional(),
        }),
        response: {
          200: EventsPollingResponseSchema,
          400: z.object({
            error: z.string(),
            reason: z.string(),
            message: z.string(),
          }),
          410: z.object({
            error: z.string(),
            reason: z.string(),
            lastKnownCursor: z.string().optional(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      await request.requireSpace();
      const { sessionId } = request.params;
      const { after, before, limit } = request.query;
      const lastEventId = request.headers['last-event-id'] ?? after;

      if (lastEventId !== undefined && before !== undefined) {
        // Two directions at once has no meaning, and picking one silently would
        // hand back a page the caller cannot place.
        await reply.status(400).send({
          error: 'InvalidQuery',
          reason: 'conflicting_cursors',
          message: 'Pass `after` or `before`, not both.',
        });
        return;
      }

      if (lastEventId !== undefined) {
        return handlePollingMode(
          sessionService,
          tenant.tenantId,
          sessionId as SessionId,
          lastEventId,
          limit,
          reply,
        );
      }

      return handleBackwardMode(
        sessionService,
        tenant.tenantId,
        sessionId as SessionId,
        before,
        limit,
        reply,
      );
    },
  );
};

async function handlePollingMode(
  sessionService: SessionService,
  tenantId: TenantId,
  runId: SessionId,
  after: string | undefined,
  limit: number,
  reply: FastifyReply,
): Promise<void> {
  const result = await sessionService.getSessionEvents(tenantId, runId, after, limit);

  if (result.kind === 'reconcile_required') {
    await reply.status(410).send({
      error: 'ReconcileRequired',
      reason: result.reason,
      ...(result.cursor ? { lastKnownCursor: result.cursor } : {}),
      message:
        'Session event cursor is no longer replayable from hot or durable storage. Re-fetch the snapshot endpoint to resume.',
    });
    return;
  }

  await reply.send({
    events: result.events,
    // The reader's own position, not the last event's id. A page whose events
    // were all filtered downstream still has to advance, and an event id is
    // not something the reader can seek to.
    nextCursor:
      result.nextCursor !== undefined && result.nextCursor.length > 0
        ? result.nextCursor
        : undefined,
    hasMore: result.hasMore,
  });
}

/**
 * The backward page, and the default when a caller names no position.
 *
 * `hasMore` is reported false because there is nothing after this page: it ends
 * at the newest event the reader could see, and anything later arrives on the
 * live tail rather than by polling forward.
 */
async function handleBackwardMode(
  sessionService: SessionService,
  tenantId: TenantId,
  runId: SessionId,
  before: string | undefined,
  limit: number,
  reply: FastifyReply,
): Promise<void> {
  const result = await sessionService.getSessionEventsBefore(tenantId, runId, before, limit);

  if (result.kind === 'reconcile_required') {
    await reply.status(410).send({
      error: 'ReconcileRequired',
      reason: result.reason,
      ...(result.cursor ? { lastKnownCursor: result.cursor } : {}),
      message:
        'Session event cursor is no longer replayable from hot or durable storage. Re-fetch the snapshot endpoint to resume.',
    });
    return;
  }

  await reply.send({
    events: result.events,
    nextCursor:
      result.nextCursor !== undefined && result.nextCursor.length > 0
        ? result.nextCursor
        : undefined,
    hasMore: false,
    olderCursor: result.olderCursor,
    hasOlder: result.hasOlder,
  });
}
