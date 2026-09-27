/**
 * API definition CRUD routes.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  apiDefinitions,
  type ApiDefinitionRow,
} from '@aflow/database';
import { publishApiCatalogInvalidation } from '@aflow/redis';
import { ApiEndpointSchema, ApiDefinitionSchema } from '@aflow/schemas';
import {
  collectApiDefinitionHosts,
  countActiveRepoDependents,
  deleteApiIntegration,
  enforceIntegrationHostPolicy,
} from '@aflow/cybernetic-runtime';
import {
  ApiDefinitionResponseSchema,
  IntegrationWriteErrorSchema,
  getDb,
  getRedis,
  integrationPolicyDenialPayload,
  mapDefinitionRow,
} from './shared.js';

export function registerDefinitionRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/definitions',
    {
      config: { authz: { resource: 'api_config', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'List API definitions',
        response: {
          200: z.object({
            definitions: z.array(ApiDefinitionResponseSchema),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);

      if (!db) {
        reply.send({ definitions: [] });
        return;
      }

      const tenantContext = createTenantContext(tenant.tenantId);
      const rows = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx.select().from(apiDefinitions).where(eq(apiDefinitions.spaceId, space.spaceId));
      })) as ApiDefinitionRow[];

      const definitions = rows.map((row) =>
        mapDefinitionRow(row as Parameters<typeof mapDefinitionRow>[0]),
      );
      reply.send({ definitions });
    },
  );

  app.get(
    '/definitions/:apiId',
    {
      config: { authz: { resource: 'api_config', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Get API definition detail (includes endpoints)',
        params: z.object({ apiId: z.string() }),
        response: {
          200: z.object({
            definition: z.record(z.unknown()),
          }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      const { apiId } = request.params as { apiId: string };

      if (!db) {
        reply.code(404).send({ error: 'Database not configured' });
        return;
      }

      const tenantContext = createTenantContext(tenant.tenantId);
      const rows = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .select()
          .from(apiDefinitions)
          .where(and(eq(apiDefinitions.apiId, apiId), eq(apiDefinitions.spaceId, space.spaceId)))
          .limit(1);
      })) as ApiDefinitionRow[];

      if (rows.length === 0) {
        reply.code(404).send({ error: `API definition "${apiId}" not found` });
        return;
      }

      const row = rows[0]!;
      const defJson = row.definitionJson ?? {};

      reply.send({
        definition: {
          apiId: row.apiId,
          name: row.name,
          description: row.description ?? null,
          baseUrl: row.baseUrl,
          version: row.version,
          tags: row.tags ?? [],
          enabled: (row.enabled ?? 1) === 1,
          ...(defJson as Record<string, unknown>),
          createdAt: new Date(row.createdAt).toISOString(),
          updatedAt: new Date(row.updatedAt).toISOString(),
        },
      });
    },
  );

  app.post(
    '/definitions',
    {
      config: { authz: { resource: 'api_config', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Create or update an API definition',
        body: z.object({
          apiId: z.string().min(1).max(128),
          name: z.string().min(1).max(256),
          description: z.string().max(2000).optional(),
          baseUrl: z.string().url().max(2048).optional(),
          baseUrlTemplate: z.string().max(2048).optional(),
          variables: z
            .array(
              z.object({
                name: z
                  .string()
                  .min(1)
                  .max(64)
                  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
                description: z.string().max(500),
                example: z.string().max(256).optional(),
                required: z.boolean().default(true),
              }),
            )
            .max(20)
            .optional(),
          version: z.string().max(64).default('1'),
          callMode: z.enum(['endpoint', 'direct_url']).optional(),
          // direct_url definitions declare no endpoints.
          endpoints: z.array(ApiEndpointSchema),
          defaultHeaders: z.record(z.string()).optional(),
          tags: z.array(z.string().max(64)).max(20).default([]),
        }),
        response: {
          200: z.object({ apiId: z.string(), status: z.string() }),
          400: IntegrationWriteErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      const body = request.body;

      if (!db) throw new Error('Database not configured');

      const tenantContext = createTenantContext(tenant.tenantId);
      const definitionJson = {
        apiId: body.apiId,
        name: body.name,
        ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
        ...(body.baseUrlTemplate ? { baseUrlTemplate: body.baseUrlTemplate } : {}),
        ...(body.variables ? { variables: body.variables } : {}),
        version: body.version,
        ...(body.callMode === 'direct_url' ? { callMode: 'direct_url' } : {}),
        endpoints: body.endpoints,
        ...(body.defaultHeaders ? { defaultHeaders: body.defaultHeaders } : {}),
        tags: body.tags,
      };
      const validation = ApiDefinitionSchema.safeParse(definitionJson);
      if (!validation.success) {
        reply.code(400).send({
          error: validation.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; '),
        });
        return;
      }

      // Persist the validated/normalized definition (schema defaults applied)
      // rather than the raw input, so the stored row matches what the runtime reads.
      const def = validation.data;

      try {
        await enforceIntegrationHostPolicy({
          db,
          tenantId: tenant.tenantId as string,
          spaceId: space.spaceId as string,
          kind: 'api',
          hosts: collectApiDefinitionHosts(def),
          grantRefs: [{ artifactType: 'api_definition', artifactKey: def.apiId }],
        });
      } catch (err) {
        const denial = integrationPolicyDenialPayload(err);
        if (denial) {
          reply.code(400).send(denial);
          return;
        }
        throw err;
      }

      await withTenantSchema(db, tenantContext, async (tx) => {
        await tx.execute(sql`
          INSERT INTO api_definitions (api_id, name, description, base_url, version, definition_json, tags, space_id)
          VALUES (
            ${def.apiId},
            ${def.name},
            ${def.description ?? null},
            ${def.baseUrl ?? null},
            ${def.version},
            ${JSON.stringify(def)}::jsonb,
            ${JSON.stringify(def.tags)}::jsonb,
            ${space.spaceId}::uuid
          )
          ON CONFLICT (api_id, space_id) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            base_url = EXCLUDED.base_url,
            version = EXCLUDED.version,
            definition_json = EXCLUDED.definition_json,
            tags = EXCLUDED.tags,
            updated_at = NOW()
        `);
      });

      const redis = getRedis(fastify);
      if (redis) {
        publishApiCatalogInvalidation(redis, tenant.tenantId as string, space.spaceId, {
          kind: 'definition',
          apiId: body.apiId,
        });
      }

      reply.send({ apiId: body.apiId, status: 'ok' });
    },
  );

  app.delete(
    '/definitions/:apiId',
    {
      config: { authz: { resource: 'api_config', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Delete an API definition',
        params: z.object({ apiId: z.string() }),
        response: {
          200: z.object({ status: z.string() }),
          404: z.object({ error: z.string() }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      const { apiId } = request.params as { apiId: string };

      if (!db) throw new Error('Database not configured');

      const tenantContext = createTenantContext(tenant.tenantId);

      // Fail-closed (Plan 222): the cascade hard-deletes this definition's bindings,
      // so a connection still backing a live coding repo would be silently orphaned.
      // Block the delete while any non-archived repo resolves through a doomed binding.
      // The dependent count runs as the FIRST statement of the SAME transaction as the
      // cascade (not a separate one) to keep the check-then-delete window tight; a repo
      // created concurrently is still caught at run time by the executor's resolver.
      const dependentCount = await withTenantSchema(db, tenantContext, async (tx) => {
        const count = await countActiveRepoDependents(tx, space.spaceId, apiId);
        if (count > 0) return count;
        await deleteApiIntegration(tx, space.spaceId, apiId);
        return 0;
      });

      if (dependentCount > 0) {
        reply.code(409).send({
          error:
            `Integration "${apiId}" still backs ${dependentCount} ` +
            `${dependentCount === 1 ? 'repository' : 'repositories'} that resolve git + the GitHub ` +
            `API through its ${dependentCount === 1 ? 'connection' : 'connections'}. Re-link or ` +
            `remove ${dependentCount === 1 ? 'it' : 'them'} before deleting this integration.`,
        });
        return;
      }

      const redis = getRedis(fastify);
      if (redis) {
        publishApiCatalogInvalidation(redis, tenant.tenantId as string, space.spaceId, {
          kind: 'definition',
          apiId,
        });
      }

      reply.send({ status: 'deleted' });
    },
  );
}
