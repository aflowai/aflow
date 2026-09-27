/**
 * Applet instance surfaces — the human write path onto the single gateway.
 *
 * Every mutation goes through `applyAppletCommand`; these routes only
 * authenticate, authorize against the instance's space, stamp the actor and
 * the caller's space role (never client-supplied), and publish the realtime
 * delta after the transaction commits. Instance routes are addressed by
 * instanceId, so — like session-content routes — the space-scoped permission
 * check re-runs against the space resolved from the instance row.
 */
import { randomUUID } from 'node:crypto';
import { resolveUserLabels, rosterUserLabel } from '@aflow/cybernetic-runtime';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import {
  createAppletPersistence,
  createTenantContext,
  listInstalledAppletDefinitions,
  spaces,
  withTenantSchema,
} from '@aflow/database';
import {
  applyAppletCommand,
  AppletPersistenceError,
  AppletSchemaSafetyError,
  projectAppletAttention,
  projectRecentReceipts,
  validateAgainstAppletSchema,
  type AppletPersistence,
} from '@aflow/applet-runtime';
import { resolveSpaceRole as resolveSpaceMembershipRole } from '@aflow/authz';
import {
  AppletActionReceiptSchema,
  AppletCommandSchema,
  AppletInstanceSchema,
  AppletInstanceStatusSchema,
  AppletInstanceSummarySchema,
  AppletRoleIdSchema,
  AppletStateVersionSchema,
  appletStatePath,
  deriveInstalledAppletEntries,
  InstalledAppletSummarySchema,
  APPLET_MAX_ROLES,
  APPLET_REFUSAL_MESSAGE_MAX_LENGTH,
  APPLET_SEAT_LABEL_MAX_LENGTH,
  PhoenixAppletSeatSchema,
  PhoenixAppletViewerSchema,
  type AppletActor,
  type AppletInstance,
  type SpaceRole,
  type TenantId,
} from '@aflow/schemas';
import { resolveAppletInstanceSpaceId } from '../lib/appletInstanceLookup.js';
import { canReadSpace } from './realtimeTopics/authz.js';
import {
  createAppletEffectsRelay,
  type AppletEffectsRelay,
} from '../services/appletEffectsRelay.js';
import { createSessionService, postRoomMessageDirect } from '../services/sessions.js';
import { buildActorContext } from '../utils/actorContext.js';

const ErrorSchema = z.object({ error: z.string(), message: z.string() });

const InstantiateBodySchema = z
  .object({
    /** Exact published version to pin. */
    artifactVersionId: z.string().uuid().optional(),
    /** Artifact head — the server resolves its current published version. */
    artifactId: z.string().uuid().optional(),
    roles: z
      .array(z.object({ userId: z.string().uuid(), role: AppletRoleIdSchema }))
      .max(32)
      .optional(),
  })
  .superRefine((body, ctx) => {
    if ((body.artifactVersionId === undefined) === (body.artifactId === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Exactly one of artifactVersionId or artifactId is required',
      });
    }
  });

const InstantiateResponseSchema = z.object({
  instance: AppletInstanceSchema,
  state: z.record(z.unknown()),
  stateVersion: AppletStateVersionSchema,
});

const ListResponseSchema = z.object({
  applets: z.array(AppletInstanceSummarySchema),
  total: z.number().int().nonnegative(),
  /** Installed applet definitions with live-instance counts — only with ?include=installed. */
  installed: z.array(InstalledAppletSummarySchema).optional(),
});

const GetResponseSchema = z.object({
  instance: AppletInstanceSchema,
  definition: z.record(z.unknown()),
  state: z.record(z.unknown()),
  stateVersion: AppletStateVersionSchema,
  /** Oldest first, bounded by the definition's recentActionsLimit. */
  recentReceipts: z.array(AppletActionReceiptSchema),
  viewer: PhoenixAppletViewerSchema,
  /** Who holds which declared seat — labels for people, resolved server-side, never emails. */
  seats: z.array(PhoenixAppletSeatSchema).max(APPLET_MAX_ROLES).optional(),
});

