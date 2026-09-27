/**
 * API key management endpoints.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import { apiKeys } from '@aflow/database';
import { mintApiKey } from '../lib/apiKeys.js';

export const apiKeysRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  // POST /v1/api-keys — create API key
  app.post(
    '/',
    {
      schema: {
        tags: ['API Keys'],
        summary: 'Create API key',
        // Strict: an unknown key is a 400, not a silent strip. A client
        // asking for `scopes` must be told the request was not honoured —
        // stripping it would hand back an unrestricted key to a caller who
        // believes they asked for a restricted one.
        body: z
          .object({
            name: z.string().min(1).max(255),
            // No `scopes` field: nothing in authorization reads a key's
            // scopes, so accepting them would hand back a key that looks
            // restricted and is not. A key carries its owner's full access —
            // the schema says so rather than a doc comment nobody reads.
            // Reinstate this only together with fail-closed scope evaluation.
            expiresInDays: z.number().int().positive().max(365).default(90),
          })
          .strict(),
        response: {
          201: z.object({
            keyId: z.string(),
            key: z.string(),
            prefix: z.string(),
            name: z.string(),
            expiresAt: z.string().nullable(),
          }),
          500: z.object({ error: z.string(), message: z.string() }),
        },
      },
      config: { authz: { resource: 'tenant', action: 'write' } },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const { name, expiresInDays } = request.body;

      const { plaintext, keyHash, keyPrefix } = mintApiKey();

      // Always bounded: a non-expiring bearer credential has no revocation
      // story beyond someone remembering it exists.
      const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

      const insertValues: typeof apiKeys.$inferInsert = {
        keyHash,
        keyPrefix,
        name,
        userId: request.authUser!.userId,
        tenantId: tenant.tenantId,
        scopes: [],
        expiresAt,
      };

      const result = await db
        .insert(apiKeys)
        .values(insertValues)
        .returning({ id: apiKeys.id, expiresAt: apiKeys.expiresAt });
      const row = result[0];
      if (!row) {
        return reply
          .status(500)
          .send({ error: 'InternalError', message: 'Failed to create API key' });
      }

      if (fastify.audit) {
        fastify.audit.record({
          actor: {
            userId: request.authUser!.userId,
            kind: request.authUser!.isServicePrincipal ? 'service_principal' : 'human',
            authMethod: request.authUser!.authMethod,
            tenantId: tenant.tenantId,
            tenantRole: tenant.tenantRole,
          },
          category: 'security',
          action: 'api_key.create',
          outcome: 'success',
          target: { resourceType: 'api_key', resourceId: row.id, tenantId: tenant.tenantId },
          request: { method: request.method, path: request.url },
        });
      }

      reply.status(201).send({
        keyId: row.id,
        key: plaintext,
        prefix: keyPrefix,
        name,
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      });
    },
  );

  // GET /v1/api-keys — list keys
  app.get(
    '/',
    {
      schema: {
        tags: ['API Keys'],
        summary: 'List API keys',
        response: {
          200: z.object({
            keys: z.array(
              z.object({
                id: z.string(),
                prefix: z.string(),
                name: z.string(),
                createdAt: z.string(),
                lastUsedAt: z.string().nullable(),
                expiresAt: z.string().nullable(),
                revokedAt: z.string().nullable(),
              }),
            ),
          }),
        },
      },
      config: { authz: { resource: 'tenant', action: 'read' } },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;

      const rows = await db
        .select({
          id: apiKeys.id,
          prefix: apiKeys.keyPrefix,
          name: apiKeys.name,
          createdAt: apiKeys.createdAt,
          lastUsedAt: apiKeys.lastUsedAt,
          expiresAt: apiKeys.expiresAt,
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .where(
          and(eq(apiKeys.userId, request.authUser!.userId), eq(apiKeys.tenantId, tenant.tenantId)),
        );

      reply.send({
        keys: rows.map((r) => ({
          id: r.id,
          prefix: r.prefix,
          name: r.name,
          createdAt: r.createdAt.toISOString(),
          lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
          expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
          revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
        })),
      });
    },
  );

  // DELETE /v1/api-keys/:keyId — revoke key
  app.delete(
    '/:keyId',
    {
      schema: {
        tags: ['API Keys'],
        summary: 'Revoke API key',
        params: z.object({ keyId: z.string().uuid() }),
        response: {
          200: z.object({ message: z.string() }),
        },
      },
      config: { authz: { resource: 'tenant', action: 'write' } },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const { keyId } = request.params;

      await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiKeys.id, keyId),
            eq(apiKeys.userId, request.authUser!.userId),
            eq(apiKeys.tenantId, tenant.tenantId),
          ),
        );

      // Invalidate Redis cache for this key
      if (fastify.appContext.redis) {
        const keyRows = await db
          .select({ keyHash: apiKeys.keyHash })
          .from(apiKeys)
          .where(eq(apiKeys.id, keyId));
        const keyRow = keyRows[0];
        if (keyRow) {
          await fastify.appContext.redis.del(`aflow:apikey:${keyRow.keyHash}`);
        }
      }

      if (fastify.audit) {
        fastify.audit.record({
          actor: {
            userId: request.authUser!.userId,
            kind: request.authUser!.isServicePrincipal ? 'service_principal' : 'human',
            authMethod: request.authUser!.authMethod,
            tenantId: tenant.tenantId,
            tenantRole: tenant.tenantRole,
          },
          category: 'security',
          action: 'api_key.revoke',
          outcome: 'success',
          target: { resourceType: 'api_key', resourceId: keyId, tenantId: tenant.tenantId },
          request: { method: request.method, path: request.url },
        });
      }

      reply.send({ message: 'API key revoked' });
    },
  );
};
