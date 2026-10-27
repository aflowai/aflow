/**
 * The Store's `space` listings (Plan 330 D1): preview and install a template,
 * and the first-run offer that shows the templates beside an empty space.
 *
 * Scoping (PR #190's open minor, closed here): a template creates the space it
 * applies to, so its install is TENANT-scoped — `/v1/store/space-installs`,
 * not `/v1/spaces/:spaceId/store/install` — and asks for the authority to
 * create a space, not write access to an existing one: the same tenant-role,
 * slug, quota and model rules as `POST /v1/spaces` (`validateSpaceCreation`).
 * The install row belongs to the NEW space; each bundle the template applies
 * writes its own rows there too. The space-scoped install route refuses a
 * `space` listing, so a template is never applied to a space that exists.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, isNull, sql } from 'drizzle-orm';
import {
  createTenantContext,
  getTenantStoreShelfPolicy,
  spaces,
  tenants,
  withTenantSchema,
} from '@aflow/database';
import {
  QuickStartOfferSchema,
  StoreInstallErrorBodySchema,
  StoreInstallPreviewRequestSchema,
  StoreInstallPreviewResponseSchema,
  StoreInstallResponseSchema,
  StoreCatalogChangedErrorSchema,
  StoreSpaceInstallRequestSchema,
  type CatalogSpaceEntry,
  type StorePlannedArtifact,
} from '@aflow/schemas';
import { getCatalogEntry, listCatalog, uncomposedListingReason } from '@aflow/platform-artifacts';
import {
  derivePlannedArtifacts,
  executeSpaceTemplateInstall,
  isListingOnTenantShelf,
  selectListableEntries,
  spaceTemplateDirectives,
} from '@aflow/cybernetic-runtime';
import {
  insertSpaceRecord,
  provisionCreatedSpace,
  spaceCreationFailure,
  validateSpaceCreation,
} from '../services/spaceProvisioning.js';
import { getRedis } from './integrations/shared.js';

/** Thrown inside the install transaction to roll it back with the space refusal it carries. */
class SpaceCreationRefused extends Error {
  constructor(
    readonly refusal: { status: 400 | 403 | 409; body: { error: string; message: string } },
  ) {
    super(refusal.body.message);
    this.name = 'SpaceCreationRefused';
  }
}

/**
 * Whether a space holds anything an operator made or installed. Memory the
 * space's own bootstrap seeds is not counted; a skill written by hand is, as
 * a workflow document.
 */