const ActionAppliedResponseSchema = z.object({
  receipt: AppletActionReceiptSchema,
  stateVersion: AppletStateVersionSchema,
  /** True when a known actionId replayed — the state did not move again. */
  replayed: z.boolean(),
});

const ActionConflictResponseSchema = z.object({
  currentVersion: AppletStateVersionSchema,
});

/**
 * What a refusal may say on the wire. A failed `test` op carries fast-json-patch's
 * dump of the whole state, which grows with the document and is a routine
 * concurrent-edit outcome — so the first line is the reason and the rest is the
 * evidence the room cannot read anyway.
 */
function refusalMessage(message: string): string {
  const firstLine = message.split('\n', 1)[0] ?? message;
  return firstLine.length > APPLET_REFUSAL_MESSAGE_MAX_LENGTH
    ? `${firstLine.slice(0, APPLET_REFUSAL_MESSAGE_MAX_LENGTH - 1)}…`
    : firstLine;
}

const ActionRejectedResponseSchema = z.object({
  reason: z.string(),
  message: z.string().max(APPLET_REFUSAL_MESSAGE_MAX_LENGTH),
  /** The declared surface — never domain legality, which the platform cannot judge. */
  availableActions: z.array(z.string()),
  validation: z.array(z.string()).optional(),
});

