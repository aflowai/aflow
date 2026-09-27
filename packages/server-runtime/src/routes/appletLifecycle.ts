/**
 * Instance lifecycle surfaces — upgrade (repin to another version of the same
 * artifact; rollback is an upgrade whose target is the recorded
 * upgradedFromVersionId) and archive (active→archived, read-only from then
 * on). Both are operator moves on the instance row, not applet actions: no
 * journal entry, no effects — a repin publishes one realtime delta announcing
 * the new pin so mounted views refetch, and both bump the space's attention
 * generation.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createAppletPersistence, createTenantContext } from '@aflow/database';
import {
  applyAppletUpgrade,
  archiveAppletInstance,
  AppletPersistenceError,
  type AppletPersistence,
  type AppletUpgradeRefusalReason,
} from '@aflow/applet-runtime';
import { publishAppletInstanceDelta } from '@aflow/redis';
import { bumpAttentionGeneration } from '@aflow/cybernetic-runtime';
import { AppletInstanceSchema, AppletStateVersionSchema, type TenantId } from '@aflow/schemas';
import { assertInstanceSpaceAccess, resolveViewerSpaceRole } from './applets.js';

const ErrorSchema = z.object({ error: z.string(), message: z.string() });

const UpgradeBodySchema = z.object({ toVersionId: z.string().uuid() });

const UpgradeResponseSchema = z.object({
  instance: AppletInstanceSchema,
  stateVersion: AppletStateVersionSchema,
  /** False when the instance was already pinned to the target version. */
  upgraded: z.boolean(),
});

const UpgradeRefusedResponseSchema = z.object({
  reason: z.string(),
  message: z.string(),
  /** Structural validation failures, when the refusal carries them. */
  validation: z.array(z.string()).optional(),
});

const ArchiveResponseSchema = z.object({
  instance: AppletInstanceSchema,
  /** False when the instance was already archived. */
  archived: z.boolean(),
});

const NOT_FOUND_REASONS: ReadonlySet<AppletUpgradeRefusalReason> = new Set(['version_not_found']);

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
export const appletLifecycleRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  function persistenceFor(tenantId: TenantId): AppletPersistence {
    const db = fastify.appContext.db as PostgresJsDatabase | null;
    if (!db) throw fastify.httpErrors.serviceUnavailable('Applets require a database');
    return createAppletPersistence(db, createTenantContext(tenantId));
  }

  // ==========================================================================
  // POST /v1/applets/:instanceId/upgrade — repin within the artifact lineage
  // ==========================================================================
  app.post(
    '/:instanceId/upgrade',
    {
      config: { authz: { resource: 'memory', action: 'write', spaceIdFrom: 'none' } },
      schema: {
        tags: ['Applets'],
        summary: 'Move an instance to another version of its artifact, if its state still fits',
        params: z.object({ instanceId: z.string().uuid() }),
        body: UpgradeBodySchema,
        response: {
          200: UpgradeResponseSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          422: UpgradeRefusedResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { instanceId } = request.params;
      const spaceId = await assertInstanceSpaceAccess(fastify, request, reply, {
        tenantId: tenant.tenantId,
        instanceId,
        action: 'write',
      });
      if (spaceId === null) return;

      const spaceRole =
        (await resolveViewerSpaceRole(fastify, request, tenant.tenantId, spaceId)) ?? 'editor';
      if (spaceRole === 'viewer') {
        reply
          .code(403)
          .send({ error: 'Forbidden', message: 'Viewers cannot upgrade an applet instance' });
        return;
      }

      let result;
      try {
        result = await applyAppletUpgrade({
          persistence: persistenceFor(tenant.tenantId),
          instanceId,
          toVersionId: request.body.toVersionId,
        });
      } catch (err) {
        if (err instanceof AppletPersistenceError && err.code === 'instance_not_found') {
          reply.code(404).send({ error: 'NotFound', message: 'Applet instance not found' });
          return;
        }
        throw err;
      }

      switch (result.status) {
        case 'upgraded': {
          const redis = fastify.appContext.redis;
          if (redis) {
            await publishAppletInstanceDelta(redis, tenant.tenantId, {
              instanceId,
              seq: 0,
              stateVersion: result.stateVersion,
              patch: [],
              definitionHash: result.instance.definitionHash,
            });
            await bumpAttentionGeneration(redis, tenant.tenantId, spaceId);
          }
          reply.send({
            instance: result.instance,
            stateVersion: result.stateVersion,
            upgraded: true,
          });
          return;
        }
        case 'unchanged':
          reply.send({
            instance: result.instance,
            stateVersion: result.stateVersion,
            upgraded: false,
          });
          return;
        case 'refused':
          if (NOT_FOUND_REASONS.has(result.reason)) {
            reply.code(404).send({ error: 'NotFound', message: result.message });
            return;
          }
          reply.code(422).send({
            reason: result.reason,
            message: result.message,
            ...(result.validation !== undefined ? { validation: result.validation } : {}),
          });
          return;
      }
    },
  );

  // ==========================================================================
  // POST /v1/applets/:instanceId/archive — active→archived, read-only after
  // ==========================================================================
  app.post(
    '/:instanceId/archive',
    {
      config: { authz: { resource: 'memory', action: 'write', spaceIdFrom: 'none' } },
      schema: {
        tags: ['Applets'],
        summary: 'Archive an active applet instance — it stays readable, actions are refused',
        params: z.object({ instanceId: z.string().uuid() }),
        response: {
          200: ArchiveResponseSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          422: z.object({ reason: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { instanceId } = request.params;
      const spaceId = await assertInstanceSpaceAccess(fastify, request, reply, {
        tenantId: tenant.tenantId,
        instanceId,
        action: 'write',
      });
      if (spaceId === null) return;

      const spaceRole =
        (await resolveViewerSpaceRole(fastify, request, tenant.tenantId, spaceId)) ?? 'editor';
      if (spaceRole === 'viewer') {
        reply
          .code(403)
          .send({ error: 'Forbidden', message: 'Viewers cannot archive an applet instance' });
        return;
      }

      let result;
      try {
        result = await archiveAppletInstance({
          persistence: persistenceFor(tenant.tenantId),
          instanceId,
        });
      } catch (err) {
        if (err instanceof AppletPersistenceError && err.code === 'instance_not_found') {
          reply.code(404).send({ error: 'NotFound', message: 'Applet instance not found' });
          return;
        }
        throw err;
      }

      switch (result.status) {
        case 'archived': {
          const redis = fastify.appContext.redis;
          if (redis) await bumpAttentionGeneration(redis, tenant.tenantId, spaceId);
          reply.send({ instance: result.instance, archived: true });
          return;
        }
        case 'unchanged':
          reply.send({ instance: result.instance, archived: false });
          return;
        case 'refused':
          reply.code(422).send({ reason: result.reason, message: result.message });
          return;
      }
    },
  );
};
