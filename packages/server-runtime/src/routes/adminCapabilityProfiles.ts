/**
 * Capability profiles and per-space assignment.
 *
 * Separate from the operational admin surface because the authority these
 * endpoints administer is the agent ceiling every edition enforces, not the
 * hosted-support tooling that sits beside it.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  CapabilityEntrySchema,
  deriveCapabilityGroups,
  CreateCapabilityProfileSchema,
  UpdateCapabilityProfileSchema,
  AssignCapabilityProfileSchema,
} from '@aflow/schemas';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import {
  withTenantSchema,
  createTenantContext,
  capabilityProfiles,
  spaceCapabilityAssignments,
  type CapabilityProfileRow,
} from '@aflow/database';

const ErrorSchema = z.object({ error: z.string(), message: z.string() });

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin; route handlers use await
export const adminCapabilityProfileRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Auth is required
  app.addHook('preHandler', app.authenticate);

  app.addHook('preHandler', async (request, reply) => {
    const tenant = await request.requireTenant();
    if (!tenant.isAdmin) {
      // Returned, not just sent: an async hook short-circuits the chain on the
      // returned reply, and without it the handler still runs for a non-admin.
      return reply.status(403).send({ error: 'Forbidden', message: 'Admin access required' });
    }
    return undefined;
  });

  // -------------------------------------------------------------------------

  const CapabilityProfileResponseSchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable(),
    allowedCapabilities: z.array(CapabilityEntrySchema),
    deniedCapabilities: z.array(CapabilityEntrySchema),
    allowedRiskModifiers: z.array(z.string()),
    deniedRiskModifiers: z.array(z.string()),
    allowPrivileged: z.boolean(),
    isDefault: z.boolean(),
    isSystemProfile: z.boolean(),
    defaultForRole: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  });

  /** Convert a Drizzle profile row (JSONB) to a typed API response. */
  function profileToResponse(r: CapabilityProfileRow) {
    const ac = r.allowedCapabilities;
    const dc = r.deniedCapabilities;
    const arm = r.allowedRiskModifiers;
    const drm = r.deniedRiskModifiers;
    return {
      id: r.id,
      name: r.name,
      description: r.description ?? null,
      allowedCapabilities: (Array.isArray(ac) ? ac : []) as Array<{
        capabilityGroupId: string;
        accessMode: 'read' | 'write';
      }>,
      deniedCapabilities: (Array.isArray(dc) ? dc : []) as Array<{
        capabilityGroupId: string;
        accessMode: 'read' | 'write';
      }>,
      allowedRiskModifiers: (Array.isArray(arm) ? arm : []) as string[],
      deniedRiskModifiers: (Array.isArray(drm) ? drm : []) as string[],
      allowPrivileged: r.allowPrivileged,
      isDefault: r.isDefault,
      isSystemProfile: r.isSystemProfile,
      defaultForRole: r.defaultForRole ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  /**
   * The catalog a profile is composed from.
   *
   * Its own read, because it is a catalog and not a simulation. It used to be
   * reachable only as a field on `POST /admin/authz/simulate` — a
   * hosted-support debugging surface — which made the profile editor depend on
   * a route this edition does not serve, and offered zero capabilities to
   * select where it does not.
   */
  app.get(
    '/capability-groups',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Admin'],
        summary: 'List selectable capability groups',
        response: {
          200: z.object({
            capabilityGroups: z.array(
              z.object({
                capabilityGroupId: z.string(),
                label: z.string(),
                description: z.string(),
                supportedAccessModes: z.array(z.enum(['read', 'write'])),
              }),
            ),
          }),
        },
      },
    },
    (_request, reply) => {
      reply.send({
        capabilityGroups: Array.from(deriveCapabilityGroups().values()).map((group) => ({
          capabilityGroupId: group.capabilityGroupId,
          label: group.label,
          description: group.description,
          supportedAccessModes: [...group.supportedAccessModes],
        })),
      });
    },
  );

  // GET /admin/capability-profiles
  app.get(
    '/capability-profiles',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Admin'],
        summary: 'List capability profiles',
        response: { 200: z.object({ profiles: z.array(CapabilityProfileResponseSchema) }) },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);

      const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
        tx.select().from(capabilityProfiles).orderBy(capabilityProfiles.createdAt),
      );

      const profiles = rows.map((r) => profileToResponse(r));

      reply.send({ profiles });
    },
  );

  // POST /admin/capability-profiles
  app.post(
    '/capability-profiles',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Admin'],
        summary: 'Create a capability profile',
        body: CreateCapabilityProfileSchema,
        response: {
          201: CapabilityProfileResponseSchema,
          409: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);
      const body = request.body;

      const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
        // If setting as default for a role, unset existing default first
        if (body.defaultForRole) {
          await tx
            .update(capabilityProfiles)
            .set({ isDefault: false, defaultForRole: null })
            .where(
              and(
                eq(capabilityProfiles.isDefault, true),
                eq(capabilityProfiles.defaultForRole, body.defaultForRole),
                eq(capabilityProfiles.isSystemProfile, false),
              ),
            );
        }

        return tx
          .insert(capabilityProfiles)
          .values({
            name: body.name,
            description: body.description ?? null,
            allowedCapabilities: body.allowedCapabilities,
            deniedCapabilities: body.deniedCapabilities,
            allowedRiskModifiers: body.allowedRiskModifiers,
            deniedRiskModifiers: body.deniedRiskModifiers,
            allowPrivileged: body.allowPrivileged,
            isDefault: body.isDefault,
            isSystemProfile: false,
            defaultForRole: body.defaultForRole ?? null,
          })
          .returning();
      });

      const r = rows[0];
      if (!r) {
        return reply
          .status(500)
          .send({ error: 'InternalError', message: 'Failed to create profile' });
      }
      reply.status(201).send(profileToResponse(r));
    },
  );

  // GET /admin/capability-profiles/:profileId
  app.get(
    '/capability-profiles/:profileId',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Admin'],
        summary: 'Get a capability profile',
        params: z.object({ profileId: z.string().uuid() }),
        response: { 200: CapabilityProfileResponseSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);
      const { profileId } = request.params as { profileId: string };

      const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
        tx.select().from(capabilityProfiles).where(eq(capabilityProfiles.id, profileId)).limit(1),
      );

      const r = rows[0];
      if (!r) {
        reply.status(404).send({ error: 'NotFound', message: 'Profile not found' });
        return;
      }

      reply.send(profileToResponse(r));
    },
  );

  // PUT /admin/capability-profiles/:profileId
  app.put(
    '/capability-profiles/:profileId',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Admin'],
        summary: 'Update a capability profile',
        params: z.object({ profileId: z.string().uuid() }),
        body: UpdateCapabilityProfileSchema,
        response: { 200: CapabilityProfileResponseSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);
      const { profileId } = request.params as { profileId: string };
      const body = request.body;

      const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
        // Check if system profile
        const existing = await tx
          .select()
          .from(capabilityProfiles)
          .where(eq(capabilityProfiles.id, profileId))
          .limit(1);
        if (!existing[0]) return null;
        if (existing[0].isSystemProfile) return 'system';

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (body.name !== undefined) updates['name'] = body.name;
        if (body.description !== undefined) updates['description'] = body.description;
        if (body.allowedCapabilities !== undefined)
          updates['allowedCapabilities'] = body.allowedCapabilities;
        if (body.deniedCapabilities !== undefined)
          updates['deniedCapabilities'] = body.deniedCapabilities;
        if (body.allowedRiskModifiers !== undefined)
          updates['allowedRiskModifiers'] = body.allowedRiskModifiers;
        if (body.deniedRiskModifiers !== undefined)
          updates['deniedRiskModifiers'] = body.deniedRiskModifiers;
        if (body.allowPrivileged !== undefined) updates['allowPrivileged'] = body.allowPrivileged;
        if (body.isDefault !== undefined) updates['isDefault'] = body.isDefault;
        if (body.defaultForRole !== undefined) updates['defaultForRole'] = body.defaultForRole;

        return tx
          .update(capabilityProfiles)
          .set(updates)
          .where(eq(capabilityProfiles.id, profileId))
          .returning();
      });

      if (rows === null) {
        reply.status(404).send({ error: 'NotFound', message: 'Profile not found' });
        return;
      }
      if (rows === 'system') {
        reply.status(403).send({ error: 'Forbidden', message: 'System profiles cannot be edited' });
        return;
      }

      const r = rows[0];
      if (!r) {
        return reply.status(404).send({ error: 'NotFound', message: 'Profile not found' });
      }
      reply.send(profileToResponse(r));
    },
  );

  // DELETE /admin/capability-profiles/:profileId
  app.delete(
    '/capability-profiles/:profileId',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Admin'],
        summary: 'Delete a capability profile',
        params: z.object({ profileId: z.string().uuid() }),
        response: {
          200: z.object({ deleted: z.boolean() }),
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);
      const { profileId } = request.params as { profileId: string };

      const result = await withTenantSchema(db, tenantCtx, async (tx) => {
        const existing = await tx
          .select()
          .from(capabilityProfiles)
          .where(eq(capabilityProfiles.id, profileId))
          .limit(1);
        if (!existing[0]) return 'not_found';
        if (existing[0].isSystemProfile) return 'system';

        // Check if assigned to any spaces
        const assignments = await tx
          .select({ spaceId: spaceCapabilityAssignments.spaceId })
          .from(spaceCapabilityAssignments)
          .where(eq(spaceCapabilityAssignments.profileId, profileId));
        if (assignments.length > 0) return 'assigned';

        await tx.delete(capabilityProfiles).where(eq(capabilityProfiles.id, profileId));
        return 'deleted';
      });

      if (result === 'not_found') {
        reply.status(404).send({ error: 'NotFound', message: 'Profile not found' });
      } else if (result === 'system') {
        reply
          .status(403)
          .send({ error: 'Forbidden', message: 'System profiles cannot be deleted' });
      } else if (result === 'assigned') {
        reply.status(409).send({
          error: 'Conflict',
          message: 'Profile is assigned to spaces. Remove assignments first.',
        });
      } else {
        reply.send({ deleted: true });
      }
    },
  );

  // -------------------------------------------------------------------------

  // GET /admin/spaces/:spaceId/capability-assignment
  app.get(
    '/spaces/:spaceId/capability-assignment',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Admin'],
        summary: 'Get space capability assignment',
        params: z.object({ spaceId: z.string().uuid() }),
        response: {
          200: z.object({
            spaceId: z.string(),
            profileId: z.string().nullable(),
            profileName: z.string().nullable(),
            assignedBy: z.string().nullable(),
            assignedAt: z.string().nullable(),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);
      const { spaceId } = request.params as { spaceId: string };

      const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .select({
            spaceId: spaceCapabilityAssignments.spaceId,
            profileId: spaceCapabilityAssignments.profileId,
            assignedBy: spaceCapabilityAssignments.assignedBy,
            assignedAt: spaceCapabilityAssignments.assignedAt,
            profileName: capabilityProfiles.name,
          })
          .from(spaceCapabilityAssignments)
          .leftJoin(
            capabilityProfiles,
            eq(spaceCapabilityAssignments.profileId, capabilityProfiles.id),
          )
          .where(eq(spaceCapabilityAssignments.spaceId, spaceId))
          .limit(1),
      );

      const row = rows[0];
      reply.send({
        spaceId,
        profileId: row?.profileId ?? null,
        profileName: row?.profileName ?? null,
        assignedBy: row?.assignedBy ?? null,
        assignedAt: row?.assignedAt != null ? row.assignedAt.toISOString() : null,
      });
    },
  );

  // PUT /admin/spaces/:spaceId/capability-assignment
  app.put(
    '/spaces/:spaceId/capability-assignment',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Admin'],
        summary: 'Assign a capability profile to a space',
        params: z.object({ spaceId: z.string().uuid() }),
        body: AssignCapabilityProfileSchema,
        response: {
          200: z.object({ spaceId: z.string(), profileId: z.string() }),
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const authUser = request.authUser;
      if (!authUser) {
        return reply
          .status(401)
          .send({ error: 'Unauthorized', message: 'Authentication required' });
      }
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);
      const { spaceId } = request.params as { spaceId: string };
      const { profileId } = request.body;

      const result = await withTenantSchema(db, tenantCtx, async (tx) => {
        // Verify profile exists
        const profiles = await tx
          .select({ id: capabilityProfiles.id })
          .from(capabilityProfiles)
          .where(eq(capabilityProfiles.id, profileId))
          .limit(1);
        if (!profiles[0]) return 'profile_not_found';

        // Upsert assignment
        await tx
          .insert(spaceCapabilityAssignments)
          .values({
            spaceId,
            profileId,
            assignedBy: authUser.userId,
          })
          .onConflictDoUpdate({
            target: spaceCapabilityAssignments.spaceId,
            set: {
              profileId,
              assignedBy: authUser.userId,
              assignedAt: new Date(),
            },
          });

        return 'ok';
      });

      if (result === 'profile_not_found') {
        reply.status(404).send({ error: 'NotFound', message: 'Profile not found' });
        return;
      }

      reply.send({ spaceId, profileId });
    },
  );

  // DELETE /admin/spaces/:spaceId/capability-assignment
  app.delete(
    '/spaces/:spaceId/capability-assignment',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Admin'],
        summary: 'Remove space capability assignment (revert to role default)',
        params: z.object({ spaceId: z.string().uuid() }),
        response: { 200: z.object({ spaceId: z.string(), reverted: z.boolean() }) },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);
      const { spaceId } = request.params as { spaceId: string };

      await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .delete(spaceCapabilityAssignments)
          .where(eq(spaceCapabilityAssignments.spaceId, spaceId)),
      );

      reply.send({ spaceId, reverted: true });
    },
  );
};
