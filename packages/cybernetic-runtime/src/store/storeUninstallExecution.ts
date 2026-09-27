/**
 * Store uninstall execution — the one authority every uninstall surface
 * calls. Same lock/idempotency contract as install and update (no
 * expectedVersion — uninstall targets what IS installed, so a delisted or
 * moved-on catalog entry never blocks removal). The performed actions are
 * exactly the shared plan's (`buildStoreUninstallPlan`): archive skills
 * (reversible, never purge), delete unreferenced integrations else disable
 * their bindings, remove only explicitly-unchecked pristine user-data, and
 * drop provenance rows with the last claim.
 */
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import {
  createMemoryDocRepository,
  createTenantContext,
  withTenantSchema,
  type ArchivedAppletInstanceRef,
} from '@aflow/database';
import {
  StoreUninstallResponseSchema,
  type StoreUninstallErrorBody,
  type StoreUninstallPreviewResponse,
  type StoreUninstallResponse,
  type TenantId,
} from '@aflow/schemas';
import { publishApiCatalogInvalidation, publishMcpCatalogInvalidation } from '@aflow/redis';
import { archiveSkill, SkillLifecycleError } from '../skillLifecycle.js';
import { invalidateArtifactBindingCache } from '../artifactBindingResolver.js';
import { bumpAttentionGeneration } from '../attentionCache.js';
import { tryAcquireStoreMutationLock } from '../stagedChange/storeMutationLock.js';
import { removeAppletArtifact } from './appletInstall.js';
import {
  deleteApiIntegration,
  deleteMcpIntegration,
  disableApiBinding,
  disableMcpBinding,
} from './connectorUninstall.js';
import { deleteStoreInstallClaim, deleteStoreInstallRecords } from './storeInstallProvenance.js';
import { buildStoreUninstallPlan, type StoreUninstallExecutionPlan } from './storeUninstallPlan.js';

// ============================================================================
// Result contract
// ============================================================================

export type StoreUninstallFailureStatus = 404 | 409;

export type ExecuteStoreUninstallResult =
  | { ok: true; response: StoreUninstallResponse }
  | { ok: false; statusCode: StoreUninstallFailureStatus; body: StoreUninstallErrorBody };

export type ExecuteStoreUninstallPreviewResult =
  | { ok: true; response: StoreUninstallPreviewResponse }
  | { ok: false; statusCode: 404; body: StoreUninstallErrorBody };

class StoreUninstallError extends Error {
  constructor(
    readonly statusCode: StoreUninstallFailureStatus,
    readonly body: StoreUninstallErrorBody,
  ) {
    super(body.error);
    this.name = 'StoreUninstallError';
  }
}

export interface ExecuteStoreUninstallParams {
  db: PostgresJsDatabase;
  redis: Redis | null;
  tenantId: TenantId;
  spaceId: string;
  actorUserId: string;
  catalogId: string;
  idempotencyKey: string;
  /** Artifact keys of user-data artifacts to keep; omitted keeps all. */
  keepUserData?: readonly string[];
}

export interface ExecuteStoreUninstallPreviewParams {
  db: PostgresJsDatabase;
  tenantId: TenantId;
  spaceId: string;
  catalogId: string;
}

function notInstalledBody(catalogId: string): StoreUninstallErrorBody {
  return {
    error: `'${catalogId}' is not installed in this space.`,
    code: 'NOT_INSTALLED',
    catalogId,
  };
}

// ============================================================================
// Idempotency (same TTL contract as install/update, separate namespace)
// ============================================================================

const STORE_UNINSTALL_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const STORE_UNINSTALL_IDEMPOTENCY_PENDING_TTL_SECONDS = 300;
const IDEMPOTENCY_PENDING = 'pending';

function storeUninstallIdempotencyRedisKey(
  tenantId: string,
  spaceId: string,
  catalogId: string,
  idempotencyKey: string,
): string {
  return `aflow:idempotency:store_uninstall:${tenantId}:${spaceId}:${catalogId}:${idempotencyKey}`;
}

// ============================================================================
// Preview
// ============================================================================

export async function executeStoreUninstallPreview(
  params: ExecuteStoreUninstallPreviewParams,
): Promise<ExecuteStoreUninstallPreviewResult> {
  const { db, tenantId, spaceId, catalogId } = params;
  const plan = await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
    buildStoreUninstallPlan(tx, { tenantId, spaceId }, catalogId, { keepUserData: null }),
  );
  if (!plan) {
    return { ok: false, statusCode: 404, body: notInstalledBody(catalogId) };
  }
  return { ok: true, response: plan.response };
}