export interface AppletsRoutesOptions {
  /** Injection seam for tests — production wiring builds the relay from appContext. */
  effectsRelay?: AppletEffectsRelay;
}

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
export const appletsRoutes: FastifyPluginAsync<AppletsRoutesOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  function requireDb(): PostgresJsDatabase {
    const db = fastify.appContext.db as PostgresJsDatabase | null;
    if (!db) throw fastify.httpErrors.serviceUnavailable('Applets require a database');
    return db;
  }

  function persistenceFor(tenantId: TenantId): AppletPersistence {
    return createAppletPersistence(requireDb(), createTenantContext(tenantId));
  }

  // Built lazily: appContext.db may be absent at registration (mock mode), and
  // every path that reaches the relay has already required the database.
  let relay: AppletEffectsRelay | null = opts.effectsRelay ?? null;
  function effectsRelay(): AppletEffectsRelay {
    if (relay !== null) return relay;
    const db = requireDb();
    const sessionService = createSessionService(fastify.appContext);
    relay = createAppletEffectsRelay({
      db,
      redis: fastify.appContext.redis,
      persistenceFor,
      postRoomMessage: (input) => {
        const redis = fastify.appContext.redis;
        if (!redis) throw new Error('Room messages require Redis');
        return postRoomMessageDirect(redis, db, input);
      },
      resumeSession: (request) => sessionService.resumeSession(request),
      log: (message, err) => {
        fastify.log.warn({ err }, message);
      },
    });
    return relay;
  }

  // ==========================================================================
  // POST /v1/applets — instantiate
  // ==========================================================================
  app.post(
    '/',
    {
      config: { authz: { resource: 'memory', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Applets'],
        summary: 'Instantiate an applet from a published artifact version',
        body: InstantiateBodySchema,
        response: {
          201: InstantiateResponseSchema,
          404: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const userId = request.authUser?.userId ?? null;
      const { artifactVersionId, artifactId, roles } = request.body;

      const result = await persistenceFor(tenant.tenantId).transact(async (tx) => {
        const resolution = await tx.resolveAppletArtifact({
          spaceId: space.spaceId,
          ...(artifactVersionId !== undefined
            ? { versionId: artifactVersionId }
            : { artifactId: artifactId! }),
        });
        if (resolution.outcome !== 'resolved') return resolution;

        const { definition, definitionHash } = resolution;
        const declaredRoles = new Set((definition.roles ?? []).map((role) => role.id));
        const unknownRole = (roles ?? []).find((binding) => !declaredRoles.has(binding.role));
        if (unknownRole) {
          return { outcome: 'unknown_role' as const, role: unknownRole.role };
        }

        try {
          const check = validateAgainstAppletSchema({
            schema: definition.stateSchema,
            cacheKey: `${definitionHash}#state`,
            data: definition.initialState,
          });
          if (!check.valid) {
            return { outcome: 'invalid_initial_state' as const, errors: check.errors };
          }
        } catch (err) {
          if (err instanceof AppletSchemaSafetyError) {
            return { outcome: 'unsafe_schema' as const, message: err.message };
          }
          throw err;
        }

        const instanceId = randomUUID();
        const now = new Date().toISOString();
        const instance: AppletInstance = {
          instanceId,
          spaceId: space.spaceId,
          appletKey: definition.appletKey,
          definitionHash,
          artifactVersionId: resolution.artifactVersionId,
          statePath: appletStatePath(instanceId),
          status: 'active',
          boundSessionId: null,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        };
        const seen = new Set<string>();
        const roleBindings = (roles ?? [])
          .filter((binding) => {
            const key = `${binding.userId}:${binding.role}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .map((binding) => ({ userId: binding.userId, roleId: binding.role }));

        const stateVersion = await tx.createInstance({
          instance,
          initialState: definition.initialState,
          roleBindings,
        });
        return {
          outcome: 'created' as const,
          instance,
          state: definition.initialState,
          stateVersion,
        };
      });

      switch (result.outcome) {
        case 'created':
          reply.code(201).send({
            instance: result.instance,
            state: result.state,
            stateVersion: result.stateVersion,
          });
          return;
        case 'not_found':
          reply.code(404).send({ error: 'NotFound', message: 'Applet artifact not found' });
          return;
        case 'not_an_applet':
          reply.code(422).send({
            error: 'NotAnApplet',
            message: `Artifact version '${result.artifactVersionId}' carries no applet definition`,
          });
          return;
        case 'definition_invalid':
          reply.code(422).send({
            error: 'DefinitionInvalid',
            message: `Pinned definition does not parse: ${result.message}`,
          });
          return;
        case 'unknown_role':
          reply.code(422).send({
            error: 'UnknownRole',
            message: `Role '${result.role}' is not declared by this applet`,
          });
          return;
        case 'unsafe_schema':
          reply.code(422).send({ error: 'UnsafeSchema', message: result.message });
          return;
        case 'invalid_initial_state':
          reply.code(422).send({
            error: 'InvalidInitialState',
            message: `initialState does not match the stateSchema: ${result.errors.join('; ')}`,
          });
          return;
      }
    },
  );

  // ==========================================================================
  // GET /v1/applets — space-scoped list
  // ==========================================================================
  app.get(
    '/',
    {
      config: { authz: { resource: 'memory', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Applets'],
        summary: 'List applet instances in the space',
        querystring: z.object({
          spaceId: z.string().uuid().optional(),
          status: AppletInstanceStatusSchema.default('active'),
          appletKey: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          offset: z.coerce.number().int().min(0).default(0),
          include: z.literal('installed').optional(),
        }),
        response: { 200: ListResponseSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const { status, appletKey, limit, offset, include } = request.query;

      const { items, total } = await persistenceFor(tenant.tenantId).transact(async (tx) =>
        tx.listInstances({
          spaceId: space.spaceId,
          status,
          ...(appletKey !== undefined ? { appletKey } : {}),
          limit,
          offset,
        }),
      );

      const installed =
        include === 'installed'
          ? deriveInstalledAppletEntries(
              await listInstalledAppletDefinitions(
                requireDb(),
                createTenantContext(tenant.tenantId),
                space.spaceId,
              ),
            )
          : undefined;

      reply.send({
        applets: items.map((item) => {
          const attention = projectAppletAttention(item.state, item.definition.attentionProjection);
          return {
            ...item.instance,
            stateVersion: item.stateVersion,
            ...(item.lastReceipt !== undefined ? { lastReceipt: item.lastReceipt } : {}),
            ...(attention !== undefined ? { attention } : {}),
          };
        }),
        total,
        ...(installed !== undefined ? { installed } : {}),
      });
    },
  );

  // ==========================================================================
  // GET /v1/applets/:instanceId — state + recent receipts + viewer
  // ==========================================================================
  app.get(
    '/:instanceId',
    {
      config: { authz: { resource: 'memory', action: 'read', spaceIdFrom: 'none' } },
      schema: {
        tags: ['Applets'],
        summary: 'Read an applet instance: state, recent receipts, and the viewer derivation',
        params: z.object({ instanceId: z.string().uuid() }),
        response: { 200: GetResponseSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { instanceId } = request.params;
      const spaceId = await assertInstanceSpaceAccess(fastify, request, reply, {
        tenantId: tenant.tenantId,
        instanceId,
        action: 'read',
      });
      if (spaceId === null) return;

      const loaded = await persistenceFor(tenant.tenantId).transact(async (tx) => {
        const record = await tx.loadInstanceForUpdate(instanceId);
        if (record === null) return null;
        const bindings = await tx.listRoleBindings(instanceId);
        const receipts = await tx.listRecentReceipts(
          instanceId,
          record.definition.recentActionsLimit,
        );
        return { record, bindings, receipts };
      });
      if (loaded === null) {
        reply.code(404).send({ error: 'NotFound', message: 'Applet instance not found' });
        return;
      }

      const userId = request.authUser!.userId;
      const spaceRole =
        (await resolveViewerSpaceRole(fastify, request, tenant.tenantId, spaceId)) ?? 'viewer';
      const seatLabels = await resolveUserLabels(
        requireDb(),
        loaded.bindings.map((binding) => binding.userId),
      );

      reply.send({
        instance: loaded.record.instance,
        definition: loaded.record.definition,
        state: loaded.record.state,
        stateVersion: loaded.record.stateVersion,
        recentReceipts: projectRecentReceipts(
          loaded.receipts,
          loaded.record.definition.recentActionsLimit,
        ),
        viewer: {
          userId,
          spaceRole,
          appletRoles: loaded.bindings
            .filter((binding) => binding.userId === userId)
            .map((binding) => binding.roleId),
        },
        seats: loaded.bindings.slice(0, APPLET_MAX_ROLES).map((binding) => ({
          roleId: binding.roleId,
          displayName: rosterUserLabel(seatLabels.get(binding.userId), binding.userId).slice(
            0,
            APPLET_SEAT_LABEL_MAX_LENGTH,
          ),
        })),
      });
    },
  );

  // ==========================================================================
  // POST /v1/applets/:instanceId/actions — the human write path
  // ==========================================================================
  app.post(
    '/:instanceId/actions',
    {
      config: { authz: { resource: 'memory', action: 'write', spaceIdFrom: 'none' } },
      schema: {
        tags: ['Applets'],
        summary: 'Apply a command to an applet instance through the gateway',
        params: z.object({ instanceId: z.string().uuid() }),
        body: AppletCommandSchema,
        response: {
          200: ActionAppliedResponseSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ActionConflictResponseSchema,
          422: ActionRejectedResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { instanceId } = request.params;
      const spaceId = await assertInstanceSpaceAccess(fastify, request, reply, {
        tenantId: tenant.tenantId,
        instanceId,
        action: 'write',
      });
      if (spaceId === null) return;

      const userId = request.authUser!.userId;
      // The write permission already passed, so a caller with no resolvable
      // membership row (tenant-level grants) is stamped as editor; the
      // gateway's own viewer refusal stays as defense in depth.
      const spaceRole =
        (await resolveViewerSpaceRole(fastify, request, tenant.tenantId, spaceId)) ?? 'editor';
      const actor: AppletActor = { kind: 'user', userId };

      let result;
      try {
        result = await applyAppletCommand({
          persistence: persistenceFor(tenant.tenantId),
          instanceId,
          actor,
          spaceRole,
          command: request.body,
        });
      } catch (err) {
        if (err instanceof AppletPersistenceError && err.code === 'instance_not_found') {
          reply.code(404).send({ error: 'NotFound', message: 'Applet instance not found' });
          return;
        }
        throw err;
      }

      switch (result.status) {
        case 'applied': {
          // One post-commit step: realtime delta, attention bump, and the
          // outbox drain. A replay skips the delta but still drains — replay
          // re-drives outstanding effects only.
          const actorContext = buildActorContext(request, tenant);
          await effectsRelay().afterAction({
            tenantId: tenant.tenantId,
            spaceId,
            instanceId,
            receipt: result.receipt,
            stateVersion: result.stateVersion,
            replayed: result.replayed,
            ...(actorContext !== undefined ? { actorContext } : {}),
          });
          reply.send({
            receipt: result.receipt,
            stateVersion: result.stateVersion,
            replayed: result.replayed,
          });
          return;
        }
        case 'conflict':
          reply.code(409).send({ currentVersion: result.currentVersion });
          return;
        case 'rejected':
          if (result.reason === 'forbidden') {
            reply.code(403).send({ error: 'Forbidden', message: refusalMessage(result.message) });
            return;
          }
          reply.code(422).send({
            reason: result.reason,
            message: refusalMessage(result.message),
            availableActions: result.availableActions,
            ...(result.validation !== undefined ? { validation: result.validation } : {}),
          });
          return;
      }
    },
  );
};

/**
 * Resolve the instance's space and re-run the scoped permission check against
 * it — the route-level check ran unscoped because instance routes carry no
 * spaceId. Returns the spaceId, or null after sending 404/403.
 */
export async function assertInstanceSpaceAccess(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  args: { tenantId: TenantId; instanceId: string; action: 'read' | 'write' },
): Promise<string | null> {
  const db = fastify.appContext.db as PostgresJsDatabase | null;
  if (!db) {
    reply.code(503).send({ error: 'ServiceUnavailable', message: 'Applets require a database' });
    return null;
  }
  const spaceId = await resolveAppletInstanceSpaceId(db, args.tenantId, args.instanceId);
  // One 404 for both "no such instance" and "no read access" — same masking
  // as the applet.instance realtime topic; whether an instance exists is a
  // fact about the space it lives in. The permission check below then owns
  // the readable-but-not-writable 403.
  const auth = request.authUser;
  const readable =
    spaceId !== null &&
    auth !== undefined &&
    (await canReadSpace(db, args.tenantId, auth.userId, spaceId, auth.authMethod));
  if (spaceId === null || !readable) {
    reply.code(404).send({ error: 'NotFound', message: 'Applet instance not found' });
    return null;
  }
  await fastify.requirePermission({
    resource: 'memory',
    action: args.action,
    getSpaceId: () => spaceId,
  })(request, reply);
  return reply.sent ? null : spaceId;
}

/**
 * The caller's role in the instance's space, for the viewer stamp and the
 * gateway's spaceRole parameter. Owner and membership are consulted in that
 * order; `request.space` short-circuits when the presented space is already
 * the instance's. Returns null when no role is resolvable (the caller reached
 * here through a tenant-level grant).
 */
export async function resolveViewerSpaceRole(
  fastify: FastifyInstance,
  request: FastifyRequest,
  tenantId: TenantId,
  spaceId: string,
): Promise<SpaceRole | null> {
  if (request.space?.spaceId === spaceId) return request.space.spaceRole;
  const db = fastify.appContext.db as PostgresJsDatabase | null;
  const userId = request.authUser?.userId;
  if (!db || !userId) return null;

  const ownerRows = await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
    tx.select({ ownerId: spaces.ownerId }).from(spaces).where(eq(spaces.id, spaceId)).limit(1),
  );
  if (ownerRows[0]?.ownerId === userId) return 'admin';

  const role = await resolveSpaceMembershipRole(db, fastify.appContext.redis, {
    userId,
    tenantId,
    spaceId,
  });
  return role === 'admin' || role === 'editor' || role === 'viewer' ? role : null;
}
