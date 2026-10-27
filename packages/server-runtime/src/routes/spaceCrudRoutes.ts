import { validateAgentCapabilitySettings } from './agentCapabilityValidation.js';
/**
 * Space create, list, slug resolution, read, and update endpoints.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, isNull, isNotNull, sql } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  spaces,
  spaceDirectivesUpdateGuard,
  spaceMemberships,
} from '@aflow/database';
import { bumpSpaceContextGen } from '@aflow/redis';
import {
  SpaceRulesSchema,
  SpaceComputePolicySchema,
  SpaceCodePolicySchema,
  SpaceWriteApprovalPolicySchema,
  EntityDirectivesSchema,
} from '@aflow/schemas';
import { databaseErrorText } from '../lib/databaseErrors.js';
import {
  ErrorSchema,
  SpaceResponseSchema,
  toSpaceResponse,
  getSpaceMemberCount,
  allowedAgentModelRefs,
  offListAgentModelRefs,
  offListAgentModelError,
  introducedOffListModels,
  chosenModelRoles,
} from './spacesShared.js';
import { bootstrapCyberneticEntity } from '../services/entityBootstrap.js';
import {
  insertSpaceRecord,
  provisionCreatedSpace,
  spaceCreationFailure,
  validateSpaceCreation,
  type RawSql,
} from '../services/spaceProvisioning.js';
import { diffDirectiveKeys } from '../services/directiveDiff.js';

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin; route handlers use await
export const spaceCrudRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);
  app.post(
    '/',
    {
      config: { authz: { resource: 'space', action: 'read' } },
      // Validation fills `modelDefaults` from its schema defaults, which erases
      // the difference between a model the caller picked and one they never
      // mentioned. Only the body as it arrived still holds that, so the roles
      // actually named are captured here and read back after validation.
      preValidation: (request, _reply, done) => {
        const raw = request.body as
          { directives?: { modelDefaults?: Record<string, unknown> } } | undefined;
        chosenModelRoles.set(request, new Set(Object.keys(raw?.directives?.modelDefaults ?? {})));
        done();
      },
      schema: {
        tags: ['Spaces'],
        summary: 'Create space',
        body: z.object({
          name: z.string().min(1).max(255),
          // Accept up to 128 chars at the wire so validateSpaceSlug can
          // surface a typed `SLUG_INVALID` for slugs that fail strict
          // kebab/UUID-rejection — better UX than a raw 422.
          slug: z.string().min(1).max(128),
          description: z.string().max(2000).optional(),
          directives: EntityDirectivesSchema.optional(),
          computePolicy: SpaceComputePolicySchema.optional(),
          codePolicy: SpaceCodePolicySchema.optional(),
        }),
        response: {
          201: SpaceResponseSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          409: ErrorSchema,
          500: ErrorSchema,
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
      const { name, slug, description, directives, computePolicy, codePolicy } = request.body;

      const validated = await validateSpaceCreation({
        db,
        tenant,
        edition: fastify.edition,
        slug,
        directives,
        chosenModelRoles: chosenModelRoles.get(request) ?? new Set(),
      });
      if (!validated.ok) return reply.status(validated.status).send(validated.body);
      const resolvedDirectives = validated.directives;

      let row: Record<string, unknown> | null;
      try {
        row = await withTenantSchema(db, tenantCtx, async (tx) =>
          insertSpaceRecord(tx, {
            tenant,
            edition: fastify.edition,
            userId: authUser.userId,
            provisioning: validated.provisioning,
            name,
            slug,
            description,
            directives: resolvedDirectives,
            computePolicy,
            codePolicy,
          }),
        );
      } catch (err: unknown) {
        const failure = spaceCreationFailure(err, slug);
        if (failure) return reply.status(failure.status).send(failure.body);
        throw err;
      }

      if (!row) {
        return reply
          .status(500)
          .send({ error: 'InternalError', message: 'Failed to create space' });
      }

      const spaceId = row['id'] as string;
      const provisioned = await provisionCreatedSpace({
        db,
        sql: fastify.appContext.sql as RawSql,
        redis: fastify.appContext.redis,
        tenant,
        userId: authUser.userId,
        spaceId,
        directives: resolvedDirectives,
        log: fastify.log,
      });
      if (provisioned.helmsmanResolved) {
        row['defaultTargetKind'] = 'platform-role';
        row['default_target_kind'] = 'platform-role';
        row['defaultTargetSystemRole'] = 'cybernetic-helmsman';
        row['default_target_system_role'] = 'cybernetic-helmsman';
      }

      row['memberCount'] = 1;
      reply.status(201).send(toSpaceResponse(row));
    },
  );

  // GET /v1/spaces
  app.get(
    '/',
    {
      config: { authz: { resource: 'space', action: 'read' } },
      schema: {
        tags: ['Spaces'],
        summary: 'List spaces',
        querystring: z.object({
          status: z.enum(['active', 'archived', 'all']).default('active'),
        }),
        response: {
          200: z.object({ spaces: z.array(SpaceResponseSchema) }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);
      const { status } = request.query;
      const userId = request.authUser?.userId;

      // Look up user's space memberships first
      let membershipMap = new Map<string, string>();
      if (userId) {
        const memberships = await db
          .select({ spaceId: spaceMemberships.spaceId, role: spaceMemberships.role })
          .from(spaceMemberships)
          .where(
            and(
              eq(spaceMemberships.userId, userId),
              eq(spaceMemberships.tenantId, tenant.tenantId),
            ),
          );
        membershipMap = new Map(memberships.map((m) => [m.spaceId, m.role]));
      }

      const result = await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
        const conditions = [];
        if (status === 'active') {
          conditions.push(isNull(spaces.archivedAt));
        } else if (status === 'archived') {
          conditions.push(isNotNull(spaces.archivedAt));
        }
        // status === 'all' → no archive filter.

        if (!tenant.isAdmin && membershipMap.size > 0) {
          const memberSpaceIds = [...membershipMap.keys()];
          const { inArray } = await import('drizzle-orm');
          conditions.push(inArray(spaces.id, memberSpaceIds));
        } else if (!tenant.isAdmin && membershipMap.size === 0) {
          // User has no memberships → return empty
          return [];
        }

        const q = (tx as PostgresJsDatabase).select().from(spaces);
        if (conditions.length > 0) {
          return q.where(and(...conditions));
        }
        return q;
      });

      const rows = result as Array<Record<string, unknown>>;

      const spaceIds = rows.map((r) => r['id'] as string);
      const memberCounts = new Map<string, number>();
      if (spaceIds.length > 0) {
        const { inArray } = await import('drizzle-orm');
        const counts = await db
          .select({
            spaceId: spaceMemberships.spaceId,
            count: sql<number>`count(*)::int`,
          })
          .from(spaceMemberships)
          .where(
            and(
              eq(spaceMemberships.tenantId, tenant.tenantId),
              inArray(spaceMemberships.spaceId, spaceIds),
            ),
          )
          .groupBy(spaceMemberships.spaceId);
        for (const c of counts) memberCounts.set(c.spaceId, c.count);
      }

      type SpaceRole = 'admin' | 'editor' | 'viewer';
      const spacesWithRole = rows.map((r) => {
        const base = toSpaceResponse({
          ...r,
          memberCount: memberCounts.get(r['id'] as string) ?? 0,
        });
        const isOwner = userId !== undefined && base.ownerId === userId;
        const role =
          (membershipMap.get(base.id) as SpaceRole | undefined) ??
          (isOwner ? ('admin' as const) : null);
        if (role !== null) {
          return { ...base, myRole: role };
        }
        // Non-member rows appear only for tenant admins (management set):
        // the redacted metadata projection — no rules, directives, policies,
        // or default target.
        return {
          id: base.id,
          name: base.name,
          slug: base.slug,
          description: base.description,
          memberCount: base.memberCount,
          ownerId: base.ownerId,
          createdBy: base.createdBy,
          createdAt: base.createdAt,
          updatedAt: base.updatedAt,
          archivedAt: base.archivedAt,
          myRole: null,
        };
      });

      reply.send({ spaces: spacesWithRole });
    },
  );

  app.get(
    '/check-slug',
    {
      config: { authz: { resource: 'space', action: 'read' } },
      schema: {
        tags: ['Spaces'],
        summary: 'Check slug availability (discriminated status)',
        querystring: z.object({
          // Accept up to 128 chars at the wire so validateSpaceSlug can
          // return a clean `invalid` rather than the schema rejecting first.
          slug: z.string().min(1).max(128),
        }),
        response: {
          200: z.discriminatedUnion('status', [
            z.object({ status: z.literal('available') }),
            z.object({ status: z.literal('invalid'), code: z.string(), message: z.string() }),
            z.object({ status: z.literal('reserved'), message: z.string() }),
            z.object({ status: z.literal('taken') }),
            z.object({
              status: z.literal('retired'),
              message: z.string(),
              currentSlug: z.string().optional(),
            }),
          ]),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);
      const { slug } = request.query;

      // 1. Syntactic + reserved-word check via shared lib.
      const { validateSpaceSlug } = await import('@aflow/schemas');
      const validation = validateSpaceSlug(slug);
      if (!validation.ok) {
        if (validation.code === 'SLUG_INVALID') {
          return reply.send({
            status: 'invalid' as const,
            code: validation.code,
            message: validation.message,
          });
        }
        return reply.send({ status: 'reserved' as const, message: validation.message });
      }

      // 2. Live-table lookup.
      const liveRows = (await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
        return (tx as PostgresJsDatabase)
          .select({ id: spaces.id })
          .from(spaces)
          .where(eq(spaces.slug, slug))
          .limit(1);
      })) as Array<{ id: string }>;
      if (liveRows.length > 0) {
        return reply.send({ status: 'taken' as const });
      }

      // 3. History-reuse block — a slug retired in this tenant cannot be
      //    reused (by any space) until the history row is gone.
      const { spaceSlugHistory } = await import('@aflow/database');
      const historyRows = (await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
        return (tx as PostgresJsDatabase)
          .select({ spaceId: spaceSlugHistory.spaceId })
          .from(spaceSlugHistory)
          .where(eq(spaceSlugHistory.oldSlug, slug))
          .limit(1);
      })) as Array<{ spaceId: string }>;
      if (historyRows.length > 0) {
        const spaceId = historyRows[0]!.spaceId;
        const currentRows = (await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
          return (tx as PostgresJsDatabase)
            .select({ slug: spaces.slug })
            .from(spaces)
            .where(eq(spaces.id, spaceId))
            .limit(1);
        })) as Array<{ slug: string }>;
        const currentSlug = currentRows[0]?.slug;
        return reply.send({
          status: 'retired' as const,
          message: `"${slug}" is a retired slug from an existing space; reuse is blocked while history exists`,
          ...(currentSlug ? { currentSlug } : {}),
        });
      }

      return reply.send({ status: 'available' as const });
    },
  );

  // GET /v1/spaces/by-slug/:slug — resolve slug → SpaceResponse. History-aware
  // (renamed slugs resolve to the current canonical row + redirect annotation).
  app.get(
    '/by-slug/:slug',
    {
      config: { authz: { resource: 'space', action: 'read' } },
      schema: {
        tags: ['Spaces'],
        summary: 'Get space by slug (history-aware)',
        params: z.object({ slug: z.string().min(1).max(128) }),
        response: {
          200: SpaceResponseSchema.extend({
            redirect: z.object({ fromSlug: z.string(), toSlug: z.string() }).optional(),
          }),
          400: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const { slug } = request.params;

      const { SpaceSlugSchema } = await import('@aflow/schemas');
      const slugParse = SpaceSlugSchema.safeParse(slug);
      if (!slugParse.success) {
        return reply.status(400).send({
          error: 'ValidationError',
          message: `Invalid space slug: ${slugParse.error.issues[0]?.message ?? 'malformed'}`,
        });
      }

      try {
        const { resolveSpaceRef } = await import('@aflow/database');
        const resolved = await resolveSpaceRef(db, tenant.tenantId, { slug: slugParse.data });
        const spaceRow = resolved.space as unknown as Record<string, unknown>;
        const spaceId = spaceRow['id'] as string;
        spaceRow['memberCount'] = await getSpaceMemberCount(db, tenant.tenantId, spaceId);
        const response = toSpaceResponse(spaceRow);

        // The unscoped space:read grant only reaches this surface — content
        // requires membership/ownership, tenant admins get the redacted
        // metadata projection, everyone else learns nothing.
        const userId = request.authUser?.userId;
        let myRole: 'admin' | 'editor' | 'viewer' | null = null;
        if (userId) {
          const membership = await db
            .select({ role: spaceMemberships.role })
            .from(spaceMemberships)
            .where(
              and(
                eq(spaceMemberships.tenantId, tenant.tenantId),
                eq(spaceMemberships.spaceId, spaceId),
                eq(spaceMemberships.userId, userId),
              ),
            )
            .limit(1);
          myRole = (membership[0]?.role as 'admin' | 'editor' | 'viewer' | undefined) ?? null;
          if (myRole === null && response.ownerId === userId) myRole = 'admin';
        }

        if (myRole !== null) {
          reply.send({
            ...response,
            myRole,
            ...(resolved.redirect ? { redirect: resolved.redirect } : {}),
          });
          return;
        }
        if (tenant.isAdmin) {
          reply.send({
            id: response.id,
            name: response.name,
            slug: response.slug,
            description: response.description,
            memberCount: response.memberCount,
            ownerId: response.ownerId,
            createdBy: response.createdBy,
            createdAt: response.createdAt,
            updatedAt: response.updatedAt,
            archivedAt: response.archivedAt,
            myRole: null,
            ...(resolved.redirect ? { redirect: resolved.redirect } : {}),
          });
          return;
        }
        reply.status(404).send({ error: 'NotFound', message: 'Space not found' });
        return;
      } catch (err) {
        const { UnknownSpaceSlugError, ArchivedSpaceError } = await import('@aflow/database');
        if (err instanceof UnknownSpaceSlugError) {
          return reply.status(404).send({ error: 'NotFound', message: err.message });
        }
        if (err instanceof ArchivedSpaceError) {
          return reply.status(404).send({ error: 'NotFound', message: err.message });
        }
        throw err;
      }
    },
  );

  // GET /v1/spaces/where-is?resourceKind=agent&slug=foo
  //   Returns the subset of the user's accessible spaces that contain a live
  //   resource with the given slug. Powers the <NotInThisSpace> panel
  app.get(
    '/where-is',
    {
      config: { authz: { resource: 'space', action: 'read' } },
      schema: {
        tags: ['Spaces'],
        summary: 'Find spaces (accessible to me) that contain a resource',
        querystring: z.object({
          resourceKind: z.enum(['agent']),
          slug: z.string().min(1).max(128),
        }),
        response: {
          200: z.object({
            hits: z.array(
              z.object({
                spaceId: z.string().uuid(),
                spaceSlug: z.string(),
                spaceName: z.string(),
              }),
            ),
          }),
          400: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);
      const { slug } = request.query;

      const userId = request.authUser?.userId;
      if (!userId) {
        return reply.status(400).send({ error: 'Unauthorized', message: 'No user context' });
      }

      // `space_memberships` lives in the public schema and stores rows for
      //   every tenant; filter by tenantId so we never include a user's
      //   memberships from a different tenant in this where-is response.
      const membershipRows = (await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
        return (tx as PostgresJsDatabase)
          .select({ spaceId: spaceMemberships.spaceId })
          .from(spaceMemberships)
          .where(
            and(
              eq(spaceMemberships.userId, userId),
              eq(spaceMemberships.tenantId, tenant.tenantId),
            ),
          );
      })) as Array<{ spaceId: string }>;
      const memberSpaceIds = membershipRows.map((r) => r.spaceId);

      // Content access is membership-only for everyone — where-is answers
      // "which of MY spaces contain this resource", so the accessible set is
      // exactly the membership set.
      const accessibleSpaceIds: string[] = memberSpaceIds;

      const { findSpacesWithAgentSlug } = await import('@aflow/database');
      const hits = await findSpacesWithAgentSlug(db, tenant.tenantId, {
        agentSlug: slug,
        accessibleSpaceIds,
      });
      return reply.send({ hits });
    },
  );

  // GET /v1/spaces/:spaceId
  app.get(
    '/:spaceId',
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
        summary: 'Get space by ID',
        params: z.object({ spaceId: z.string().uuid() }),
        response: {
          200: SpaceResponseSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);
      const { spaceId } = request.params;

      const result = await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
        return (tx as PostgresJsDatabase)
          .select()
          .from(spaces)
          .where(eq(spaces.id, spaceId))
          .limit(1);
      });

      const row = (result as Array<Record<string, unknown>>)[0];
      if (!row) {
        return reply.status(404).send({ error: 'NotFound', message: 'Space not found' });
      }

      row['memberCount'] = await getSpaceMemberCount(db, tenant.tenantId, spaceId);
      reply.send(toSpaceResponse(row));
    },
  );

  // PATCH /v1/spaces/:spaceId
  app.patch(
    '/:spaceId',
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
        summary: 'Update space',
        params: z.object({ spaceId: z.string().uuid() }),
        body: z.object({
          name: z.string().min(1).max(255).optional(),
          slug: z.string().min(1).max(128).optional(),
          description: z.string().max(2000).nullable().optional(),
          defaultAgentId: z.string().max(255).nullable().optional(),
          rules: SpaceRulesSchema.optional(),
          computePolicy: SpaceComputePolicySchema.nullable().optional(),
          codePolicy: SpaceCodePolicySchema.nullable().optional(),
          writePolicy: SpaceWriteApprovalPolicySchema.nullable().optional(),
          // Every space is cybernetic — directives cannot be cleared to null.
          directives: EntityDirectivesSchema.optional(),
          expectedDirectives: z.unknown().optional(),
        }),
        response: {
          200: SpaceResponseSchema.extend({
            bootstrap: z
              .object({
                firstActivation: z.boolean(),
                durationMs: z.number(),
                createdArtifacts: z.array(z.string()),
                resolvedAgents: z.object({
                  helmsman: z.string(),
                  runner: z.string(),
                  coach: z.string(),
                }),
                emittedEvent: z.enum(['entity.space.bootstrapped', 'entity.directives.updated']),
                entityEventId: z.string().nullable(),
              })
              .nullable()
              .optional(),
            amendment: z
              .object({
                stagedChangeId: z.string().uuid(),
                status: z.enum(['ratified', 'proposed']),
                changedPaths: z.array(z.string()),
                constitutionalPaths: z.array(z.string()),
                entityEventId: z.string().nullable(),
                /** True when directives were NOT applied inline and operator action is required. */
                applied: z.boolean(),
              })
              .nullable()
              .optional(),
          }),
          400: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      // Space admins can edit name/slug/description; tenant admins can edit everything.
      // The authz plugin already enforced space:admin, so we just need to restrict
      // defaultAgentId to tenant admins only.
      await request.requireSpace();

      if (request.body.defaultAgentId !== undefined && !tenant.isAdmin) {
        return reply
          .status(403)
          .send({ error: 'Forbidden', message: 'Only tenant admins can change defaultAgentId' });
      }

      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);
      const { spaceId } = request.params;

      let priorSlugForRename: string | null = null;
      if (request.body.slug !== undefined) {
        const { validateSpaceSlug } = await import('@aflow/schemas');
        const slugValidation = validateSpaceSlug(request.body.slug);
        if (!slugValidation.ok) {
          return reply.status(400).send({
            error: slugValidation.code,
            message: slugValidation.message,
          });
        }
        // Pull the current live slug so we can decide whether anything is
        //   actually changing (no-op rename) and so the history insert sees
        //   the right `oldSlug`.
        const [priorRow] = (await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
          return (tx as PostgresJsDatabase)
            .select({ slug: spaces.slug })
            .from(spaces)
            .where(eq(spaces.id, spaceId))
            .limit(1);
        })) as Array<{ slug: string }>;
        if (priorRow && priorRow.slug !== request.body.slug) {
          priorSlugForRename = priorRow.slug;
        }
      }

      if (request.body.directives) {
        const allowedModels = await allowedAgentModelRefs(
          db,
          tenantCtx.tenantId,
          fastify.edition.edition,
        );
        const offListModels = offListAgentModelRefs(request.body.directives, allowedModels);
        if (offListModels.length > 0) {
          // Editors send the full modelDefaults object, so re-sending an
          // already-stored off-list model must pass — only moving TO an
          // off-list model is rejected.
          const [row] = (await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
            return (tx as PostgresJsDatabase)
              .select({ directives: spaces.directives })
              .from(spaces)
              .where(eq(spaces.id, spaceId))
              .limit(1);
          })) as Array<{ directives: { modelDefaults?: Record<string, string> } | null }>;
          // Per role, and by catalog id: a space-wide set of prior refs both
          // refuses a harmless renaming of what a role already holds (`luna`
          // re-saved as `gpt-6-luna`) and waves through a genuinely new
          // assignment whenever some other role happened to hold the same
          // excluded model.
          const introduced = introducedOffListModels(
            request.body.directives,
            row?.directives?.modelDefaults,
            allowedModels,
          );
          if (introduced.length > 0) {
            return reply.status(400).send(offListAgentModelError(introduced, allowedModels.ids));
          }
        }
      }

      const updates: Record<string, unknown> = {};
      if (request.body.name !== undefined) updates['name'] = request.body.name;
      if (request.body.slug !== undefined) updates['slug'] = request.body.slug;
      if (request.body.description !== undefined) updates['description'] = request.body.description;
      if (request.body.defaultAgentId !== undefined) {
        const value = request.body.defaultAgentId;
        if (value === null) {
          updates['defaultTargetKind'] = null;
          updates['defaultTargetSystemRole'] = null;
          updates['defaultTargetAgentId'] = null;
        } else {
          const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (UUID_RE.test(value)) {
            updates['defaultTargetKind'] = 'custom-agent';
            updates['defaultTargetSystemRole'] = null;
            updates['defaultTargetAgentId'] = value;
          } else {
            const { listPlatformAgents } = await import('@aflow/platform-artifacts');
            const platformRoles = new Set(listPlatformAgents().map((e) => e.systemRole));
            if (platformRoles.has(value)) {
              updates['defaultTargetKind'] = 'platform-role';
              updates['defaultTargetSystemRole'] = value;
              updates['defaultTargetAgentId'] = null;
            } else {
              // Unknown value — leave unchanged and warn.
              request.log.warn(
                { defaultAgentId: value },
                'defaultAgentId is neither a known platform systemRole nor a UUID; defaultTarget left unchanged',
              );
            }
          }
        }
      }
      if (request.body.rules !== undefined) updates['rules'] = request.body.rules;
      if (request.body.computePolicy !== undefined)
        updates['computePolicy'] = request.body.computePolicy;
      if (request.body.codePolicy !== undefined) updates['codePolicy'] = request.body.codePolicy;
      if (request.body.writePolicy !== undefined) updates['writePolicy'] = request.body.writePolicy;
      if (request.body.directives !== undefined) updates['directives'] = request.body.directives;

      if (request.body.directives !== undefined) {
        const placementError = await validateAgentCapabilitySettings(
          { db, tenantId: tenant.tenantId, spaceId },
          request.body.directives.capabilityDiscovery,
        );
        if (placementError) return reply.status(400).send(placementError);
      }

      if (Object.keys(updates).length === 0) {
        return reply.status(404).send({ error: 'BadRequest', message: 'No fields to update' });
      }

      updates['updatedAt'] = new Date();

      const shouldBootstrap = request.body.directives !== undefined;

      let priorDirectives: Record<string, unknown> | null = null;
      if (shouldBootstrap) {
        const priorRow = (await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
          return (tx as PostgresJsDatabase)
            .select({ directives: spaces.directives })
            .from(spaces)
            .where(eq(spaces.id, spaceId))
            .limit(1);
        })) as Array<{ directives: Record<string, unknown> | null }>;
        priorDirectives = priorRow[0]?.directives ?? null;
      }

      const didDbUpdate = Object.keys(updates).length > 0;

      interface SlugConflictResult {
        kind: 'slug_conflict';
        slug: string;
      }
      interface RowsResult {
        kind: 'rows';
        rows: Array<Record<string, unknown>>;
      }
      const updateResult: SlugConflictResult | RowsResult = didDbUpdate
        ? await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
            const typedTx = tx as PostgresJsDatabase;
            try {
              const { spaceSlugHistory } = await import('@aflow/database');
              if (priorSlugForRename && request.body.slug !== undefined) {
                const [retired] = await typedTx
                  .select({ id: spaceSlugHistory.id })
                  .from(spaceSlugHistory)
                  .where(eq(spaceSlugHistory.oldSlug, request.body.slug))
                  .limit(1);
                if (retired) {
                  return {
                    kind: 'slug_conflict',
                    slug: request.body.slug,
                  };
                }
              }
              const rows = await typedTx
                .update(spaces)
                .set(updates)
                .where(spaceDirectivesUpdateGuard(spaceId, request.body.expectedDirectives))
                .returning();
              if (rows.length > 0 && priorSlugForRename && request.body.slug !== undefined) {
                await typedTx.insert(spaceSlugHistory).values({
                  spaceId,
                  oldSlug: priorSlugForRename,
                  newSlug: request.body.slug,
                  renamedBy: request.authUser?.userId ?? null,
                });
              }
              return { kind: 'rows', rows: rows as Array<Record<string, unknown>> };
            } catch (err) {
              const message = databaseErrorText(err);
              if (
                message.includes('unique constraint') &&
                (message.includes('slug') || message.includes('old_slug'))
              ) {
                return {
                  kind: 'slug_conflict',
                  slug: request.body.slug ?? '<unknown>',
                };
              }
              throw err;
            }
          })
        : await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
            const rows = (await (tx as PostgresJsDatabase)
              .select()
              .from(spaces)
              .where(eq(spaces.id, spaceId))
              .limit(1)) as Array<Record<string, unknown>>;
            return { kind: 'rows', rows };
          });

      if (updateResult.kind === 'slug_conflict') {
        return reply.status(409).send({
          error: 'SLUG_TAKEN',
          message: `Slug "${updateResult.slug}" is already in use (live or retired) in this tenant`,
        });
      }

      const row = updateResult.rows[0];
      if (!row && request.body.expectedDirectives !== undefined) {
        return reply.status(409).send({
          error: 'DIRECTIVES_CHANGED',
          message:
            'Agent settings changed elsewhere. Reload before saving to preserve those changes.',
        });
      }
      if (!row) {
        return reply.status(404).send({ error: 'NotFound', message: 'Space not found' });
      }

      const redis = fastify.appContext.redis;
      if (didDbUpdate && 'directives' in updates && redis) {
        // Every session in the space caches these directives, and a terminal one
        // is not excused from the sweep: a FAILED session is retried from the
        // state it holds, and the failure being repaired is often the directive
        // itself — a run that died on a retired model would keep dying on it,
        // because the fix could not reach the cache it reads. The per-space
        // generation invalidates all of them in one INCR, so this costs nothing
        // per session and needs no session list at all.
        const bumped = await bumpSpaceContextGen(redis, tenant.tenantId, spaceId);
        if (bumped) {
          fastify.log.info({ spaceId }, 'Bumped SpaceContext generation after directive update');
        } else {
          fastify.log.warn(
            { spaceId },
            'Failed to invalidate cached SpaceContext; sessions will pick up changes after the 1h TTL',
          );
        }
      }

      // Bootstrap cybernetic entity on first directives set (idempotent on re-PATCH).
      let bootstrapSummary: {
        firstActivation: boolean;
        durationMs: number;
        createdArtifacts: string[];
        resolvedAgents: { helmsman: string; runner: string; coach: string };
        emittedEvent: 'entity.space.bootstrapped' | 'entity.directives.updated';
        entityEventId: string | null;
      } | null = null;

      // Directives apply directly (first activation or a subsequent edit) and
      // (re)bootstrap the cybernetic entity — no staging/approval step.
      if (shouldBootstrap && request.body.directives) {
        const isFirstActivation = priorDirectives === null;
        const nextDirectives = request.body.directives as Record<string, unknown>;
        const changedDirectiveKeys = isFirstActivation
          ? []
          : diffDirectiveKeys(priorDirectives, nextDirectives);

        try {
          const bootstrapResult = await bootstrapCyberneticEntity({
            tenantId: tenant.tenantId,
            spaceId,
            directives: request.body.directives,
            db,
            redis: fastify.appContext.redis,
            isFirstActivation,
            changedDirectiveKeys,
            operatorUserId: request.authUser?.userId,
          });
          fastify.log.info(
            {
              spaceId,
              created: bootstrapResult.created,
              resolvedAgents: bootstrapResult.resolvedAgents,
              emittedEvent: bootstrapResult.emittedEvent,
              firstActivation: bootstrapResult.firstActivation,
              durationMs: bootstrapResult.durationMs,
            },
            'Cybernetic entity bootstrap completed',
          );
          bootstrapSummary = {
            firstActivation: bootstrapResult.firstActivation,
            durationMs: bootstrapResult.durationMs,
            createdArtifacts: bootstrapResult.created,
            resolvedAgents: bootstrapResult.resolvedAgents,
            emittedEvent: bootstrapResult.emittedEvent,
            entityEventId: bootstrapResult.entityEventId,
          };
        } catch (err) {
          fastify.log.error({ err, spaceId }, 'Failed to bootstrap cybernetic entity');
          // Don't fail the PATCH — directives are saved; operator retries via
          // subsequent PATCH or UI retry button (102h §6).
        }
      }

      row['memberCount'] = await getSpaceMemberCount(db, tenant.tenantId, spaceId);
      reply.send({
        ...toSpaceResponse(row),
        bootstrap: bootstrapSummary,
      });
    },
  );
};