// ============================================================================
// The uninstall transaction
// ============================================================================

async function performUninstall(
  tx: PostgresJsDatabase,
  plan: StoreUninstallExecutionPlan,
  ids: { tenantId: TenantId; spaceId: string; actorUserId: string },
): Promise<ArchivedAppletInstanceRef[]> {
  const blocked = plan.skillsToArchive.find((skill) => skill.activeRunIds.length > 0);
  if (blocked) {
    throw new StoreUninstallError(409, {
      error:
        `Skill '${blocked.slug}' has ${String(blocked.activeRunIds.length)} active run(s). ` +
        `Stop them before uninstalling.`,
      code: 'SKILL_HAS_ACTIVE_RUNS',
      skillId: blocked.skillId,
      runIds: blocked.activeRunIds,
    });
  }

  for (const skill of plan.skillsToArchive) {
    try {
      await archiveSkill(
        { db: tx, tenantId: ids.tenantId, spaceId: ids.spaceId, actorUserId: ids.actorUserId },
        skill.skillId,
      );
    } catch (err) {
      if (err instanceof SkillLifecycleError) {
        if (err.code === 'SKILL_NOT_FOUND') continue;
        if (err.code === 'SKILL_HAS_ACTIVE_RUNS' || err.code === 'SKILL_HAS_LIVE_RUNS') {
          throw new StoreUninstallError(409, {
            error: err.message,
            code: 'SKILL_HAS_ACTIVE_RUNS',
            skillId: skill.skillId,
          });
        }
      }
      throw err;
    }
  }

  for (const integration of plan.integrations) {
    if (integration.deletable) {
      if (integration.sourceKind === 'api') {
        await deleteApiIntegration(tx, ids.spaceId, integration.integrationId);
      } else {
        await deleteMcpIntegration(tx, ids.spaceId, integration.integrationId);
      }
    } else {
      for (const bindingId of integration.bindingIds) {
        if (integration.sourceKind === 'api') {
          await disableApiBinding(tx, ids.spaceId, bindingId);
        } else {
          await disableMcpBinding(tx, ids.spaceId, bindingId);
        }
      }
    }
  }
  for (const binding of plan.standaloneBindingDisables) {
    if (binding.sourceKind === 'api') {
      await disableApiBinding(tx, ids.spaceId, binding.bindingId);
    } else {
      await disableMcpBinding(tx, ids.spaceId, binding.bindingId);
    }
  }

  if (plan.memoryDocsToDelete.length > 0) {
    const repo = createMemoryDocRepository(tx, createTenantContext(ids.tenantId), {
      inTransaction: true,
    });
    for (const doc of plan.memoryDocsToDelete) {
      await repo.hardDelete(doc.docId, ids.spaceId);
    }
  }
  for (const artifact of plan.uiArtifactsToDelete) {
    await tx.execute(sql`
      UPDATE ui_artifacts SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = ${artifact.artifactRowId}::uuid AND space_id = ${ids.spaceId}::uuid
    `);
    await tx.execute(sql`
      DELETE FROM artifact_bindings
      WHERE binding_id = ${artifact.bindingId} AND space_id = ${ids.spaceId}::uuid
    `);
  }
  const archivedInstances: ArchivedAppletInstanceRef[] = [];
  for (const target of plan.appletArtifactsToRemove) {
    archivedInstances.push(...(await removeAppletArtifact(tx, ids.spaceId, target)));
  }
  if (plan.uiArtifactsToDelete.length > 0 || plan.appletArtifactsToRemove.length > 0) {
    invalidateArtifactBindingCache();
  }

  for (const released of plan.releasedMemberClaims) {
    await deleteStoreInstallClaim(tx, ids.spaceId, released.catalogId, released.claimedBy);
  }
  if (plan.response.action === 'release_claim') {
    await deleteStoreInstallClaim(tx, ids.spaceId, plan.response.catalogId, 'direct');
  }
  for (const entry of plan.removedEntries) {
    await deleteStoreInstallRecords(tx, ids.spaceId, entry);
  }
  return archivedInstances;
}

interface UninstallTxOutcome {
  plan: StoreUninstallExecutionPlan;
  /** Instances the applet teardown archived — attention bumps happen post-commit. */
  archivedInstances: ArchivedAppletInstanceRef[];
}