export async function spaceHoldsNothing(tx: PostgresJsDatabase, spaceId: string): Promise<boolean> {
  const [row] = await tx.execute<{ holds: boolean }>(sql`
    SELECT
      EXISTS (SELECT 1 FROM store_installs WHERE space_id = ${spaceId}::uuid)
      OR EXISTS (SELECT 1 FROM sessions WHERE space_id = ${spaceId}::uuid)
      OR EXISTS (SELECT 1 FROM agents WHERE space_id = ${spaceId}::uuid)
      OR EXISTS (SELECT 1 FROM api_definitions WHERE space_id = ${spaceId}::uuid)
      OR EXISTS (SELECT 1 FROM mcp_server_definitions WHERE space_id = ${spaceId}::uuid)
      OR EXISTS (SELECT 1 FROM host_bindings WHERE space_id = ${spaceId}::uuid)
      OR EXISTS (SELECT 1 FROM memory_docs WHERE space_id = ${spaceId}::uuid
        AND path LIKE '/workflows/%' AND deleted_at IS NULL) AS holds
  `);
  return row?.holds === false;
}

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
export const storeSpaceTemplateRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  const db = fastify.appContext.db as PostgresJsDatabase;

  function shelvedTemplates(shelf: Awaited<ReturnType<typeof getTenantStoreShelfPolicy>>) {
    return selectListableEntries(
      listCatalog({ kind: 'space', lanes: fastify.edition }),
      new Set(),
      shelf,
    ).filter((entry): entry is CatalogSpaceEntry => entry.kind === 'space');
  }

  // GET /v1/store/quick-start-offer
  app.get(
    '/quick-start-offer',
    {
      config: { authz: { resource: 'space', action: 'read' } },
      schema: {
        tags: ['Store'],
        summary:
          'The first-run offer: the quick starts, while the only space is the empty first one',
        response: { 200: QuickStartOfferSchema },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      const shelf = await getTenantStoreShelfPolicy(db, tenant.tenantId);
      const templates = shelvedTemplates(shelf).map((entry) => ({
        catalogId: entry.catalogId,
        version: entry.version,
        name: entry.name,
        tagline: entry.tagline,
        spaceName: entry.payload.spaceName,
      }));
      const [tenantRow] = await db
        .select({ defaultSpaceId: tenants.defaultSpaceId })
        .from(tenants)
        .where(eq(tenants.tenantId, tenant.tenantId))
        .limit(1);
      const firstSpaceId = tenantRow?.defaultSpaceId ?? null;
      if (!firstSpaceId || templates.length === 0) return { applies: false, templates };

      const emptySpace = await withTenantSchema(
        db,
        createTenantContext(tenant.tenantId),
        async (tx) => {
          const live = await tx
            .select({ id: spaces.id, slug: spaces.slug, name: spaces.name })
            .from(spaces)
            .where(isNull(spaces.archivedAt))
            .limit(2);
          const only = live.length === 1 ? live[0] : undefined;
          if (only?.id !== firstSpaceId) return null;
          return (await spaceHoldsNothing(tx, only.id)) ? only : null;
        },
      );
      return emptySpace ? { applies: true, emptySpace, templates } : { applies: false, templates };
    },
  );

  // POST /v1/store/space-install-preview
  app.post(
    '/space-install-preview',
    {
      config: { authz: { resource: 'space', action: 'read' } },
      schema: {
        tags: ['Store'],
        summary:
          'Preview a quick start: the new space, the bundles it applies and its readiness list',
        body: StoreInstallPreviewRequestSchema,
        response: {
          200: StoreInstallPreviewResponseSchema,
          400: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { catalogId } = request.body;
      const tenant = await request.requireTenant();
      const entry = getCatalogEntry(catalogId);
      const shelf = await getTenantStoreShelfPolicy(db, tenant.tenantId);
      if (!entry || !isListingOnTenantShelf(entry, new Set(), shelf)) {
        return reply.code(404).send({ error: `Store listing '${catalogId}' not found` });
      }
      if (entry.kind !== 'space') {
        return reply
          .code(400)
          .send({ error: `'${catalogId}' is not a quick start; preview it in a space instead.` });
      }
      const laneRefusal = uncomposedListingReason(entry, fastify.edition);
      if (laneRefusal !== null) return reply.code(400).send({ error: laneRefusal });

      const creates: StorePlannedArtifact[] = [];
      const bundles: Array<{ catalogId: string; catalogVersion: number }> = [];
      for (const bundleId of entry.payload.bundleIds) {
        const bundle = getCatalogEntry(bundleId);
        if (!bundle) continue;
        bundles.push({ catalogId: bundle.catalogId, catalogVersion: bundle.version });
        creates.push(...derivePlannedArtifacts(bundle));
      }
      creates.push(...derivePlannedArtifacts(entry));
      return {
        kind: entry.kind,
        catalogId: entry.catalogId,
        catalogVersion: entry.version,
        creates,
        conflicts: [],
        missingCapabilities: [],
        space: {
          spaceName: entry.payload.spaceName,
          bundles,
          readiness: entry.payload.readiness.map((item) => ({
            key: item.key,
            title: item.title,
            required: item.required,
            ...(item.page !== undefined ? { page: item.page } : {}),
            ...(item.command !== undefined ? { command: item.command } : {}),
          })),
        },
      };
    },
  );

  // POST /v1/store/space-installs
  app.post(
    '/space-installs',
    {
      config: { authz: { resource: 'space', action: 'read' } },
      schema: {
        tags: ['Store'],
        summary:
          'Start a new space from a quick start: create it, apply its bundles and write its directives (atomic, idempotent)',
        body: StoreSpaceInstallRequestSchema,
        response: {
          200: StoreInstallResponseSchema,
          400: z.union([
            StoreInstallErrorBodySchema,
            z.object({ error: z.string(), message: z.string() }),
          ]),
          401: z.object({ error: z.string() }),
          403: z.object({ error: z.string(), message: z.string() }),
          404: StoreInstallErrorBodySchema,
          409: z.union([
            StoreCatalogChangedErrorSchema,
            StoreInstallErrorBodySchema,
            z.object({ error: z.string(), message: z.string() }),
          ]),
          422: StoreInstallErrorBodySchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const tenant = await request.requireTenant();
      const actorUserId = request.authUser?.userId;
      if (!actorUserId) return reply.code(401).send({ error: 'Unauthenticated' });

      const entry = getCatalogEntry(body.catalogId);
      const validated = await validateSpaceCreation({
        db,
        tenant,
        edition: fastify.edition,
        slug: body.slug,
        directives: entry?.kind === 'space' ? spaceTemplateDirectives(entry.payload) : undefined,
        chosenModelRoles: new Set(),
      });
      if (!validated.ok) return reply.code(validated.status).send(validated.body);

      let result: Awaited<ReturnType<typeof executeSpaceTemplateInstall>>;
      try {
        result = await executeSpaceTemplateInstall({
          db,
          redis: getRedis(fastify),
          tenantId: tenant.tenantId,
          actorUserId,
          catalogId: body.catalogId,
          expectedVersion: body.expectedVersion,
          idempotencyKey: body.idempotencyKey,
          payloadStore: fastify.appContext.payloadStore ?? undefined,
          lanes: fastify.edition,
          createSpace: async (tx) => {
            let row: Record<string, unknown> | null;
            try {
              row = await insertSpaceRecord(tx, {
                tenant,
                edition: fastify.edition,
                userId: actorUserId,
                provisioning: validated.provisioning,
                name: body.name,
                slug: body.slug,
                directives: validated.directives,
              });
            } catch (err) {
              const failure = spaceCreationFailure(err, body.slug);
              if (failure) throw new SpaceCreationRefused(failure);
              throw err;
            }
            if (!row) throw new Error('Failed to create space');
            return { spaceId: row['id'] as string, spaceSlug: row['slug'] as string };
          },
          afterCommit: async (space) => {
            await provisionCreatedSpace({
              db,
              redis: fastify.appContext.redis,
              tenant,
              userId: actorUserId,
              spaceId: space.spaceId,
              directives: validated.directives,
              log: fastify.log,
            });
          },
        });
      } catch (err) {
        if (err instanceof SpaceCreationRefused) {
          return reply.code(err.refusal.status).send(err.refusal.body);
        }
        throw err;
      }
      if (!result.ok) return reply.code(result.statusCode).send(result.body);
      return result.response;
    },
  );
};
