/**
 * The owner's profile management on a local install (Plan 335 P2): list, add,
 * rename, set the avatar and remove.
 *
 * Registered in every edition and refused outside the local one, because a
 * profile is the local edition's way of naming who is at the keyboard. The
 * hosted edition admits people through its identity provider instead.
 *
 * Owner only. The operator's own profile session, the bare instance secret
 * and the sole-profile owner all resolve to the owner role. Any other profile
 * session is refused, whatever its role.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  CreateLocalProfileRequestSchema,
  CreateLocalProfileResponseSchema,
  LocalProfileListResponseSchema,
  LocalProfileRemovalPreviewSchema,
  LocalProfileSchema,
  RemoveLocalProfileResponseSchema,
  UpdateLocalProfileRequestSchema,
} from '@aflow/schemas';
import { resolvePrincipalActorKind } from '../utils/actorContext.js';
import {
  LocalProfileError,
  addLocalProfile,
  listLocalProfiles,
  previewLocalProfileRemoval,
  removeLocalProfile,
  updateLocalProfile,
  type LocalProfileRefusal,
} from '../services/localProfiles.js';

const ErrorSchema = z.object({ error: z.string(), message: z.string() });

const REFUSAL_STATUS: Record<LocalProfileRefusal, 404 | 409> = {
  not_found: 404,
  owner: 409,
  blocked: 409,
};

const OWNER_ONLY = { authz: { resource: 'tenant' as const, action: 'owner_admin' as const } };

const ProfileParamsSchema = z.object({ userId: z.string().uuid() });

export const localProfileRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const db = (): PostgresJsDatabase => fastify.appContext.db as PostgresJsDatabase;

  // Before authentication, so the hosted edition answers every caller alike.
  app.addHook('onRequest', async (_request, reply) => {
    if (fastify.edition.edition !== 'community-local') {
      return reply.status(404).send({
        error: 'NotFound',
        message:
          'Profiles belong to the local edition. The hosted edition admits people through its sign-in.',
      });
    }
    return undefined;
  });
  app.addHook('preHandler', app.authenticate);
  // The central check grants `owner_admin` to an admin when Redis is down, so
  // the owner rule is stated here as well.
  app.addHook('preHandler', async (request, reply) => {
    const tenant = await request.requireTenant();
    if (tenant.tenantRole !== 'owner') {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only the owner of this install manages its profiles.',
      });
    }
    return undefined;
  });

  /**
   * Runs `work`, answering a profile rule's refusal with its status. Null once
   * the refusal is answered. Any other failure propagates.
   */
  async function unlessRefused<T>(reply: FastifyReply, work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (err) {
      if (!(err instanceof LocalProfileError)) throw err;
      await reply.status(REFUSAL_STATUS[err.refusal]).send({
        error: err.refusal === 'not_found' ? 'NotFound' : 'Conflict',
        message: err.message,
      });
      return null;
    }
  }

  async function audit(request: FastifyRequest, action: string, resourceId: string): Promise<void> {
    if (!fastify.audit || !request.authUser) return;
    const tenant = await request.requireTenant();
    fastify.audit.record({
      actor: {
        userId: request.authUser.userId,
        kind: resolvePrincipalActorKind(request.authUser),
        authMethod: request.authUser.authMethod,
        tenantId: tenant.tenantId,
        tenantRole: tenant.tenantRole,
      },
      category: 'admin',
      action,
      outcome: 'success',
      target: { resourceType: 'user', resourceId, tenantId: tenant.tenantId },
      request: { method: request.method, path: request.url },
    });
  }

  app.get(
    '/',
    {
      config: OWNER_ONLY,
      schema: {
        tags: ['Local profiles'],
        summary: "List this install's profiles",
        response: { 200: LocalProfileListResponseSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      return { profiles: await listLocalProfiles(db(), tenant.tenantId) };
    },
  );

  app.post(
    '/',
    {
      config: OWNER_ONLY,
      schema: {
        tags: ['Local profiles'],
        summary: 'Add a profile with its own first space',
        body: CreateLocalProfileRequestSchema,
        response: { 201: CreateLocalProfileResponseSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const created = await addLocalProfile(db(), {
        edition: fastify.edition,
        tenantId: tenant.tenantId,
        displayName: request.body.displayName,
        avatar: request.body.avatar,
      });
      // A cached count of one would keep granting a browser with no session
      // the sole-profile owner until it expired.
      fastify.dropLocalProfileCount();
      await audit(request, 'local_profile.create', created.profile.userId);
      return reply.status(201).send(created);
    },
  );

  app.patch(
    '/:userId',
    {
      config: OWNER_ONLY,
      schema: {
        tags: ['Local profiles'],
        summary: 'Rename a profile or change its avatar',
        params: ProfileParamsSchema,
        body: UpdateLocalProfileRequestSchema,
        response: { 200: LocalProfileSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const profile = await unlessRefused(reply, () =>
        updateLocalProfile(db(), {
          tenantId: tenant.tenantId,
          userId: request.params.userId,
          displayName: request.body.displayName,
          avatar: request.body.avatar,
        }),
      );
      if (profile === null) return reply;
      await audit(request, 'local_profile.update', profile.userId);
      return reply.send(profile);
    },
  );

  app.get(
    '/:userId/removal',
    {
      config: OWNER_ONLY,
      schema: {
        tags: ['Local profiles'],
        summary: 'Preview what removing a profile deletes',
        params: ProfileParamsSchema,
        response: {
          200: LocalProfileRemovalPreviewSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const sql = fastify.appContext.sql as postgres.Sql | null | undefined;
      if (!sql) {
        return reply
          .status(503)
          .send({ error: 'ServiceUnavailable', message: 'The database is not available.' });
      }
      const preview = await unlessRefused(reply, () =>
        previewLocalProfileRemoval(db(), sql, tenant.tenantId, request.params.userId),
      );
      return preview === null ? reply : reply.send(preview);
    },
  );

  app.delete(
    '/:userId',
    {
      config: OWNER_ONLY,
      schema: {
        tags: ['Local profiles'],
        summary: 'Remove a profile, its sessions and the spaces only it is in',
        params: ProfileParamsSchema,
        response: {
          200: RemoveLocalProfileResponseSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const sql = fastify.appContext.sql as postgres.Sql | null | undefined;
      if (!sql) {
        return reply
          .status(503)
          .send({ error: 'ServiceUnavailable', message: 'The database is not available.' });
      }
      const removed = await unlessRefused(reply, () =>
        removeLocalProfile(db(), {
          sql,
          redis: fastify.appContext.redis as Redis | null | undefined,
          tenantId: tenant.tenantId,
          userId: request.params.userId,
          onCacheError: (err) => {
            fastify.log.warn({ err }, 'Failed to evict the removed profile from the role cache');
          },
        }),
      );
      if (removed === null) return reply;
      // A cached count of several would keep refusing a browser with no
      // session after the install is back to one profile.
      fastify.dropLocalProfileCount();
      await audit(request, 'local_profile.remove', removed.userId);
      return reply.send(removed);
    },
  );
};