async function runStoreUninstall(
  tx: PostgresJsDatabase,
  ids: { tenantId: TenantId; spaceId: string; actorUserId: string },
  catalogId: string,
  keepUserData: ReadonlySet<string> | null,
): Promise<UninstallTxOutcome> {
  const acquired = await tryAcquireStoreMutationLock(tx, ids.spaceId);
  if (!acquired) {
    throw new StoreUninstallError(409, {
      error: 'Another store mutation is in progress for this space. Retry shortly.',
      code: 'STORE_MUTATION_IN_PROGRESS',
    });
  }

  const plan = await buildStoreUninstallPlan(
    tx,
    { tenantId: ids.tenantId, spaceId: ids.spaceId },
    catalogId,
    { keepUserData },
  );
  if (!plan) {
    throw new StoreUninstallError(404, notInstalledBody(catalogId));
  }
  const archivedInstances = await performUninstall(tx, plan, ids);
  return { plan, archivedInstances };
}

// ============================================================================
// Post-commit invalidations
// ============================================================================

function publishUninstallInvalidations(
  redis: Redis,
  tenantId: TenantId,
  spaceId: string,
  plan: StoreUninstallExecutionPlan,
): void {
  for (const integration of plan.integrations) {
    if (integration.sourceKind === 'api') {
      publishApiCatalogInvalidation(redis, tenantId as string, spaceId, {
        kind: 'definition',
        apiId: integration.integrationId,
      });
      publishApiCatalogInvalidation(redis, tenantId as string, spaceId, {
        kind: 'binding',
        apiId: integration.integrationId,
      });
    } else {
      publishMcpCatalogInvalidation(redis, tenantId as string, spaceId, {
        kind: 'definition',
        serverId: integration.integrationId,
      });
      for (const bindingId of integration.bindingIds) {
        publishMcpCatalogInvalidation(redis, tenantId as string, spaceId, {
          kind: 'binding',
          serverId: integration.integrationId,
          bindingId,
        });
      }
    }
  }
  for (const binding of plan.standaloneBindingDisables) {
    if (binding.sourceKind === 'api') {
      publishApiCatalogInvalidation(redis, tenantId as string, spaceId, {
        kind: 'binding',
        apiId: binding.integrationId,
      });
    } else {
      publishMcpCatalogInvalidation(redis, tenantId as string, spaceId, {
        kind: 'binding',
        serverId: binding.integrationId,
        bindingId: binding.bindingId,
      });
    }
  }
}

// ============================================================================
// Entry point
// ============================================================================

export async function executeStoreUninstall(
  params: ExecuteStoreUninstallParams,
): Promise<ExecuteStoreUninstallResult> {
  const { db, redis, tenantId, spaceId, actorUserId, catalogId, idempotencyKey } = params;
  const keepUserData = params.keepUserData === undefined ? null : new Set(params.keepUserData);

  const idempotencyRedisKey = storeUninstallIdempotencyRedisKey(
    tenantId,
    spaceId,
    catalogId,
    idempotencyKey,
  );
  if (redis) {
    const claimed = await redis.set(
      idempotencyRedisKey,
      IDEMPOTENCY_PENDING,
      'EX',
      STORE_UNINSTALL_IDEMPOTENCY_PENDING_TTL_SECONDS,
      'NX',
    );
    if (!claimed) {
      const recorded = await redis.get(idempotencyRedisKey);
      if (recorded && recorded !== IDEMPOTENCY_PENDING) {
        return { ok: true, response: StoreUninstallResponseSchema.parse(JSON.parse(recorded)) };
      }
      return {
        ok: false,
        statusCode: 409,
        body: {
          error: 'An identical store uninstall is already in progress. Retry shortly.',
          code: 'STORE_MUTATION_IN_PROGRESS',
        },
      };
    }
  }

  let outcome: UninstallTxOutcome;
  try {
    outcome = await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
      runStoreUninstall(tx, { tenantId, spaceId, actorUserId }, catalogId, keepUserData),
    );
  } catch (err) {
    if (redis) await redis.del(idempotencyRedisKey);
    if (err instanceof StoreUninstallError) {
      return { ok: false, statusCode: err.statusCode, body: err.body };
    }
    throw err;
  }
  const { plan, archivedInstances } = outcome;

  if (redis) {
    publishUninstallInvalidations(redis, tenantId, spaceId, plan);
    for (const affectedSpaceId of new Set(archivedInstances.map((ref) => ref.spaceId))) {
      await bumpAttentionGeneration(redis, tenantId, affectedSpaceId);
    }
    await redis.set(
      idempotencyRedisKey,
      JSON.stringify(plan.response),
      'EX',
      STORE_UNINSTALL_IDEMPOTENCY_TTL_SECONDS,
    );
  }
  return { ok: true, response: plan.response };
}
