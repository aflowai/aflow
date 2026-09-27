/**
 * Unified store routes — the read surface (listings, install preview) plus a
 * thin HTTP adapter over the shared store-install execution in
 * `@aflow/cybernetic-runtime` (which owns the version check, advisory lock,
 * idempotency, per-kind dispatch, provenance, and post-commit invalidations).
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import {
  createTenantContext,
  createMemoryDocRepository,
  getTenantStoreShelfPolicy,
  withTenantSchema,
} from '@aflow/database';
import {
  CatalogEntryEnvelopeSchema,
  CatalogEntryKindSchema,
  IntegrationSourceKindSchema,
  ListingRequirementsSchema,
  StoreCatalogChangedErrorSchema,
  StoreCustomizedErrorSchema,
  StoreInstallErrorBodySchema,
  StoreInstallPreviewRequestSchema,
  StoreInstallPreviewResponseSchema,
  StoreInstallRequestSchema,
  StoreInstallResponseSchema,
  StoreUninstallErrorBodySchema,
  StoreUninstallPreviewRequestSchema,
  StoreUninstallPreviewResponseSchema,
  StoreUninstallRequestSchema,
  StoreUninstallResponseSchema,
  StoreUpdateErrorBodySchema,
  StoreUpdatePreviewRequestSchema,
  StoreUpdatePreviewResponseSchema,
  StoreUpdateRequestSchema,
  StoreUpdateResponseSchema,
  type CatalogEntry,
  type StoreInstallConflict,
  type TenantId,
} from '@aflow/schemas';
import {
  getCatalogEntry,
  getSkillBundleEntry,
  getSkillCatalogEntry,
  listCatalog,
  uncomposedListingReason,
} from '@aflow/platform-artifacts';
import {
  appletArtifactKey,
  checkMissingCapabilities,
  connectorDefaultBindingId,
  deriveInstalledState,
  deriveListingRequirements,
  derivePlannedArtifacts,
  deriveRequiredCapabilities,
  executeStoreInstall,
  executeStoreUninstall,
  executeStoreUninstallPreview,
  executeStoreUpdate,
  executeStoreUpdatePreview,
  getStoreInstall,
  isCyberneticSpaceById,
  isListingOnTenantShelf,
  listStoreInstalls,
  readAppletArtifactHead,
  searchListableEntries,
  selectListableEntries,
  validateBundleInstallPreconditions,
  ListingInstalledStateSchema,
} from '@aflow/cybernetic-runtime';
import { getRedis } from './integrations/shared.js';

// ============================================================================
// Shared route schemas
// ============================================================================

const ListingSummarySchema = CatalogEntryEnvelopeSchema.extend({
  sourceKind: IntegrationSourceKindSchema.optional(),
  installedState: ListingInstalledStateSchema,
  requirements: ListingRequirementsSchema,
});

const ListingDetailEntrySchema = CatalogEntryEnvelopeSchema.extend({
  sourceKind: IntegrationSourceKindSchema.optional(),
  payload: z.unknown(),
});

const InstallConflictBodySchema = z.union([
  StoreCatalogChangedErrorSchema,
  StoreInstallErrorBodySchema,
]);

const STORE_SEARCH_MAX_RESULTS = 10;

// ============================================================================
// Public listing routes (prefix: /store)
// ============================================================================

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
export const storeListingRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  const db = fastify.appContext.db as PostgresJsDatabase;

  // GET /v1/store/listings — browse + search, annotated with the space's install state
  app.get(
    '/listings',
    {
      config: {
        authz: { resource: 'space', action: 'read', spaceIdFrom: 'requireSpace' },
      },
      schema: {
        tags: ['Store'],
        summary: 'List store listings with installed state and requirements',
        querystring: z.object({
          kind: CatalogEntryKindSchema.optional(),
          q: z.string().min(1).max(200).optional(),
        }),
        response: {
          200: z.object({ listings: z.array(ListingSummarySchema) }),
        },
      },
    },
    async (request) => {
      const { kind, q } = request.query;
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const tenantCtx = createTenantContext(tenant.tenantId);

      const [installs, shelf] = await Promise.all([
        withTenantSchema(db, tenantCtx, async (tx) => listStoreInstalls(tx, space.spaceId)),
        getTenantStoreShelfPolicy(db, tenant.tenantId),
      ]);
      const installByCatalogId = new Map(installs.map((install) => [install.catalogId, install]));
      const installedCatalogIds = new Set(installByCatalogId.keys());

      const base = listCatalog({
        ...(kind !== undefined ? { kind } : {}),
        lanes: fastify.edition,
      });
      const entries = q
        ? searchListableEntries(base, installedCatalogIds, shelf, q, {
            maxResults: STORE_SEARCH_MAX_RESULTS,
          })
        : selectListableEntries(base, installedCatalogIds, shelf);

      return {
        listings: entries.map((entry) => {
          const { payload: _payload, ...summary } = entry;
          return {
            ...summary,
            installedState: deriveInstalledState(
              entry,
              installByCatalogId.get(entry.catalogId) ?? null,
            ),
            requirements: deriveListingRequirements(entry),
          };
        }),
      };
    },
  );

  // GET /v1/store/listings/:catalogId — full entry; resolves unlisted/deprecated too
  app.get(
    '/listings/:catalogId',
    {
      config: {
        authz: { resource: 'space', action: 'read', spaceIdFrom: 'requireSpace' },
      },
      schema: {
        tags: ['Store'],
        summary: 'Get a single store listing with full payload detail',
        params: z.object({ catalogId: z.string().min(1).max(128) }),
        response: {
          200: z.object({
            entry: ListingDetailEntrySchema,
            installedState: ListingInstalledStateSchema,
            requirements: ListingRequirementsSchema,
          }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { catalogId } = request.params;
      const entry = getCatalogEntry(catalogId);
      if (!entry) {
        return reply.code(404).send({ error: `Store listing '${catalogId}' not found` });
      }
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const [install, shelf] = await Promise.all([
        withTenantSchema(db, createTenantContext(tenant.tenantId), async (tx) =>
          getStoreInstall(tx, space.spaceId, catalogId),
        ),
        getTenantStoreShelfPolicy(db, tenant.tenantId),
      ]);
      if (!isListingOnTenantShelf(entry, new Set(install ? [catalogId] : []), shelf)) {
        return reply.code(404).send({ error: `Store listing '${catalogId}' not found` });
      }
      return {
        entry,
        installedState: deriveInstalledState(entry, install),
        requirements: deriveListingRequirements(entry),
      };
    },
  );
};

// ============================================================================
// Space-scoped install routes (prefix: /spaces)
// ============================================================================

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
export const storeInstallRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  const db = fastify.appContext.db as PostgresJsDatabase;

  // --------------------------------------------------------------------------
  // POST /v1/spaces/:spaceId/store/install-preview
  // --------------------------------------------------------------------------

  app.post(
    '/:spaceId/store/install-preview',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'write',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Store'],
        summary: 'Preview a store install (dry run): planned artifacts, conflicts, capabilities',
        params: z.object({ spaceId: z.string().uuid() }),
        body: StoreInstallPreviewRequestSchema,
        response: {
          200: StoreInstallPreviewResponseSchema,
          400: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { spaceId } = request.params;
      const { catalogId } = request.body;
      const tenant = await request.requireTenant();
      const tenantId = tenant.tenantId;

      const entry = getCatalogEntry(catalogId);
      if (!entry) {
        return reply.code(404).send({ error: `Store listing '${catalogId}' not found` });
      }
      const laneRefusal = uncomposedListingReason(entry, fastify.edition);
      if (laneRefusal !== null) {
        return reply.code(400).send({ error: laneRefusal });
      }
      if (entry.kind === 'bundle' && !(await isCyberneticSpaceById(db, tenantId, spaceId))) {
        return reply.code(400).send({ error: 'Space is not cybernetic (no directives set)' });
      }

      const shelf = await getTenantStoreShelfPolicy(db, tenantId);
      const offShelf = !isListingOnTenantShelf(entry, new Set(), shelf);

      const creates = derivePlannedArtifacts(entry);

      const tenantCtx = createTenantContext(tenantId);
      const { install, conflicts, missingCapabilities } = await withTenantSchema(
        db,
        tenantCtx,
        async (tx) => ({
          install: offShelf ? await getStoreInstall(tx, spaceId, entry.catalogId) : null,
          ...(await previewByKind(tx, entry, { tenantId, spaceId })),
        }),
      );
      if (offShelf && !install) {
        return reply.code(404).send({ error: `Store listing '${catalogId}' not found` });
      }

      return {
        catalogId: entry.catalogId,
        catalogVersion: entry.version,
        creates,
        conflicts,
        missingCapabilities,
      };
    },
  );

  async function previewByKind(
    tx: PostgresJsDatabase,
    entry: CatalogEntry,
    ids: { tenantId: TenantId; spaceId: string },
  ): Promise<{ conflicts: StoreInstallConflict[]; missingCapabilities: string[] }> {
    const conflicts: StoreInstallConflict[] = [];
    switch (entry.kind) {
      case 'bundle': {
        const repo = createMemoryDocRepository(tx, createTenantContext(ids.tenantId), {
          inTransaction: true,
        });
        const validation = await validateBundleInstallPreconditions({
          bundle: entry.payload,
          spaceId: ids.spaceId,
          tx,
          resolveBundle: (bundleId) => getSkillBundleEntry(bundleId) ?? null,
          checkSkillInstalled: async (skillCatalogId) => {
            const member = getSkillCatalogEntry(skillCatalogId);
            if (!member) return false;
            const doc = await repo.getByPath(
              `/workflows/${member.bundle.workflow.slug}/workflow.json`,
              ids.spaceId,
            );
            return doc !== null;
          },
        });
        if (!validation.ok) {
          for (const reason of validation.errors) {
            conflicts.push({
              artifactType: 'skill',
              artifactKey: entry.catalogId,
              reason: reason.slice(0, 500),
            });
          }
        }
        const requiredCapabilities = new Set<string>();
        for (const memberId of entry.payload.skillCatalogIds) {
          const member = getSkillCatalogEntry(memberId);
          if (!member) continue;
          for (const capability of deriveRequiredCapabilities(member.bundle)) {
            requiredCapabilities.add(capability);
          }
        }
        const missingCapabilities = await checkMissingCapabilities(
          { db: tx, tenantId: ids.tenantId, spaceId: ids.spaceId, inTransaction: true },
          [...requiredCapabilities],
        );
        return { conflicts, missingCapabilities };
      }
      case 'connector': {
        if (entry.sourceKind === 'api') {
          const apiId = entry.payload.definition.apiId;
          const bindingId = connectorDefaultBindingId(apiId);
          const definitionRows = await tx.execute<{ api_id: string }>(sql`
            SELECT api_id FROM api_definitions
            WHERE api_id = ${apiId} AND space_id = ${ids.spaceId}::uuid
            LIMIT 1
          `);
          if (definitionRows.length > 0) {
            conflicts.push({
              artifactType: 'api_definition',
              artifactKey: apiId,
              reason: `An integration named '${entry.payload.definition.name}' is already in this space.`,
            });
          }
          const bindingRows = await tx.execute<{ binding_id: string }>(sql`
            SELECT binding_id FROM api_bindings
            WHERE binding_id = ${bindingId} AND space_id = ${ids.spaceId}::uuid
            LIMIT 1
          `);
          if (bindingRows.length > 0) {
            conflicts.push({
              artifactType: 'api_binding',
              artifactKey: bindingId,
              reason: `A connection named '${bindingId}' already exists in this space.`,
            });
          }
        } else {
          const serverId = entry.payload.definition.serverId;
          const bindingId = connectorDefaultBindingId(serverId);
          const definitionRows = await tx.execute<{ server_id: string }>(sql`
            SELECT server_id FROM mcp_server_definitions
            WHERE server_id = ${serverId} AND space_id = ${ids.spaceId}::uuid
            LIMIT 1
          `);
          if (definitionRows.length > 0) {
            conflicts.push({
              artifactType: 'mcp_definition',
              artifactKey: serverId,
              reason: `An integration named '${entry.payload.definition.name}' is already in this space.`,
            });
          }
          const bindingRows = await tx.execute<{ binding_id: string }>(sql`
            SELECT binding_id FROM mcp_server_bindings
            WHERE binding_id = ${bindingId} AND space_id = ${ids.spaceId}::uuid
            LIMIT 1
          `);
          if (bindingRows.length > 0) {
            conflicts.push({
              artifactType: 'mcp_binding',
              artifactKey: bindingId,
              reason: `A connection named '${bindingId}' already exists in this space.`,
            });
          }
        }
        return { conflicts, missingCapabilities: [] };
      }
      case 'applet': {
        // A live artifact under the listing's key with no install record means
        // a fresh install would write a new version over it — surface that.
        const install = await getStoreInstall(tx, ids.spaceId, entry.catalogId);
        if (!install) {
          const head = await readAppletArtifactHead(
            tx,
            ids.spaceId,
            appletArtifactKey(entry.catalogId),
          );
          if (head) {
            conflicts.push({
              artifactType: 'ui_artifact',
              artifactKey: appletArtifactKey(entry.catalogId),
              reason: `An applet artifact for '${entry.name}' already exists in this space; installing will overwrite it with the store version.`,
            });
          }
        }
        return { conflicts, missingCapabilities: [] };
      }
    }
  }

  // --------------------------------------------------------------------------
  // POST /v1/spaces/:spaceId/store/install
  // --------------------------------------------------------------------------

  app.post(
    '/:spaceId/store/install',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'write',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Store'],
        summary: 'Install a store listing into the space (per-kind dispatch, atomic, idempotent)',
        params: z.object({ spaceId: z.string().uuid() }),
        body: StoreInstallRequestSchema,
        response: {
          200: StoreInstallResponseSchema,
          400: StoreInstallErrorBodySchema,
          401: z.object({ error: z.string() }),
          404: StoreInstallErrorBodySchema,
          409: InstallConflictBodySchema,
          422: z.object({
            error: z.string(),
            code: z.literal('BUNDLE_INSTALL_VALIDATION_FAILED'),
            bundleId: z.string(),
            errors: z.array(z.string()),
          }),
        },
      },
    },
    async (request, reply) => {
      const { spaceId } = request.params;
      const body = request.body;
      const tenant = await request.requireTenant();
      const actorUserId = request.authUser?.userId;
      if (!actorUserId) {
        return reply.code(401).send({ error: 'Unauthenticated' });
      }

      const result = await executeStoreInstall({
        db,
        redis: getRedis(fastify),
        tenantId: tenant.tenantId,
        spaceId,
        actorUserId,
        catalogId: body.catalogId,
        expectedVersion: body.expectedVersion,
        idempotencyKey: body.idempotencyKey,
        payloadStore: fastify.appContext.payloadStore ?? undefined,
        lanes: fastify.edition,
      });
      if (!result.ok) {
        return reply.code(result.statusCode).send(result.body);
      }
      return result.response;
    },
  );

  // --------------------------------------------------------------------------
  // POST /v1/spaces/:spaceId/store/update-preview
  // --------------------------------------------------------------------------

  app.post(
    '/:spaceId/store/update-preview',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'write',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Store'],
        summary: 'Preview a store update: versions plus per-artifact customization divergence',
        params: z.object({ spaceId: z.string().uuid() }),
        body: StoreUpdatePreviewRequestSchema,
        response: {
          200: StoreUpdatePreviewResponseSchema,
          404: StoreUpdateErrorBodySchema,
        },
      },
    },
    async (request, reply) => {
      const { spaceId } = request.params;
      const { catalogId } = request.body;
      const tenant = await request.requireTenant();

      const result = await executeStoreUpdatePreview({
        db,
        tenantId: tenant.tenantId,
        spaceId,
        catalogId,
        payloadStore: fastify.appContext.payloadStore ?? undefined,
      });
      if (!result.ok) {
        return reply.code(result.statusCode).send(result.body);
      }
      return result.response;
    },
  );

  // --------------------------------------------------------------------------
  // POST /v1/spaces/:spaceId/store/update
  // --------------------------------------------------------------------------

  app.post(
    '/:spaceId/store/update',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'write',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Store'],
        summary:
          'Update an installed store listing (per-kind update handlers, credential-preserving, atomic, idempotent)',
        params: z.object({ spaceId: z.string().uuid() }),
        body: StoreUpdateRequestSchema,
        response: {
          200: StoreUpdateResponseSchema,
          400: StoreUpdateErrorBodySchema,
          401: z.object({ error: z.string() }),
          404: StoreUpdateErrorBodySchema,
          409: z.union([
            StoreCatalogChangedErrorSchema,
            StoreCustomizedErrorSchema,
            StoreUpdateErrorBodySchema,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { spaceId } = request.params;
      const body = request.body;
      const tenant = await request.requireTenant();
      const actorUserId = request.authUser?.userId;
      if (!actorUserId) {
        return reply.code(401).send({ error: 'Unauthenticated' });
      }

      const result = await executeStoreUpdate({
        db,
        redis: getRedis(fastify),
        tenantId: tenant.tenantId,
        spaceId,
        actorUserId,
        catalogId: body.catalogId,
        expectedVersion: body.expectedVersion,
        idempotencyKey: body.idempotencyKey,
        mode: body.mode,
        payloadStore: fastify.appContext.payloadStore ?? undefined,
      });
      if (!result.ok) {
        return reply.code(result.statusCode).send(result.body);
      }
      return result.response;
    },
  );

  // --------------------------------------------------------------------------
  // POST /v1/spaces/:spaceId/store/uninstall-preview
  // --------------------------------------------------------------------------

  app.post(
    '/:spaceId/store/uninstall-preview',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'write',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Store'],
        summary: 'Preview an uninstall: per-artifact actions, dependents, and remaining claims',
        params: z.object({ spaceId: z.string().uuid() }),
        body: StoreUninstallPreviewRequestSchema,
        response: {
          200: StoreUninstallPreviewResponseSchema,
          404: StoreUninstallErrorBodySchema,
        },
      },
    },
    async (request, reply) => {
      const { spaceId } = request.params;
      const { catalogId } = request.body;
      const tenant = await request.requireTenant();

      const result = await executeStoreUninstallPreview({
        db,
        tenantId: tenant.tenantId,
        spaceId,
        catalogId,
      });
      if (!result.ok) {
        return reply.code(result.statusCode).send(result.body);
      }
      return result.response;
    },
  );

  // --------------------------------------------------------------------------
  // POST /v1/spaces/:spaceId/store/uninstall
  // --------------------------------------------------------------------------

  app.post(
    '/:spaceId/store/uninstall',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'write',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Store'],
        summary:
          'Uninstall a store listing (archive/disable-first, claims-aware, atomic, idempotent)',
        params: z.object({ spaceId: z.string().uuid() }),
        body: StoreUninstallRequestSchema,
        response: {
          200: StoreUninstallResponseSchema,
          401: z.object({ error: z.string() }),
          404: StoreUninstallErrorBodySchema,
          409: StoreUninstallErrorBodySchema,
        },
      },
    },
    async (request, reply) => {
      const { spaceId } = request.params;
      const body = request.body;
      const tenant = await request.requireTenant();
      const actorUserId = request.authUser?.userId;
      if (!actorUserId) {
        return reply.code(401).send({ error: 'Unauthenticated' });
      }

      const result = await executeStoreUninstall({
        db,
        redis: getRedis(fastify),
        tenantId: tenant.tenantId,
        spaceId,
        actorUserId,
        catalogId: body.catalogId,
        idempotencyKey: body.idempotencyKey,
        ...(body.keepUserData !== undefined ? { keepUserData: body.keepUserData } : {}),
      });
      if (!result.ok) {
        return reply.code(result.statusCode).send(result.body);
      }
      return result.response;
    },
  );
};
