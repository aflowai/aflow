import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { CascadeDetailSchema, CascadeListItemSchema } from '@aflow/schemas';
import { getCascadeDetail, listRecentCascades } from '../services/cascadeBuilder.js';

const ErrorSchema = z.object({ error: z.string(), message: z.string() });

export const cascadesRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  app.get(
    '/:spaceId/cascades',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'read',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Spaces'],
        summary: 'List recent session roots for cascade view',
        params: z.object({ spaceId: z.string().uuid() }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).optional().default(20),
        }),
        response: {
          200: z.object({ cascades: z.array(CascadeListItemSchema) }),
        },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      const db = app.appContext.db as PostgresJsDatabase;
      const { spaceId } = request.params;
      const { limit } = request.query;

      const cascades = await listRecentCascades({
        db,
        tenantId: tenant.tenantId,
        spaceId,
        limit,
      });

      return { cascades };
    },
  );

  app.get(
    '/:spaceId/cascades/:cascadeId',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'read',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Spaces'],
        summary: 'Get cascade tree for a root session',
        params: z.object({
          spaceId: z.string().uuid(),
          cascadeId: z.string().uuid(),
        }),
        response: {
          200: CascadeDetailSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = app.appContext.db as PostgresJsDatabase;
      const redis = app.appContext.redis;
      const { spaceId, cascadeId } = request.params;

      const detail = await getCascadeDetail({
        db,
        redis,
        tenantId: tenant.tenantId,
        spaceId,
        cascadeId,
      });

      if (!detail) {
        return reply.status(404).send({ error: 'NotFound', message: 'Cascade not found' });
      }

      return detail;
    },
  );
};
