/**
 * The space's models on this computer (Plan 323 D10, D15): the diagnosis every
 * surface reads, and the operator's actions on the runtime — download, delete,
 * load, unload, and the window its requests get. Operator REST: Helmsman
 * reaches the same actions only through an approved card.
 *
 * Registered in every edition and refused outside the local one, where no
 * model runs on the operator's machine.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from '@aflow/redis';
import { createTenantContext, spaces, withTenantSchema } from '@aflow/database';
import {
  applyLocalModelAction,
  cancelLocalModelPull,
  diagnoseSpaceLocalRuntime,
  localRoleModels,
  resolveSpaceLocalRuntime,
  type LocalModelActionOutcome,
  type SpaceLocalRuntime,
} from '@aflow/cybernetic-runtime';
import {
  LocalModelActionSchema,
  LocalRuntimeDiagnosticsSchema,
  type DirectiveModelDefaults,
  type TenantId,
} from '@aflow/schemas';

const ErrorSchema = z.object({ error: z.string(), message: z.string() });

const OUTCOME_STATUS: Record<
  Extract<LocalModelActionOutcome, { ok: false }>['reason'],
  400 | 409 | 502
> = {
  not_local: 400,
  not_here: 400,
  no_disk: 409,
  runtime: 502,
};

const spaceAuthz = (action: 'read' | 'admin') => ({
  authz: {
    resource: 'space' as const,
    action,
    spaceIdFrom: 'param' as const,
    resourceIdFrom: 'param' as const,
    resourceIdParam: 'spaceId',
  },
});

export async function readModelDefaults(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<DirectiveModelDefaults | undefined> {
  const [row] = (await withTenantSchema(
    db,
    createTenantContext(tenantId as TenantId),
    async (tx: unknown) =>
      (tx as PostgresJsDatabase)
        .select({ directives: spaces.directives })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .limit(1),
  )) as Array<{ directives: { modelDefaults?: DirectiveModelDefaults } | null }>;
  return row?.directives?.modelDefaults;
}

export const localModelRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const db = (): PostgresJsDatabase => fastify.appContext.db as PostgresJsDatabase;
  const redis = (): Redis | undefined => fastify.appContext.redis as Redis | undefined;

  /** Null once it has answered the request itself: outside the local edition, or with no connection. */
  async function runtimeFor(
    request: Pick<FastifyRequest, 'requireTenant' | 'requireSpace' | 'authUser'>,
    spaceId: string,
    reply: FastifyReply,
    { requireConnection }: { requireConnection: boolean },
  ): Promise<{ runtime: SpaceLocalRuntime | null; tenantId: string } | null> {
    if (fastify.edition.edition !== 'community-local') {
      await reply.status(404).send({
        error: 'NotFound',
        message:
          'Models on this computer belong to the local edition, which runs on the machine they run on.',
      });
      return null;
    }
    const tenant = await request.requireTenant();
    await request.requireSpace();
    const runtime = await resolveSpaceLocalRuntime({
      db: db(),
      redis: redis(),
      tenantId: tenant.tenantId as string,
      userId: request.authUser?.userId as string,
      spaceId,
    });
    if (!runtime && requireConnection) {
      await reply.status(409).send({
        error: 'NoConnection',
        message: 'This space has no Ollama connection. Add one under Settings → Credentials.',
      });
      return null;
    }
    return { runtime, tenantId: tenant.tenantId as string };
  }

  app.get(
    '/:spaceId/local-models',
    {
      config: spaceAuthz('read'),
      schema: {
        tags: ['Spaces'],
        summary: "Diagnose the space's models on this computer",
        params: z.object({ spaceId: z.string().uuid() }),
        response: {
          200: z.object({ diagnostics: LocalRuntimeDiagnosticsSchema.nullable() }),
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const resolved = await runtimeFor(request, request.params.spaceId, reply, {
        requireConnection: false,
      });
      if (!resolved) return reply;
      if (!resolved.runtime) return reply.send({ diagnostics: null });
      const roles = localRoleModels(
        await readModelDefaults(db(), resolved.tenantId, request.params.spaceId),
      );
      return reply.send({
        diagnostics: await diagnoseSpaceLocalRuntime({
          runtime: resolved.runtime,
          redis: redis(),
          roles,
        }),
      });
    },
  );

  app.post(
    '/:spaceId/local-models/actions',
    {
      config: spaceAuthz('admin'),
      schema: {
        tags: ['Spaces'],
        summary: "Change the space's models on this computer",
        params: z.object({ spaceId: z.string().uuid() }),
        body: LocalModelActionSchema,
        response: {
          200: z.object({ message: z.string() }),
          400: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          502: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const resolved = await runtimeFor(request, request.params.spaceId, reply, {
        requireConnection: true,
      });
      if (!resolved?.runtime) return reply;
      const outcome = await applyLocalModelAction(
        {
          db: db(),
          redis: redis(),
          tenantId: resolved.tenantId,
          runtime: resolved.runtime,
          log: request.log,
        },
        request.body,
      );
      if (outcome.ok) return reply.send({ message: outcome.message });
      return reply
        .status(OUTCOME_STATUS[outcome.reason])
        .send({ error: outcome.reason, message: outcome.message });
    },
  );

  app.delete(
    '/:spaceId/local-models/pulls/:model',
    {
      config: spaceAuthz('admin'),
      schema: {
        tags: ['Spaces'],
        summary: 'Stop a download to this computer',
        params: z.object({ spaceId: z.string().uuid(), model: z.string().min(1) }),
        response: {
          200: z.object({ stopped: z.boolean() }),
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const resolved = await runtimeFor(request, request.params.spaceId, reply, {
        requireConnection: true,
      });
      if (!resolved?.runtime) return reply;
      const store = redis();
      const stopped = store
        ? await cancelLocalModelPull(store, resolved.runtime, request.params.model)
        : false;
      return reply.send({ stopped });
    },
  );
};
