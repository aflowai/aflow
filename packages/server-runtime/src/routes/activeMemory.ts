/**
 * Active-memory register endpoints (Plan 251).
 *
 * The promotion endpoint is the register's trust boundary: an entry becomes
 * `active` (injected into the Helmsman's turns) only through an authenticated
 * user action here — never through an agent op.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createTenantContext,
  loadActiveMemorySpaceState,
  mutateActiveMemoryRegister,
  type ActiveMemoryMutateOutcome,
} from '@aflow/database';
import { ActiveMemoryEntrySchema, admitForget, admitPromote, admitRevoke } from '@aflow/schemas';

const ErrorSchema = z.object({ error: z.string(), message: z.string() });

const EntryResponseSchema = ActiveMemoryEntrySchema.extend({
  expired: z.boolean(),
});

const ListResponseSchema = z.object({
  /** True only for a solo space (owner-only) — the eligibility gate for promotion/injection */
  eligible: z.boolean(),
  revision: z.number().int(),
  entries: z.array(EntryResponseSchema),
});

function toEntryResponse(
  entry: z.infer<typeof ActiveMemoryEntrySchema>,
  nowMs: number,
): z.infer<typeof EntryResponseSchema> {
  return {
    ...entry,
    expired: entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= nowMs,
  };
}

function outcomeError(outcome: ActiveMemoryMutateOutcome): {
  status: 404 | 409;
  body: { error: string; message: string };
} {
  switch (outcome.outcome) {
    case 'not_found':
      return { status: 404, body: { error: 'NotFound', message: 'Space not found' } };
    case 'register_invalid':
      return {
        status: 409,
        body: {
          error: 'ACTIVE_MEMORY_REGISTER_INVALID',
          message: 'The stored register is unreadable — repair or clear it.',
        },
      };
    case 'rejected':
      return { status: 409, body: { error: 'ACTIVE_MEMORY_REJECTED', message: outcome.error } };
    case 'conflict':
    case 'noop':
    case 'saved':
      return {
        status: 409,
        body: {
          error: 'ACTIVE_MEMORY_CONFLICT',
          message: 'The register changed concurrently — retry.',
        },
      };
  }
}

const SPACE_ADMIN_AUTHZ = {
  resource: 'space',
  action: 'admin',
  spaceIdFrom: 'param',
  resourceIdFrom: 'param',
  resourceIdParam: 'spaceId',
} as const;

// eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync signature
export const activeMemoryRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/:spaceId/active-memory',
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
        summary: 'List the active-memory register',
        params: z.object({ spaceId: z.string().uuid() }),
        response: { 200: ListResponseSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);
      const { spaceId } = request.params;

      const state = await loadActiveMemorySpaceState(db, tenantCtx, spaceId);
      if (!state) {
        return reply.status(404).send({ error: 'NotFound', message: 'Space not found' });
      }
      const nowMs = Date.now();
      reply.send({
        eligible: state.singleOwner,
        revision: state.register.revision,
        entries: state.register.entries.map((e) => toEntryResponse(e, nowMs)),
      });
    },
  );

  app.post(
    '/:spaceId/active-memory/:entryId/promote',
    {
      config: { authz: SPACE_ADMIN_AUTHZ },
      schema: {
        tags: ['Spaces'],
        summary: 'Promote a candidate entry to active (the trust boundary)',
        params: z.object({ spaceId: z.string().uuid(), entryId: z.string().min(1) }),
        response: {
          200: EntryResponseSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const userId = request.authUser?.userId;
      if (!userId) {
        return reply
          .status(401)
          .send({ error: 'Unauthorized', message: 'Promotion requires an authenticated user' });
      }
      const db = fastify.appContext.db as PostgresJsDatabase;
      const { spaceId, entryId } = request.params;

      const outcome = await mutateActiveMemoryRegister(
        db,
        createTenantContext(tenant.tenantId),
        spaceId,
        (state) => {
          if (!state.singleOwner) {
            return {
              ok: false,
              error: 'Active-memory promotion is available only in a space with no other members.',
            };
          }
          return admitPromote(state.register, entryId, {
            assertedByUserId: userId,
            nowIso: new Date().toISOString(),
          });
        },
      );
      if ((outcome.outcome === 'saved' || outcome.outcome === 'noop') && outcome.entry) {
        request.log.info(
          { action: 'active_memory.promote', spaceId, entryId, actorUserId: userId },
          'active-memory entry promoted',
        );
        return reply.send(toEntryResponse(outcome.entry, Date.now()));
      }
      const err = outcomeError(outcome);
      return reply.status(err.status).send(err.body);
    },
  );

  app.post(
    '/:spaceId/active-memory/:entryId/revoke',
    {
      config: { authz: SPACE_ADMIN_AUTHZ },
      schema: {
        tags: ['Spaces'],
        summary: 'Revoke an active entry (kept, no longer injected)',
        params: z.object({ spaceId: z.string().uuid(), entryId: z.string().min(1) }),
        response: {
          200: EntryResponseSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const { spaceId, entryId } = request.params;

      const outcome = await mutateActiveMemoryRegister(
        db,
        createTenantContext(tenant.tenantId),
        spaceId,
        (state) => admitRevoke(state.register, entryId, { nowIso: new Date().toISOString() }),
      );
      if ((outcome.outcome === 'saved' || outcome.outcome === 'noop') && outcome.entry) {
        request.log.info(
          { action: 'active_memory.revoke', spaceId, entryId },
          'active-memory entry revoked',
        );
        return reply.send(toEntryResponse(outcome.entry, Date.now()));
      }
      const err = outcomeError(outcome);
      return reply.status(err.status).send(err.body);
    },
  );

  app.delete(
    '/:spaceId/active-memory/:entryId',
    {
      config: { authz: SPACE_ADMIN_AUTHZ },
      schema: {
        tags: ['Spaces'],
        summary: 'Delete a register entry',
        params: z.object({ spaceId: z.string().uuid(), entryId: z.string().min(1) }),
        response: {
          200: z.object({ removed: z.boolean() }),
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const { spaceId, entryId } = request.params;

      const outcome = await mutateActiveMemoryRegister(
        db,
        createTenantContext(tenant.tenantId),
        spaceId,
        (state) => {
          const mutation = admitForget(state.register, entryId);
          if (!mutation.ok) return mutation;
          return mutation.removed
            ? { ok: true, register: mutation.register, noop: false }
            : { ok: true, register: state.register, noop: true };
        },
      );
      if (outcome.outcome === 'saved') {
        request.log.info(
          { action: 'active_memory.delete', spaceId, entryId },
          'active-memory entry deleted',
        );
        return reply.send({ removed: true });
      }
      if (outcome.outcome === 'noop') return reply.send({ removed: false });
      const err = outcomeError(outcome);
      return reply.status(err.status).send(err.body);
    },
  );
};
