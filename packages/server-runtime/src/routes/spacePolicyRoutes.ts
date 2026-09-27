/**
 * Space policy endpoints — rules, compute, coding lane, and write approval.
 *
 * Each policy is one column on `spaces` behind an identical read/replace pair,
 * so the routes are generated from a single definition per policy.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { createTenantContext, withTenantSchema, spaces } from '@aflow/database';
import {
  ComputeAvailabilitySchema,
  SpaceRulesSchema,
  SpaceComputePolicySchema,
  SpaceCodePolicySchema,
  SpaceWriteApprovalPolicySchema,
} from '@aflow/schemas';
import { readComputeAvailability } from '../services/computeAvailability.js';
import { ErrorSchema } from './spacesShared.js';
import type { EditionDescriptor } from '@aflow/schemas';

type TenantId = Parameters<typeof createTenantContext>[0];

interface SpacePolicyRoute<TBody extends z.ZodTypeAny> {
  path: string;
  /** Key of the `{ [field]: value }` request and response envelope. */
  field: string;
  readSummary: string;
  writeSummary: string;
  /** Value schema of the response envelope. */
  value: z.ZodTypeAny;
  /** Value schema of the request envelope. */
  body: TBody;
  select: (tx: PostgresJsDatabase, spaceId: string) => Promise<unknown[]>;
  update: (tx: PostgresJsDatabase, spaceId: string, value: z.infer<TBody>) => Promise<unknown[]>;
  /**
   * Refuses a value this deployment cannot honour, returning the reason. A
   * policy is an operator's decision about a runtime that exists; where one
   * does not, storing the decision would leave a workspace permitting work it
   * has no way to perform.
   */
  guard?: (value: z.infer<TBody>, edition: EditionDescriptor) => string | null;
  /**
   * State the stored decision depends on, returned beside it on read and write.
   * Asked each time rather than remembered, since it changes under the policy.
   */
  extra?: {
    shape: z.ZodRawShape;
    read: () => Promise<Record<string, unknown>>;
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin; route handlers use await
export const spacePolicyRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  const spaceIdParams = z.object({ spaceId: z.string().uuid() });

  async function firstRow(
    tenantId: TenantId,
    run: (tx: PostgresJsDatabase) => Promise<unknown[]>,
  ): Promise<Record<string, unknown> | undefined> {
    const db = fastify.appContext.db as PostgresJsDatabase;
    const rows = (await withTenantSchema(db, createTenantContext(tenantId), async (tx: unknown) =>
      run(tx as PostgresJsDatabase),
    )) as Array<Record<string, unknown>>;
    return rows[0];
  }

  function registerPolicy<TBody extends z.ZodTypeAny>(def: SpacePolicyRoute<TBody>): void {
    const envelope = z.object({ [def.field]: def.value, ...(def.extra?.shape ?? {}) });

    app.get(
      def.path,
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
          summary: def.readSummary,
          params: spaceIdParams,
          response: { 200: envelope, 404: ErrorSchema },
        },
      },
      async (request, reply) => {
        const tenant = await request.requireTenant();
        const { spaceId } = request.params;

        const row = await firstRow(tenant.tenantId, (tx) => def.select(tx, spaceId));
        if (!row) {
          return reply.status(404).send({ error: 'NotFound', message: 'Space not found' });
        }

        reply.send({ [def.field]: row[def.field], ...(await def.extra?.read()) });
      },
    );

    app.put(
      def.path,
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
          summary: def.writeSummary,
          params: spaceIdParams,
          body: z.object({ [def.field]: def.body }),
          response: { 200: envelope, 403: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema },
        },
      },
      async (request, reply) => {
        const tenant = await request.requireTenant();
        await request.requireSpace();
        const { spaceId } = request.params;
        const value = (request.body as Record<string, unknown>)[def.field] as z.infer<TBody>;

        const refusal = def.guard?.(value, fastify.edition);
        if (refusal !== undefined && refusal !== null) {
          return reply.status(409).send({ error: 'Conflict', message: refusal });
        }

        const row = await firstRow(tenant.tenantId, (tx) => def.update(tx, spaceId, value));
        if (!row) {
          return reply.status(404).send({ error: 'NotFound', message: 'Space not found' });
        }

        reply.send({ [def.field]: row[def.field], ...(await def.extra?.read()) });
      },
    );
  }

  registerPolicy({
    path: '/:spaceId/rules',
    field: 'rules',
    readSummary: 'Get space rules',
    writeSummary: 'Replace space rules',
    value: z.array(z.object({ text: z.string() })),
    body: SpaceRulesSchema,
    select: (tx, spaceId) =>
      tx.select({ rules: spaces.rules }).from(spaces).where(eq(spaces.id, spaceId)).limit(1),
    update: (tx, spaceId, value) =>
      tx
        .update(spaces)
        .set({ rules: value, updatedAt: new Date() })
        .where(eq(spaces.id, spaceId))
        .returning({ rules: spaces.rules }),
  });

  registerPolicy({
    path: '/:spaceId/compute-policy',
    field: 'computePolicy',
    readSummary: 'Get space compute policy',
    writeSummary: 'Replace space compute policy',
    value: SpaceComputePolicySchema.nullable(),
    body: SpaceComputePolicySchema.nullable(),
    extra: {
      shape: { computeAvailability: ComputeAvailabilitySchema },
      read: async () => ({
        computeAvailability: await readComputeAvailability(
          fastify.appContext.redis,
          fastify.edition,
        ),
      }),
    },
    // Only an explicit disable survives an absent runtime. Clearing the policy
    // to `null` is not the same as switching it off: the compute executor runs
    // a space carrying no policy, so an absent runtime plus a null policy is
    // the admissible-with-no-executor state this guard exists to prevent.
    guard: (value, edition) =>
      edition.computeRuntime === 'absent' && value?.enabled !== false
        ? 'This instance ships no compute runtime, so sandboxed code cannot run here ' +
          'whatever this policy says. Only an explicit disable is accepted until the ' +
          'instance is started with the compute profile.'
        : null,
    select: (tx, spaceId) =>
      tx
        .select({ computePolicy: spaces.computePolicy })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .limit(1),
    update: (tx, spaceId, value) =>
      tx
        .update(spaces)
        .set({ computePolicy: value, updatedAt: new Date() })
        .where(eq(spaces.id, spaceId))
        .returning({ computePolicy: spaces.computePolicy }),
  });

  registerPolicy({
    path: '/:spaceId/code-policy',
    field: 'codePolicy',
    readSummary: 'Get space coding-lane policy',
    writeSummary: 'Replace space coding-lane policy',
    value: SpaceCodePolicySchema.nullable(),
    body: SpaceCodePolicySchema.nullable(),
    select: (tx, spaceId) =>
      tx
        .select({ codePolicy: spaces.codePolicy })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .limit(1),
    update: (tx, spaceId, value) =>
      tx
        .update(spaces)
        .set({ codePolicy: value, updatedAt: new Date() })
        .where(eq(spaces.id, spaceId))
        .returning({ codePolicy: spaces.codePolicy }),
  });

  registerPolicy({
    path: '/:spaceId/write-policy',
    field: 'writePolicy',
    readSummary: 'Get space write-approval policy (Plan 253)',
    writeSummary: 'Replace space write-approval policy (Plan 253)',
    value: SpaceWriteApprovalPolicySchema.nullable(),
    body: SpaceWriteApprovalPolicySchema.nullable(),
    select: (tx, spaceId) =>
      tx
        .select({ writePolicy: spaces.writePolicy })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .limit(1),
    update: (tx, spaceId, value) =>
      tx
        .update(spaces)
        .set({ writePolicy: value, updatedAt: new Date() })
        .where(eq(spaces.id, spaceId))
        .returning({ writePolicy: spaces.writePolicy }),
  });
};
