/**
 * Installing a Store listing of kind `space` (Plan 330 D1): create a new space,
 * apply each bundle the template names through the Store's own bundle install
 * — the same `runStoreInstall` a bundle listing takes, so every bundle carries
 * its install rows and claims — and write the template's directives, agents
 * and api_definitions as the new space's own data, all in one transaction.
 *
 * There is no way to name an existing space here: the space is whatever the
 * caller's `createSpace` makes inside this transaction. Applying a template to
 * a space that exists is refused by `executeStoreInstall` instead.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from 'ioredis';
import {
  createTenantContext,
  getTenantStoreShelfPolicy,
  withTenantSchema,
  type TenantStoreShelfPolicy,
} from '@aflow/database';
import {
  StoreInstallResponseSchema,
  defaultSpaceDirectives,
  processEditionDescriptor,
  type CatalogEntry,
  type CatalogSpaceEntry,
  type ComposedLanes,
  type EntityDirectives,
  type PostInstallTask,
  type SpaceReadinessEntry,
  type SpaceTemplate,
  type SpaceTemplateReadinessItem,
  type StoreBundleInstallResult,
  type StoreCatalogChangedError,
  type StoreInstallResponse,
  type TenantId,
} from '@aflow/schemas';
import { getCatalogEntry, uncomposedListingReason } from '@aflow/platform-artifacts';
import { applyApiDefinitions } from '../stagedChange/bundleInstallContent.js';
import { applyBundledAgents } from '../stagedChange/applyBundledAgents.js';
import { deriveInstallProvenance, isListingOnTenantShelf } from './storeDerivations.js';
import { listStoreInstalls } from './storeInstallProvenance.js';
import {
  StoreInstallError,
  mapStoreInstallFailure,
  publishStoreInstallInvalidations,
  runStoreInstall,
  spaceTemplateRefusal,
  writeProvenance,
  type ExecuteStoreInstallResult,
  type InstallInvalidations,
} from './storeInstallExecution.js';

/** The directives a space made from the template starts with: the template's own over the defaults every space gets. */
export function spaceTemplateDirectives(template: SpaceTemplate): EntityDirectives {
  return {
    ...defaultSpaceDirectives(),
    responsibility: template.directives.responsibility,
    priorities: [...template.directives.priorities],
    ...(template.directives.style !== undefined ? { style: template.directives.style } : {}),
  };
}

/**
 * Each readiness item as it stands for one space. An item is unmet while the
 * bundles' derived post-install manifest — read from live state at the moment
 * it is asked — still carries the task kind that answers it.
 */
export function readSpaceTemplateReadiness(
  items: readonly SpaceTemplateReadinessItem[],
  manifest: readonly PostInstallTask[],
): SpaceReadinessEntry[] {
  const unmet = new Set(manifest.map((task) => task.kind));
  return items.map((item) => ({
    key: item.key,
    title: item.title,
    required: item.required,
    state: unmet.has(item.answeredBy as PostInstallTask['kind']) ? 'needs_setup' : 'done',
    ...(item.page !== undefined ? { page: item.page } : {}),
    ...(item.command !== undefined ? { command: item.command } : {}),
  }));
}

export interface CreatedSpace {
  spaceId: string;
  spaceSlug: string;
}

/** Creates the space the template applies to, inside the install's transaction. */
export type CreateTemplateSpace = (
  tx: PostgresJsDatabase,
  directives: EntityDirectives,
) => Promise<CreatedSpace>;

export interface SpaceTemplateTxOutcome {
  space: CreatedSpace;
  response: StoreInstallResponse;
  invalidations: InstallInvalidations[];
}

