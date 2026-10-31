/**
 * A local install's profiles: the picker that issues a profile session
 * (Plan 335 P3), and the owner's management (P2) — list, add, rename, set the
 * avatar and remove.
 *
 * Registered in every edition and refused outside the local one, because a
 * profile is the local edition's way of naming who is at the keyboard. The
 * hosted edition admits people through its identity provider instead.
 *
 * The picker answers a request that presents the instance secret, with or
 * without a profile session, because a browser with none is the one that has
 * to choose. It is the only path that issues a session, and it issues one only
 * for a profile of the pinned tenant.
 *
 * Management is owner only. The operator's own profile session, the bare
 * instance secret and the sole-profile owner all resolve to the owner role.
 * Any other profile session is refused, whatever its role.
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
  LOCAL_BROWSER_CALLER_HEADER,
  LocalProfileChoicesResponseSchema,
  LocalProfileListResponseSchema,
  LocalProfileRemovalPreviewSchema,
  LocalProfileSchema,
  LocalProfileSessionResponseSchema,
  RemoveLocalProfileResponseSchema,
  UpdateLocalProfileRequestSchema,
  type LocalProfile,
  type LocalProfileChoice,
} from '@aflow/schemas';
import { resolvePrincipalActorKind } from '../utils/actorContext.js';
import { presentsInstanceSecret, resolveInstanceSecret } from '../plugins/localInstanceAuth.js';
import {
  issueLocalProfileSession,
  readLocalProfileSessionGeneration,
} from '../plugins/localProfiles.js';
import {
  LocalProfileError,
  addLocalProfile,
  listLocalProfiles,
  previewLocalProfileRemoval,
  readLocalProfile,
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

const toChoice = (profile: LocalProfile): LocalProfileChoice => ({
  userId: profile.userId,
  displayName: profile.displayName,
  avatar: profile.avatar,
  isOwner: profile.isOwner,
});

export const localProfileRoutes: FastifyPluginAsync = async (fastify) => {
  // Before authentication, so the hosted edition answers every caller alike.
  fastify.addHook('onRequest', async (_request, reply) => {
    if (fastify.edition.edition !== 'community-local') {
      return reply.status(404).send({
        error: 'NotFound',
        message:
          'Profiles belong to the local edition. The hosted edition admits people through its sign-in.',
      });
    }
    return undefined;
  });
  // Two scopes, so the owner rule never reaches the picker. `authenticate`
  // refuses a browser with no session once a second profile exists, and that
  // browser is the one the picker must answer.
  await fastify.register(localProfilePickerRoutes);
  await fastify.register(localProfileManagementRoutes);
};

/**
 * Who is using Aflow? The tiles, and the session one of them issues.
 *
 * Answers only the instance secret itself, never an API key, because a key
 * already names its user and has nothing to choose.
 */
const localProfilePickerRoutes: FastifyPluginAsync = (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const db = (): PostgresJsDatabase => fastify.appContext.db as PostgresJsDatabase;

  const PICKER = {
    authzExempt: {
      reason:
        'The picker answers a browser that holds no profile session yet. The preHandler below admits the instance secret alone.',
    },
  };

  const pinnedTenant = (): string => {
    const tenancy = fastify.edition.tenancy;
    if (tenancy.mode !== 'fixed') throw new Error('The local edition pins one tenant');
    return tenancy.tenantId;
  };

  app.addHook('preHandler', async (request, reply) => {
    if (!presentsInstanceSecret(request, resolveInstanceSecret())) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: "The profile picker answers this install's web process alone.",
      });
    }
    return undefined;
  });

  app.get(
    '/picker',
    {
      config: PICKER,
      schema: {
        tags: ['Local profiles'],
        summary: 'List the profiles a browser chooses from',
        response: { 200: LocalProfileChoicesResponseSchema, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async () => ({ profiles: (await listLocalProfiles(db(), pinnedTenant())).map(toChoice) }),
  );

  app.post(
    '/:userId/session',
    {
      config: PICKER,
      schema: {
        tags: ['Local profiles'],
        summary: 'Issue the profile session for the profile a browser chose',
        params: ProfileParamsSchema,
        response: {
          200: LocalProfileSessionResponseSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      // The web process marks every browser call it proxies. A session sent
      // back through the proxy would reach a script in the page, and the
      // picker keeps it in a cookie no script reads.
      if (request.headers[LOCAL_BROWSER_CALLER_HEADER] !== undefined) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'A browser chooses a profile through the picker, which keeps the session.',
        });
      }
      const tenantId = pinnedTenant();
      const { userId } = request.params;
      const profile = await readLocalProfile(db(), tenantId, userId);
      const generation =
        profile === null ? null : await readLocalProfileSessionGeneration(db(), userId);
      if (profile === null || generation === null) {
        return reply.status(404).send({
          error: 'NotFound',
          message: 'No profile with that id on this install.',
        });
      }
      const session = issueLocalProfileSession(userId, resolveInstanceSecret(), { generation });
      fastify.audit.record({
        actor: {
          userId: profile.userId,
          kind: 'human',
          authMethod: 'local',
          tenantId,
          tenantRole: profile.role,
        },
        category: 'security',
        action: 'local_profile.session_issue',
        outcome: 'success',
        target: { resourceType: 'user', resourceId: profile.userId, tenantId },
        request: { method: request.method, path: request.url },
      });
      return reply.send({ profile: toChoice(profile), session });
    },
  );
  return Promise.resolve();
};

/** The owner's management (Plan 335 P2). */
const localProfileManagementRoutes: FastifyPluginAsync = (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const db = (): PostgresJsDatabase => fastify.appContext.db as PostgresJsDatabase;

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
    if (!request.authUser) return;
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
  return Promise.resolve();
};
