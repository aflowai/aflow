/**
 * A space's memory embedding model and the state of its index (Plan 315 D12).
 *
 * Choosing a model re-indexes the space: vectors from two models cannot be
 * compared, so every embeddable document is embedded again, and search reads
 * only the chosen model's vectors meanwhile.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import {
  createMemoryDocRepository,
  createTenantContext,
  spaces,
  withTenantSchema,
} from '@aflow/database';
import { createMemoryEmbeddingResolver } from '@aflow/credential-resolver';
import { estimateEmbeddingTokensFromChars } from '@aflow/redis';
import {
  SetSpaceMemoryEmbeddingBodySchema,
  SpaceMemoryEmbeddingSchema,
  type MemoryEmbeddingStatus,
  type SpaceMemoryEmbedding,
} from '@aflow/schemas';
import { ErrorSchema } from './spacesShared.js';

type TenantId = Parameters<typeof createTenantContext>[0];

/** Everything an embedding of the previous model could have left behind. */
const REINDEX_FROM: readonly MemoryEmbeddingStatus[] = ['indexed', 'failed', 'unconfigured'];
const RETRY_FROM: readonly MemoryEmbeddingStatus[] = ['failed', 'unconfigured'];

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin; route handlers use await
export const spaceMemoryEmbeddingRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  const db = fastify.appContext.db as PostgresJsDatabase;
  const resolver = createMemoryEmbeddingResolver(db);
  const params = z.object({ spaceId: z.string().uuid() });
  const path = '/:spaceId/memory/embedding';

  async function view(tenantId: TenantId, spaceId: string): Promise<SpaceMemoryEmbedding> {
    const ctx = { tenantId: tenantId as string, spaceId };
    const repo = createMemoryDocRepository(db, createTenantContext(tenantId));
    const [embedding, choices, summary] = await Promise.all([
      resolver.resolve(ctx),
      resolver.choices(ctx),
      repo.embeddingSummary(spaceId),
    ]);
    const modelId = embedding.model?.id;
    return {
      model: choices.find((c) => c.id === modelId) ?? null,
      pinned: embedding.pinned,
      state: embedding.state,
      funding: embedding.state === 'ready' ? embedding.funding : null,
      reason: embedding.state === 'unconfigured' ? embedding.reason : null,
      choices,
      documents: summary.counts,
      reindexTokens: estimateEmbeddingTokensFromChars(summary.embeddableChars),
      lastError: summary.lastError
        ? { ...summary.lastError, at: summary.lastError.at.toISOString() }
        : null,
    };
  }

  app.get(
    path,
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
        summary: "Read the space's memory embedding model and index state",
        params,
        response: { 200: SpaceMemoryEmbeddingSchema, 404: ErrorSchema },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      return view(tenant.tenantId, request.params.spaceId);
    },
  );

  app.put(
    path,
    {
      config: {
        authz: {
          resource: 'space',
          action: 'admin',
          spaceIdFrom: 'param',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Spaces'],
        summary: "Choose the space's memory embedding model, re-indexing when it changes",
        params,
        body: SetSpaceMemoryEmbeddingBodySchema,
        response: { 200: SpaceMemoryEmbeddingSchema, 403: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      await request.requireSpace();
      const { spaceId } = request.params;
      const ctx = { tenantId: tenant.tenantId as string, spaceId };

      const model = resolver.embeddingModel(request.body.model);
      if (!model) {
        return reply.status(409).send({
          error: 'Conflict',
          message: `"${request.body.model}" is not an embedding model memory can store.`,
        });
      }
      const choice = (await resolver.choices(ctx)).find((c) => c.id === model.id);
      if (!choice?.available) {
        return reply.status(409).send({
          error: 'Conflict',
          message: choice?.unavailableReason ?? `${model.id} is not available to this space.`,
        });
      }

      const current = await resolver.resolve(ctx);
      const tenantContext = createTenantContext(tenant.tenantId);
      await withTenantSchema(db, tenantContext, async (tx) => {
        const txDb = tx;
        await txDb
          .update(spaces)
          .set({ memoryEmbeddingModel: model.id, updatedAt: new Date() })
          .where(eq(spaces.id, spaceId));
        if (current.model?.id !== model.id) {
          await createMemoryDocRepository(txDb, tenantContext, {
            inTransaction: true,
          }).markDocsPendingForEmbedding({ spaceId }, REINDEX_FROM);
        }
      });

      return view(tenant.tenantId, spaceId);
    },
  );

  app.post(
    `${path}/retry`,
    {
      config: {
        authz: {
          resource: 'space',
          action: 'admin',
          spaceIdFrom: 'param',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Spaces'],
        summary: 'Embed again every document whose embedding failed or had no provider',
        params,
        response: { 200: SpaceMemoryEmbeddingSchema, 403: ErrorSchema },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      await request.requireSpace();
      const { spaceId } = request.params;
      await createMemoryDocRepository(
        db,
        createTenantContext(tenant.tenantId),
      ).markDocsPendingForEmbedding({ spaceId }, RETRY_FROM);
      return view(tenant.tenantId, spaceId);
    },
  );
};
