/**
 * The durable session roster over HTTP: read it, invite to it, join, decline,
 * leave. Membership is a social fact — every route re-checks space RBAC (the
 * only authorization boundary) and no membership row ever shortcuts it.
 * Invitations never reach outside the session's space.
 */
import type { FastifyInstance } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  createTenantContext,
  inviteParticipant,
  listSessionParticipants,
  setParticipantStatus,
  spaceMemberships,
  upsertJoinedParticipant,
  withTenantSchema,
} from '@aflow/database';
import {
  SessionIdSchema,
  SessionMemberSchema,
  SessionRosterEntrySchema,
  type SessionId,
} from '@aflow/schemas';
import { disambiguateLabels, resolveUserLabels, rosterUserLabel } from '@aflow/cybernetic-runtime';
import { publishActionCenterWake } from '@aflow/redis';
import { BadRequestError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { assertSessionSpaceAccess, resolveSessionSpaceId } from '../lib/sessionSpaceAccess.js';
import { buildActorContext } from '../utils/actorContext.js';
import { postRoomMessageDirect } from '../services/sessionRoomPost.js';

const ParticipantsResponseSchema = z.object({
  participants: z.array(SessionRosterEntrySchema),
});

const InviteRequestSchema = z.object({ userId: z.string().uuid() });
const MemberResponseSchema = z.object({ member: SessionMemberSchema });

async function isSpaceMember(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: spaceMemberships.id })
    .from(spaceMemberships)
    .where(
      and(
        eq(spaceMemberships.tenantId, tenantId),
        eq(spaceMemberships.spaceId, spaceId),
        eq(spaceMemberships.userId, userId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export function registerSessionParticipantRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const requireDb = (): PostgresJsDatabase => {
    const db = fastify.appContext.db as PostgresJsDatabase | null;
    if (!db) throw new BadRequestError('Database is not available');
    return db;
  };

  // GET /v1/sessions/:sessionId/participants — the roster, labels resolved.
  app.get(
    '/:sessionId/participants',
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
        params: z.object({ sessionId: SessionIdSchema }),
        response: { 200: ParticipantsResponseSchema },
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
      const db = requireDb();
      const tenantCtx = createTenantContext(tenant.tenantId);
      const members = await withTenantSchema(db, tenantCtx, (tx) =>
        listSessionParticipants(tx, sessionId),
      );
      const labels = await resolveUserLabels(
        db,
        members.map((member) => member.userId),
      );
      const display = disambiguateLabels(
        members.map((member) => ({
          userId: member.userId,
          label: rosterUserLabel(labels.get(member.userId), member.userId),
        })),
      );
      reply.send({
        participants: members.map((member) => ({
          ...member,
          ...(display.get(member.userId) ? { displayName: display.get(member.userId) } : {}),
        })),
      });
    },
  );

  // POST /v1/sessions/:sessionId/participants/invite — space members only,
  // both directions: the inviter needs write access to the session, and the
  // invitee must already belong to the session's space.
  app.post(
    '/:sessionId/participants/invite',
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
        params: z.object({ sessionId: SessionIdSchema }),
        body: InviteRequestSchema,
        response: { 200: MemberResponseSchema },
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
      const space = await request.requireSpace();
      const actor = buildActorContext(request, tenant, space);
      if (!actor) throw new ForbiddenError('An identified actor is required to invite');
      const db = requireDb();
      const lookup = await resolveSessionSpaceId(fastify, tenant.tenantId, sessionId);
      if (!lookup.found) throw new NotFoundError('Session not found');
      if (!lookup.spaceId) {
        throw new BadRequestError('This session has no space — invitations need one');
      }
      if (!(await isSpaceMember(db, tenant.tenantId, lookup.spaceId, request.body.userId))) {
        throw new BadRequestError('Invitations are limited to members of the session’s space');
      }
      const tenantCtx = createTenantContext(tenant.tenantId);
      const outcome = await withTenantSchema(db, tenantCtx, (tx) =>
        inviteParticipant(tx, {
          sessionId,
          userId: request.body.userId,
          invitedBy: actor.userId,
        }),
      );
      if (fastify.appContext.redis) {
        publishActionCenterWake(fastify.appContext.redis, {
          source: 'session_invitation',
          tenantId: tenant.tenantId,
          spaceId: lookup.spaceId,
        });
      }
      reply.send({ member: outcome.member });
    },
  );

  // POST /v1/sessions/:sessionId/participants/join — self-service for anyone
  // with read access to the session's space; invitation optional by design
  // (the space is the trust boundary, the invite is the attention signal).
  app.post(
    '/:sessionId/participants/join',
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
        params: z.object({ sessionId: SessionIdSchema }),
        response: { 200: MemberResponseSchema },
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
      const space = await request.requireSpace();
      const actor = buildActorContext(request, tenant, space);
      if (!actor) throw new ForbiddenError('An identified actor is required to join');
      const db = requireDb();
      const tenantCtx = createTenantContext(tenant.tenantId);
      const before = await withTenantSchema(db, tenantCtx, (tx) =>
        listSessionParticipants(tx, sessionId),
      );
      const wasJoined = before.some(
        (member) => member.userId === actor.userId && member.status === 'joined',
      );
      const { member, consumedInvite } = await withTenantSchema(db, tenantCtx, (tx) =>
        upsertJoinedParticipant(tx, sessionId, actor.userId),
      );
      // The join just consumed a pending invitation card. The card lives in the
      // SESSION's space, which the request's space header is not forced to
      // match. Best-effort past this point: the join has committed, so a lookup
      // failure must not fail the request — the invitee's next reconnect or
      // visibility return rebuilds the list.
      if (consumedInvite && fastify.appContext.redis) {
        try {
          const lookup = await resolveSessionSpaceId(fastify, tenant.tenantId, sessionId);
          if (lookup.found && lookup.spaceId) {
            publishActionCenterWake(fastify.appContext.redis, {
              source: 'session_invitation',
              tenantId: tenant.tenantId,
              spaceId: lookup.spaceId,
            });
          }
        } catch (err) {
          request.log.warn({ err, sessionId }, 'join wake skipped');
        }
      }
      // The join itself is room news: humans see it in the transcript and the
      // agent reads it at its next boundary — nobody has to compose anything.
      if (!wasJoined && fastify.appContext.redis) {
        try {
          await postRoomMessageDirect(fastify.appContext.redis, db, {
            tenantId: tenant.tenantId,
            sessionId: sessionId as SessionId,
            actorUserId: actor.userId,
            ...(actor.displayName ? { actorDisplayName: actor.displayName } : {}),
            body: 'joined the session',
          });
        } catch (err) {
          request.log.warn({ err, sessionId }, 'join posted no room event');
        }
      }
      reply.send({ member });
    },
  );

  // POST /v1/sessions/:sessionId/participants/decline — self, invited only.
  app.post(
    '/:sessionId/participants/decline',
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
        params: z.object({ sessionId: SessionIdSchema }),
        response: { 200: MemberResponseSchema },
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params;
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const actor = buildActorContext(request, tenant, space);
      if (!actor) throw new ForbiddenError('An identified actor is required to decline');
      const db = requireDb();
      const tenantCtx = createTenantContext(tenant.tenantId);
      const member = await withTenantSchema(db, tenantCtx, (tx) =>
        setParticipantStatus(tx, {
          sessionId,
          userId: actor.userId,
          from: ['invited'],
          to: 'declined',
        }),
      );
      if (!member) throw new NotFoundError('No pending invitation to decline');
      if (fastify.appContext.redis) {
        try {
          const lookup = await resolveSessionSpaceId(fastify, tenant.tenantId, sessionId);
          if (lookup.found && lookup.spaceId) {
            publishActionCenterWake(fastify.appContext.redis, {
              source: 'session_invitation',
              tenantId: tenant.tenantId,
              spaceId: lookup.spaceId,
            });
          }
        } catch (err) {
          request.log.warn({ err, sessionId }, 'decline wake skipped');
        }
      }
      reply.send({ member });
    },
  );

  // POST /v1/sessions/:sessionId/participants/leave — self, joined only.
  app.post(
    '/:sessionId/participants/leave',
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
        params: z.object({ sessionId: SessionIdSchema }),
        response: { 200: MemberResponseSchema },
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params;
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const actor = buildActorContext(request, tenant, space);
      if (!actor) throw new ForbiddenError('An identified actor is required to leave');
      const db = requireDb();
      const tenantCtx = createTenantContext(tenant.tenantId);
      const member = await withTenantSchema(db, tenantCtx, (tx) =>
        setParticipantStatus(tx, {
          sessionId,
          userId: actor.userId,
          from: ['joined'],
          to: 'left',
        }),
      );
      if (!member) throw new NotFoundError('Not a joined participant');
      reply.send({ member });
    },
  );
}
