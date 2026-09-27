/**
 * Naming a conversation, handing it back to the automatic name, and asking for
 * a fresh one.
 *
 * Renaming is ordinary session write permission, with attribution — a shared
 * room's name belongs to everyone in it, and neither having opened it nor
 * currently steering it is an authorization boundary anywhere else in the
 * platform. Every route resolves the session's own space and re-checks there,
 * because the route-level check runs unscoped.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  markSessionTitleRefreshable,
  readSessionMetadata,
  setManualSessionTitle,
} from '@aflow/database';
import { appendEntityEvent, requestSessionMetadataNow } from '@aflow/redis';
import {
  SESSION_TITLE_MAX,
  SessionIdSchema,
  SessionMetadataDetailSchema,
  normalizeSessionLabel,
  type SessionId,
  type TenantId,
} from '@aflow/schemas';
import { BadRequestError, ForbiddenError } from '../lib/errors.js';
import { assertSessionSpaceAccess, resolveSessionSpaceId } from '../lib/sessionSpaceAccess.js';
import {
  projectSessionMetadataDetail,
  UNPROJECTED_SESSION_METADATA,
} from '../services/sessionMetadataProjection.js';

const MetadataResponseSchema = z.object({ metadata: SessionMetadataDetailSchema });

async function resolveRenameSpaceId(
  app: FastifyInstance,
  tenantId: TenantId,
  sessionId: string,
): Promise<string | null> {
  const lookup = await resolveSessionSpaceId(app, tenantId, sessionId);
  return lookup.found ? lookup.spaceId : null;
}

const ConflictSchema = z.object({
  error: z.literal('Conflict'),
  message: z.string(),
  metadata: SessionMetadataDetailSchema,
});

const RenameRequestSchema = z.object({
  /**
   * The name, or null to go back to the automatic one. An empty string is
   * rejected rather than read as either: "clear this" is an action someone
   * chooses, not a field they left blank.
   */
  title: z.string().max(SESSION_TITLE_MAX).nullable(),
  /**
   * The revision the client was looking at. Two people renaming at once find
   * out; the loser is told rather than silently overwritten.
   */
  expectedRevision: z.number().int().nonnegative().optional(),
});

const RegenerateResponseSchema = z.object({
  /**
   * The request was accepted, not applied. Generation happens in the
   * background and the result arrives on the space's event channel; a client
   * that renders "renamed" here would be reporting something that has not
   * happened yet.
   */
  accepted: z.literal(true),
});

export function registerSessionMetadataRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const requireDb = (): PostgresJsDatabase => {
    const db = fastify.appContext.db as PostgresJsDatabase | null;
    if (!db) throw new ForbiddenError('Database unavailable');
    return db;
  };

  app.get(
    '/:sessionId/metadata',
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
        summary: 'Conversation title, summary, and how they were produced',
        params: z.object({ sessionId: SessionIdSchema }),
        response: { 200: MetadataResponseSchema },
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params;
      if (
        !(await assertSessionSpaceAccess(fastify, request, reply, { action: 'read', sessionId }))
      ) {
        return;
      }
      const tenant = await request.requireTenant();
      const stored = await readSessionMetadata(requireDb(), tenant.tenantId, sessionId);
      // The access check above already found the session, in Redis if not yet
      // in Postgres. A missing row here is projection lag.
      reply.send({
        metadata: stored ? projectSessionMetadataDetail(stored) : UNPROJECTED_SESSION_METADATA,
      });
    },
  );

  app.patch(
    '/:sessionId/metadata',
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
        summary: 'Name a conversation, or hand it back to the automatic name',
        params: z.object({ sessionId: SessionIdSchema }),
        body: RenameRequestSchema,
        response: { 200: MetadataResponseSchema, 409: ConflictSchema },
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params;
      if (
        !(await assertSessionSpaceAccess(fastify, request, reply, { action: 'write', sessionId }))
      ) {
        return;
      }
      const tenant = await request.requireTenant();
      const db = requireDb();
      const userId = request.authUser?.userId;
      if (!userId) throw new ForbiddenError('An identified actor is required to rename');

      const title = request.body.title === null ? null : normalizeSessionLabel(request.body.title);
      if (title !== null && title.length === 0) {
        throw new BadRequestError(
          'A name cannot be empty. Send null to go back to the automatic name.',
        );
      }

      const result = await setManualSessionTitle(db, tenant.tenantId, sessionId, {
        title,
        editedByUserId: userId,
        ...(request.body.expectedRevision !== undefined
          ? { expectedRevision: request.body.expectedRevision }
          : {}),
      });

      const stored = await readSessionMetadata(db, tenant.tenantId, sessionId);

      // The access check above found this session, so a missing durable row is
      // the projection not having caught up — existence, not absence. A 404
      // would say the conversation is gone and leave the caller nothing to do;
      // what is true is that its record is seconds away.
      if ((!result.ok && result.reason === 'not_found') || !stored) {
        reply.status(409).send({
          error: 'Conflict',
          message: 'This conversation is still being stored. Try the name again in a moment.',
          metadata: UNPROJECTED_SESSION_METADATA,
        });
        return;
      }

      if (!result.ok) {
        reply.status(409).send({
          error: 'Conflict',
          message: 'This conversation was renamed by someone else. Here is its current name.',
          metadata: projectSessionMetadataDetail(stored),
        });
        return;
      }

      // Everyone in the space sees this room's name, so the space hears about
      // it — not just the client that sent the rename. Best-effort for the
      // same reason the background job's is: a name that arrives on the next
      // refetch is late, not wrong.
      const redis = fastify.appContext.redis;
      const spaceId = await resolveRenameSpaceId(fastify, tenant.tenantId, sessionId);
      if (redis && spaceId) {
        try {
          await appendEntityEvent(redis, {
            tenantId: tenant.tenantId,
            spaceId,
            event: {
              eventId: randomUUID(),
              eventType: 'entity.session.described',
              spaceId,
              tenantId: tenant.tenantId,
              timestamp: Date.now(),
              causedBySessionId: sessionId,
              payload: { sessionId },
              summary: 'Conversation renamed',
            },
          });
        } catch {
          // Best-effort.
        }
      }

      reply.send({ metadata: projectSessionMetadataDetail(stored) });
    },
  );

  app.post(
    '/:sessionId/metadata/regenerate',
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
        summary: 'Ask for a fresh title and summary now',
        params: z.object({ sessionId: SessionIdSchema }),
        response: { 202: RegenerateResponseSchema },
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params;
      if (
        !(await assertSessionSpaceAccess(fastify, request, reply, { action: 'write', sessionId }))
      ) {
        return;
      }
      const tenant = await request.requireTenant();
      const redis = fastify.appContext.redis;
      if (!redis) throw new ForbiddenError('Background generation is unavailable');

      // No existence check of its own: the space-access check above found the
      // session, and a conversation opened seconds ago has no durable row yet.
      // Arming it is harmless either way — the worker retires a candidate it
      // cannot resolve.
      const db = requireDb();

      // An established name is left alone by the ordinary refresh, so asking
      // for a fresh one has to say the established one is no longer settled —
      // otherwise this action rewrites the summary and nothing else.
      await markSessionTitleRefreshable(db, tenant.tenantId, sessionId);
      await requestSessionMetadataNow(redis, tenant.tenantId, sessionId as SessionId);
      reply.status(202).send({ accepted: true });
    },
  );
}