function dedupeTasks(tasks: readonly PostInstallTask[]): PostInstallTask[] {
  const seen = new Set<string>();
  return tasks.filter((task) => {
    const key = JSON.stringify(task);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function runSpaceTemplateInstall(
  tx: PostgresJsDatabase,
  entry: CatalogSpaceEntry,
  ids: {
    tenantId: TenantId;
    actorUserId: string;
    payloadStore?: PayloadStore | undefined;
    redis?: Redis | null | undefined;
  },
  opts: {
    createSpace: CreateTemplateSpace;
    shelf: TenantStoreShelfPolicy;
    resolveEntry?: (catalogId: string) => CatalogEntry | null | undefined;
  },
): Promise<SpaceTemplateTxOutcome> {
  const template = entry.payload;
  const resolveEntry = opts.resolveEntry ?? getCatalogEntry;
  const space = await opts.createSpace(tx, spaceTemplateDirectives(template));
  // The space was made by this transaction, so anything already installed in
  // it means `createSpace` handed back a space that existed before.
  if ((await listStoreInstalls(tx, space.spaceId)).length > 0) {
    throw new StoreInstallError(400, spaceTemplateRefusal(entry.catalogId));
  }
  const spaceIds = { ...ids, spaceId: space.spaceId };

  const bundles: Array<{ catalogId: string; result: StoreBundleInstallResult }> = [];
  const invalidations: InstallInvalidations[] = [];
  const manifest: PostInstallTask[] = [];
  for (const bundleId of template.bundleIds) {
    const bundleEntry = resolveEntry(bundleId);
    if (bundleEntry?.kind !== 'bundle') {
      throw new StoreInstallError(400, {
        error: `'${entry.catalogId}' names '${bundleId}', which is no bundle in the Store.`,
        catalogId: entry.catalogId,
      });
    }
    const outcome = await runStoreInstall(tx, bundleEntry, spaceIds, {
      offShelf: !isListingOnTenantShelf(bundleEntry, new Set(), opts.shelf),
    });
    if (outcome.response.result.kind !== 'bundle') {
      throw new Error(
        `The bundle install of '${bundleId}' reported a ${outcome.response.result.kind} result.`,
      );
    }
    bundles.push({ catalogId: bundleId, result: outcome.response.result });
    manifest.push(...outcome.response.setupChecklist);
    if (outcome.invalidations) invalidations.push(outcome.invalidations);
  }

  const apiDefinitions = await applyApiDefinitions({
    apiDefinitions: template.apiDefinitions,
    spaceId: space.spaceId,
    tx,
  });
  if (apiDefinitions.installedApiDefinitionIds.length > 0) {
    invalidations.push(
      ...apiDefinitions.installedApiDefinitionIds.map((apiId) => ({ kind: 'api' as const, apiId })),
    );
  }
  const agents = await applyBundledAgents({
    agents: template.agents,
    tenantId: ids.tenantId,
    spaceId: space.spaceId,
    tx,
  });

  const plan = deriveInstallProvenance(entry, {
    spaceId: space.spaceId,
    actorUserId: ids.actorUserId,
    now: new Date().toISOString(),
  });
  await writeProvenance(tx, plan, { entryRow: 'replace' });

  const setupChecklist = dedupeTasks(manifest);
  return {
    space,
    invalidations,
    response: {
      result: {
        kind: 'space',
        spaceId: space.spaceId,
        spaceSlug: space.spaceSlug,
        templateVersion: template.version,
        bundles,
        installedAgentSlugs: agents.installedAgentSlugs,
        installedApiDefinitionIds: apiDefinitions.installedApiDefinitionIds,
        readiness: readSpaceTemplateReadiness(template.readiness, setupChecklist),
      },
      setupChecklist,
      install: plan.install,
    },
  };
}

// ============================================================================
// Entry point
// ============================================================================

const SPACE_INSTALL_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const SPACE_INSTALL_IDEMPOTENCY_PENDING_TTL_SECONDS = 300;
const IDEMPOTENCY_PENDING = 'pending';

export interface ExecuteSpaceTemplateInstallParams {
  db: PostgresJsDatabase;
  redis: Redis | null;
  tenantId: TenantId;
  actorUserId: string;
  catalogId: string;
  expectedVersion: number;
  idempotencyKey: string;
  createSpace: CreateTemplateSpace;
  /**
   * Runs once the install has committed and before the outcome is recorded for
   * replay — the space's membership and bootstrap. A throw here leaves nothing
   * recorded, so the caller's cleanup and a retry see the same state.
   */
  afterCommit?: (space: CreatedSpace) => Promise<void>;
  payloadStore?: PayloadStore | undefined;
  entryResolver?: (catalogId: string) => CatalogEntry | null | undefined;
  lanes?: ComposedLanes | undefined;
}

/**
 * Install a `space` listing: the tenant-scoped counterpart of
 * `executeStoreInstall`, with the same version check, shelf gate, lane
 * refusal and idempotency — keyed by tenant rather than by a space, since the
 * space is what the install makes.
 */
export async function executeSpaceTemplateInstall(
  params: ExecuteSpaceTemplateInstallParams,
): Promise<ExecuteStoreInstallResult> {
  const { db, redis, tenantId, catalogId, expectedVersion, idempotencyKey } = params;
  const resolveEntry = params.entryResolver ?? getCatalogEntry;
  const notFound: ExecuteStoreInstallResult = {
    ok: false,
    statusCode: 404,
    body: { error: `Store listing '${catalogId}' not found` },
  };

  const entry = resolveEntry(catalogId) ?? null;
  if (!entry) return notFound;
  const shelf = await getTenantStoreShelfPolicy(db, tenantId);
  if (!isListingOnTenantShelf(entry, new Set(), shelf)) return notFound;
  if (entry.kind !== 'space') {
    return {
      ok: false,
      statusCode: 400,
      body: {
        error: `'${catalogId}' is not a quick start; install it into a space instead.`,
        code: 'NOT_A_SPACE_TEMPLATE',
        catalogId,
      },
    };
  }
  const laneRefusal = uncomposedListingReason(entry, params.lanes ?? processEditionDescriptor());
  if (laneRefusal !== null) {
    return {
      ok: false,
      statusCode: 400,
      body: { error: laneRefusal, code: 'LANE_NOT_COMPOSED', catalogId },
    };
  }
  if (entry.status === 'deprecated') {
    return {
      ok: false,
      statusCode: 400,
      body: { error: `Listing '${catalogId}' is deprecated and cannot be installed fresh.` },
    };
  }
  if (entry.version !== expectedVersion) {
    return {
      ok: false,
      statusCode: 409,
      body: {
        error:
          `Listing '${catalogId}' changed since preview ` +
          `(expected version ${expectedVersion}, current ${entry.version}). Re-preview and retry.`,
        code: 'CATALOG_CHANGED',
        catalogId,
        expectedVersion,
        currentVersion: entry.version,
      } satisfies StoreCatalogChangedError,
    };
  }

  const idempotencyRedisKey = `aflow:idempotency:store_space_install:${tenantId}:${catalogId}:${idempotencyKey}`;
  if (redis) {
    const claimed = await redis.set(
      idempotencyRedisKey,
      IDEMPOTENCY_PENDING,
      'EX',
      SPACE_INSTALL_IDEMPOTENCY_PENDING_TTL_SECONDS,
      'NX',
    );
    if (!claimed) {
      const recorded = await redis.get(idempotencyRedisKey);
      if (recorded && recorded !== IDEMPOTENCY_PENDING) {
        return { ok: true, response: StoreInstallResponseSchema.parse(JSON.parse(recorded)) };
      }
      return {
        ok: false,
        statusCode: 409,
        body: {
          error: 'An identical store install is already in progress. Retry shortly.',
          code: 'STORE_MUTATION_IN_PROGRESS',
        },
      };
    }
  }

  let outcome: SpaceTemplateTxOutcome;
  try {
    outcome = await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
      runSpaceTemplateInstall(
        tx,
        entry,
        {
          tenantId,
          actorUserId: params.actorUserId,
          payloadStore: params.payloadStore,
          redis,
        },
        { createSpace: params.createSpace, shelf, resolveEntry },
      ),
    );
    await params.afterCommit?.(outcome.space);
  } catch (err) {
    if (redis) await redis.del(idempotencyRedisKey);
    const failure = mapStoreInstallFailure(err);
    if (failure) return failure;
    throw err;
  }

  if (redis) {
    for (const invalidation of outcome.invalidations) {
      await publishStoreInstallInvalidations(redis, tenantId, outcome.space.spaceId, invalidation);
    }
    await redis.set(
      idempotencyRedisKey,
      JSON.stringify(outcome.response),
      'EX',
      SPACE_INSTALL_IDEMPOTENCY_TTL_SECONDS,
    );
  }
  return { ok: true, response: outcome.response };
}
