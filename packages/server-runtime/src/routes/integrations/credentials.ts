import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, eq } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  apiCredentials,
  encryptCredentialEnvelope,
  type ApiCredentialRow,
} from '@aflow/database';
import { publishApiCatalogInvalidation } from '@aflow/redis';
import {
  CredentialMetaResponseSchema,
  findUnreferencedCredentialKeys,
  getDb,
  getRedis,
  mapCredentialRow,
} from './shared.js';

export function registerCredentialRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/credentials',
    {
      config: { authz: { resource: 'secret', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'List credential keys in the current space (values are NEVER returned)',
        response: {
          200: z.object({
            credentials: z.array(CredentialMetaResponseSchema),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);

      if (!db) {
        reply.send({ credentials: [] });
        return;
      }

      const tenantContext = createTenantContext(tenant.tenantId);
      const rows = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx.select().from(apiCredentials).where(eq(apiCredentials.spaceId, space.spaceId));
      })) as ApiCredentialRow[];

      const credentials = rows.map((row) =>
        mapCredentialRow(row as Parameters<typeof mapCredentialRow>[0]),
      );

      reply.send({ credentials });
    },
  );

  app.put(
    '/credentials/:credentialKey',
    {
      config: { authz: { resource: 'secret', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Set a credential value in the current space (encrypted at rest)',
        description:
          'Stores the credential value encrypted using AES-256-GCM. ' +
          'The plain value is NEVER stored or returned. The credential is valid only inside this space.',
        params: z.object({ credentialKey: z.string().min(1).max(256) }),
        body: z.object({
          value: z.string().min(1).max(8192),
          label: z.string().min(1).max(256),
          description: z.string().max(2000).optional(),
        }),
        response: {
          200: z.object({
            credentialKey: z.string(),
            status: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      const { credentialKey } = request.params as { credentialKey: string };
      const { value, label, description } = request.body;

      if (!db) throw new Error('Database not configured');

      const tenantContext = createTenantContext(tenant.tenantId);
      const encryptedValue = await encryptCredentialEnvelope(value);

      await withTenantSchema(db, tenantContext, async (tx) => {
        await tx.execute(sql`
          INSERT INTO api_credentials (credential_key, space_id, label, description, encrypted_value)
          VALUES (
            ${credentialKey},
            ${space.spaceId}::uuid,
            ${label},
            ${description ?? null},
            ${encryptedValue}
          )
          ON CONFLICT (credential_key, space_id) DO UPDATE SET
            label = EXCLUDED.label,
            description = EXCLUDED.description,
            encrypted_value = EXCLUDED.encrypted_value,
            updated_at = NOW()
        `);
      });

      const redis = getRedis(fastify);
      if (redis) {
        publishApiCatalogInvalidation(redis, tenant.tenantId as string, space.spaceId, {
          kind: 'credential',
        });
      }

      reply.send({ credentialKey, status: 'ok' });
    },
  );

  app.delete(
    '/credentials/:credentialKey',
    {
      config: { authz: { resource: 'secret', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Delete a credential from the current space (rejects if still referenced)',
        params: z.object({ credentialKey: z.string() }),
        response: {
          200: z.object({ status: z.string() }),
          409: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      const { credentialKey } = request.params as { credentialKey: string };

      if (!db) throw new Error('Database not configured');

      const tenantContext = createTenantContext(tenant.tenantId);

      const conflictMessage = await withTenantSchema(db, tenantContext, async (tx) => {
        const unreferenced = await findUnreferencedCredentialKeys(tx, space.spaceId, [
          credentialKey,
        ]);
        if (unreferenced.length === 0) {
          return `Credential "${credentialKey}" is still referenced by at least one binding in this space. Remove the integrations that use it first.`;
        }
        await tx.execute(
          sql`DELETE FROM api_credentials WHERE credential_key = ${credentialKey} AND space_id = ${space.spaceId}::uuid`,
        );
        return null;
      });

      if (conflictMessage) {
        reply.code(409).send({ error: 'credential_in_use', message: conflictMessage });
        return;
      }

      const redis = getRedis(fastify);
      if (redis) {
        publishApiCatalogInvalidation(redis, tenant.tenantId as string, space.spaceId, {
          kind: 'credential',
        });
      }

      reply.send({ status: 'deleted' });
    },
  );
}
