/**
 * Store update execution — the one authority every update surface calls.
 * Same mutation contract as install (expectedVersion → CATALOG_CHANGED,
 * tenant shelf gate, idempotency claim/replay, the space-scoped advisory
 * lock, one transaction), plus the update-specific rules: `keep` records the
 * skipped version and touches no artifact; `update` refuses a customized
 * installation (recompute-at-read divergence) unless the caller explicitly
 * chose `replace_customized`; the dispatch runs per-kind UPDATE handlers —
 * never the install backends — and re-stamps provenance at the new version.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from 'ioredis';
import {
  createMemoryDocRepository,
  createTenantContext,
  getTenantStoreShelfPolicy,
  withTenantSchema,
} from '@aflow/database';
import {
  buildBundleClaimant,
  StoreUpdateResponseSchema,
  type CatalogBundleEntry,
  type CatalogConnectorEntry,
  type CatalogEntry,
  type PostInstallTask,
  type SpaceId,
  type StoreCatalogChangedError,
  type StoreInstallDivergence,
  type StoreUpdateErrorBody,
  type StoreUpdateMode,
  type StoreUpdatePreviewResponse,
  type StoreUpdateResponse,
  type StoreUpdatedArtifact,
  type MemoryDocEmbedJob,
  type TenantId,
} from '@aflow/schemas';
import { getCatalogEntry, getSkillCatalogEntry } from '@aflow/platform-artifacts';
import type { ApplyContext } from '../stagedChange/applyRatifiedOps.js';
import { tryAcquireStoreMutationLock } from '../stagedChange/storeMutationLock.js';
import { updateSkillCatalogEntry } from '../stagedChange/skillCatalogUpdate.js';
import { installSkillCatalogEntry } from '../stagedChange/skillCatalogInstall.js';
import {
  buildPlaceholderAuthJsonFromSlots,
  extractCredentialKeys,
  writeApiDefinitionDraft,
  writePlaceholderBinding,
  BundleWriteConflictError,
} from '../stagedChange/apiWriteHelpers.js';
import {
  buildPlaceholderMcpAuthJsonFromSlots,
  extractMcpCredentialKeys,
  writeMcpServerDefinition,
  writePlaceholderMcpBinding,
  McpBundleWriteConflictError,
} from '../stagedChange/mcpWriteHelpers.js';
import { generatePostInstallManifest } from '../stagedChange/bundleInstallManifest.js';
import {
  applyMemorySeeds,
  publishMemorySeedEmbedJobs,
} from '../stagedChange/bundleInstallContent.js';
import { applyArtifactSeeds } from '../stagedChange/applyArtifactSeeds.js';
import { sql } from 'drizzle-orm';
import { publishApiCatalogInvalidation, publishMcpCatalogInvalidation } from '@aflow/redis';
import { mergeBindingAuth } from './bindingMerge.js';
import {
  connectorDefaultBindingId,
  publishApiConnectorInstallInvalidations,
  publishMcpConnectorInstallInvalidations,
} from './connectorInstall.js';
import { updateApiConnectorEntry, updateMcpConnectorEntry } from './connectorUpdate.js';
import { computeInstallDivergence } from './storeDivergence.js';
import { dispatchAppletUpdate } from './appletInstall.js';
import {
  deleteStoreInstallArtifact,
  deleteStoreInstallClaim,
  getStoreInstall,
  listStoreInstallArtifacts,
  listStoreInstallArtifactsBySpace,
  listStoreInstallClaimsByClaimant,
  restampStoreInstallArtifactHash,
  setStoreInstallSkippedVersion,
} from './storeInstallProvenance.js';
import { writeProvenance } from './storeInstallExecution.js';
import {
  deriveInstalledState,
  deriveInstallProvenance,
  deriveRegistryArtifactContents,
  isListingOnTenantShelf,
  provenanceArtifactKey,
} from './storeDerivations.js';

// ============================================================================
// Result contract
// ============================================================================

export type StoreUpdateFailureStatus = 400 | 404 | 409;

export type ExecuteStoreUpdateResult =
  | { ok: true; response: StoreUpdateResponse }
  | { ok: false; statusCode: StoreUpdateFailureStatus; body: StoreUpdateErrorBody };

class StoreUpdateError extends Error {
  constructor(
    readonly statusCode: StoreUpdateFailureStatus,
    readonly body: StoreUpdateErrorBody,
  ) {
    super(body.error);
    this.name = 'StoreUpdateError';
  }
}

export interface ExecuteStoreUpdateParams {
  db: PostgresJsDatabase;
  redis: Redis | null;
  tenantId: TenantId;
  spaceId: string;
  actorUserId: string;
  catalogId: string;
  expectedVersion: number;
  idempotencyKey: string;
  mode: StoreUpdateMode;
  /** Persists an artifact seed's source when it exceeds the inline payload cap. */
  payloadStore?: PayloadStore | undefined;
  /** Override for tests; defaults to the platform catalog registry. */
  entryResolver?: (catalogId: string) => CatalogEntry | null | undefined;
}

export interface ExecuteStoreUpdatePreviewParams {
  db: PostgresJsDatabase;
  tenantId: TenantId;
  spaceId: string;
  catalogId: string;
  /** Reconstructs a content-addressed applet source for the Mine-vs-Store payload. */
  payloadStore?: PayloadStore | undefined;
  /** Override for tests; defaults to the platform catalog registry. */
  entryResolver?: (catalogId: string) => CatalogEntry | null | undefined;
}

export type ExecuteStoreUpdatePreviewResult =
  | { ok: true; response: StoreUpdatePreviewResponse }
  | { ok: false; statusCode: 404; body: StoreUpdateErrorBody };

// ============================================================================
// Shared resolution (update + update-preview)
// ============================================================================

function listingNotFoundBody(catalogId: string): StoreUpdateErrorBody {
  return { error: `Store listing '${catalogId}' not found` };
}

function notInstalledBody(catalogId: string, offShelf: boolean): StoreUpdateErrorBody {
  // An off-shelf listing the space never installed must fail exactly like an
  // unknown id — a distinct message would disclose its existence.
  return offShelf
    ? listingNotFoundBody(catalogId)
    : {
        error: `'${catalogId}' is not installed in this space.`,
        code: 'NOT_INSTALLED',
        catalogId,
      };
}

type ResolveShelfEntryResult =
  | { ok: true; entry: CatalogEntry; offShelf: boolean }
  | { ok: false; statusCode: 404; body: StoreUpdateErrorBody };

async function resolveShelfEntry(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  catalogId: string,
  resolveEntry: (catalogId: string) => CatalogEntry | null | undefined,
): Promise<ResolveShelfEntryResult> {
  const entry = resolveEntry(catalogId) ?? null;
  if (!entry) {
    return { ok: false, statusCode: 404, body: listingNotFoundBody(catalogId) };
  }
  const shelf = await getTenantStoreShelfPolicy(db, tenantId);
  const offShelf = !isListingOnTenantShelf(entry, new Set(), shelf);
  return { ok: true, entry, offShelf };
}

// ============================================================================
// Idempotency (same TTL contract as install, separate namespace)
// ============================================================================

const STORE_UPDATE_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const STORE_UPDATE_IDEMPOTENCY_PENDING_TTL_SECONDS = 300;
const IDEMPOTENCY_PENDING = 'pending';

function storeUpdateIdempotencyRedisKey(
  tenantId: string,
  spaceId: string,
  catalogId: string,
  idempotencyKey: string,
): string {
  return `aflow:idempotency:store_update:${tenantId}:${spaceId}:${catalogId}:${idempotencyKey}`;
}

// ============================================================================
// Per-kind update dispatch
// ============================================================================

export interface UpdateDispatchOutcome {
  updatedArtifacts: StoreUpdatedArtifact[];
  keptUserDataArtifacts: Array<{
    artifactType: StoreUpdatedArtifact['artifactType'];
    artifactKey: string;
  }>;
  credentialsReset: boolean;
  missingVariables: string[];
  setupChecklist: PostInstallTask[];
  /** user_data_keep artifacts this dispatch wrote fresh — their provenance takes the new stamp. */
  installedUserDataKeys: ReadonlySet<string>;
  /** Linkable-seed embed jobs to publish AFTER the update tx commits. */
  pendingEmbedJobs: MemoryDocEmbedJob[];
}

async function dispatchConnectorUpdate(
  tx: PostgresJsDatabase,
  entry: CatalogConnectorEntry,
  ids: { tenantId: TenantId; spaceId: string; payloadStore?: PayloadStore | undefined },
): Promise<UpdateDispatchOutcome> {
  const context = {
    db: tx,
    redis: null,
    tenantId: ids.tenantId,
    spaceId: ids.spaceId as SpaceId,
  };
  if (entry.sourceKind === 'api') {
    const result = await updateApiConnectorEntry({ entry: entry.payload, context });
    if (result.outcome === 'invalid_entry') {
      throw new StoreUpdateError(400, { error: result.error });
    }
    return {
      updatedArtifacts: [
        { artifactType: 'api_definition', artifactKey: result.apiId, action: 'replaced' },
      ],
      keptUserDataArtifacts: [{ artifactType: 'api_binding', artifactKey: result.bindingId }],
      credentialsReset: result.credentialsReset,
      missingVariables: result.missingVariables,
      setupChecklist: result.setupChecklist,
      installedUserDataKeys: new Set(),
      pendingEmbedJobs: [],
    };
  }
  const result = await updateMcpConnectorEntry({ entry: entry.payload, context });
  if (result.outcome === 'invalid_entry') {
    throw new StoreUpdateError(400, { error: result.error });
  }
  return {
    updatedArtifacts: [
      { artifactType: 'mcp_definition', artifactKey: result.serverId, action: 'replaced' },
    ],
    keptUserDataArtifacts: [{ artifactType: 'mcp_binding', artifactKey: result.bindingId }],
    credentialsReset: result.credentialsReset,
    missingVariables: [],
    setupChecklist: result.setupChecklist,
    installedUserDataKeys: new Set(),
    pendingEmbedJobs: [],
  };
}

async function mergeTemplateBindingAuth(
  tx: PostgresJsDatabase,
  opts: {
    table: 'api_bindings' | 'mcp_server_bindings';
    bindingId: string;
    spaceId: string;
    placeholderAuthJson: Record<string, unknown>;
    extractKeys: (authJson: Record<string, unknown>) => string[];
  },
): Promise<{ present: boolean; reset: boolean }> {
  const rows =
    opts.table === 'api_bindings'
      ? await tx.execute<{ auth_json: Record<string, unknown> }>(sql`
          SELECT auth_json FROM api_bindings
          WHERE binding_id = ${opts.bindingId} AND space_id = ${opts.spaceId}::uuid
          LIMIT 1
        `)
      : await tx.execute<{ auth_json: Record<string, unknown> }>(sql`
          SELECT auth_json FROM mcp_server_bindings
          WHERE binding_id = ${opts.bindingId} AND space_id = ${opts.spaceId}::uuid
          LIMIT 1
        `);
  const row = rows[0];
  if (row === undefined) return { present: false, reset: false };
  const merged = mergeBindingAuth({
    existingAuthJson: row.auth_json,
    placeholderAuthJson: opts.placeholderAuthJson,
    extractCredentialKeys: opts.extractKeys,
  });
  if (merged.reset) {
    if (opts.table === 'api_bindings') {
      await tx.execute(sql`
        UPDATE api_bindings SET
          auth_json = ${JSON.stringify(merged.authJson)}::jsonb,
          updated_at = NOW()
        WHERE binding_id = ${opts.bindingId} AND space_id = ${opts.spaceId}::uuid
      `);
    } else {
      await tx.execute(sql`
        UPDATE mcp_server_bindings SET
          auth_json = ${JSON.stringify(merged.authJson)}::jsonb,
          updated_at = NOW()
        WHERE binding_id = ${opts.bindingId} AND space_id = ${opts.spaceId}::uuid
      `);
    }
  }
  return { present: true, reset: merged.reset };
}

async function dispatchBundleUpdate(
  tx: PostgresJsDatabase,
  entry: CatalogBundleEntry,
  ids: { tenantId: TenantId; spaceId: string; payloadStore?: PayloadStore | undefined },
): Promise<UpdateDispatchOutcome> {
  const bundle = entry.payload;
  const ctx: ApplyContext = {
    tenantId: ids.tenantId,
    spaceId: ids.spaceId,
    db: tx,
    payloadStore: ids.payloadStore,
    inTransaction: true,
  };
  const updatedArtifacts: StoreUpdatedArtifact[] = [];
  const keptUserDataArtifacts: UpdateDispatchOutcome['keptUserDataArtifacts'] = [];
  const installedUserDataKeys = new Set<string>();
  let credentialsReset = false;

  // Ownership gate: only artifacts store provenance owns are overwritten. A
  // same-key artifact the user authored themselves (no provenance row —
  // invisible to divergence) routes through the install-style conflict path.
  const ownedKeys = new Set(
    (await listStoreInstallArtifactsBySpace(tx, ids.spaceId)).map(provenanceArtifactKey),
  );

  for (const memberId of bundle.skillCatalogIds) {
    const member = getSkillCatalogEntry(memberId);
    if (!member) continue;
    const slug = member.bundle.workflow.slug;
    const owned =
      ownedKeys.has(provenanceArtifactKey({ artifactType: 'skill', artifactKey: slug })) ||
      (await getStoreInstall(tx, ids.spaceId, memberId)) !== null;
    if (owned) {
      const result = await updateSkillCatalogEntry(ctx, {
        bundle: member.bundle,
        sourceCatalogId: member.catalogId,
        sourceVersion: member.version,
      });
      if (result.outcome === 'invalid_bundle') {
        throw new StoreUpdateError(400, {
          error: `Bundle member '${memberId}': ${result.error}`,
        });
      }
      updatedArtifacts.push({
        artifactType: 'skill',
        artifactKey: slug,
        action: result.outcome === 'installed' ? 'installed' : 'replaced',
      });
    } else {
      const result = await installSkillCatalogEntry(ctx, {
        bundle: member.bundle,
        sourceCatalogId: member.catalogId,
        sourceVersion: member.version,
      });
      if (result.outcome === 'invalid_bundle') {
        throw new StoreUpdateError(400, {
          error: `Bundle member '${memberId}': ${result.error}`,
        });
      }
      if (result.outcome === 'slug_conflict') {
        throw new StoreUpdateError(409, {
          error:
            `Bundle member '${memberId}': a skill with slug '${slug}' already exists in this ` +
            `space and was not installed from the store — rename or remove it, then retry.`,
          code: 'ARTIFACT_CONFLICT',
          conflictingKey: slug,
        });
      }
      updatedArtifacts.push({ artifactType: 'skill', artifactKey: slug, action: 'installed' });
    }
  }

  for (const definition of bundle.apiDefinitions) {
    const owned = ownedKeys.has(
      provenanceArtifactKey({ artifactType: 'api_definition', artifactKey: definition.apiId }),
    );
    try {
      await writeApiDefinitionDraft({
        apiId: definition.apiId,
        draft: definition.definition,
        spaceId: ids.spaceId,
        conflictPolicy: owned ? 'overwrite' : 'fail',
        tx,
      });
    } catch (err) {
      if (err instanceof BundleWriteConflictError) {
        throw new StoreUpdateError(409, {
          error:
            `API definition '${definition.apiId}' already exists in this space and was not ` +
            `installed from the store — remove it or resolve the conflict, then retry.`,
          code: 'ARTIFACT_CONFLICT',
          conflictingKey: definition.apiId,
        });
      }
      throw err;
    }
    updatedArtifacts.push({
      artifactType: 'api_definition',
      artifactKey: definition.apiId,
      action: owned ? 'replaced' : 'installed',
    });
  }
  for (const template of bundle.apiBindingTemplates) {
    const placeholderAuthJson = buildPlaceholderAuthJsonFromSlots(
      template.authShape,
      template.credentialSlots,
    );
    const merge = await mergeTemplateBindingAuth(tx, {
      table: 'api_bindings',
      bindingId: template.bindingId,
      spaceId: ids.spaceId,
      placeholderAuthJson,
      extractKeys: extractCredentialKeys,
    });
    if (!merge.present) {
      await writePlaceholderBinding({
        bindingId: template.bindingId,
        apiId: template.apiId,
        spaceId: ids.spaceId,
        name: template.name,
        ...(template.description !== undefined ? { description: template.description } : {}),
        scope: { tenantId: ids.tenantId as string, spaceId: ids.spaceId },
        authJson: placeholderAuthJson,
        egressPolicy: template.egressPolicy,
        conflictPolicy: 'skip',
        tx,
      });
      updatedArtifacts.push({
        artifactType: 'api_binding',
        artifactKey: template.bindingId,
        action: 'installed',
      });
      installedUserDataKeys.add(
        provenanceArtifactKey({ artifactType: 'api_binding', artifactKey: template.bindingId }),
      );
    } else {
      keptUserDataArtifacts.push({
        artifactType: 'api_binding',
        artifactKey: template.bindingId,
      });
      credentialsReset = credentialsReset || merge.reset;
    }
  }

  for (const definition of bundle.mcpDefinitions) {
    const owned = ownedKeys.has(
      provenanceArtifactKey({ artifactType: 'mcp_definition', artifactKey: definition.serverId }),
    );
    try {
      await writeMcpServerDefinition({
        serverId: definition.serverId,
        definition: definition.definition,
        source: 'bundle',
        spaceId: ids.spaceId,
        conflictPolicy: owned ? 'overwrite' : 'fail',
        tx,
      });
    } catch (err) {
      if (err instanceof McpBundleWriteConflictError) {
        throw new StoreUpdateError(409, {
          error:
            `MCP server '${definition.serverId}' already exists in this space and was not ` +
            `installed from the store — remove it or resolve the conflict, then retry.`,
          code: 'ARTIFACT_CONFLICT',
          conflictingKey: definition.serverId,
        });
      }
      throw err;
    }
    updatedArtifacts.push({
      artifactType: 'mcp_definition',
      artifactKey: definition.serverId,
      action: owned ? 'replaced' : 'installed',
    });
  }
  for (const template of bundle.mcpBindingTemplates) {
    const placeholderAuthJson = buildPlaceholderMcpAuthJsonFromSlots(
      template.authShape,
      template.credentialSlots,
    );
    const merge = await mergeTemplateBindingAuth(tx, {
      table: 'mcp_server_bindings',
      bindingId: template.bindingId,
      spaceId: ids.spaceId,
      placeholderAuthJson,
      extractKeys: extractMcpCredentialKeys,
    });
    if (!merge.present) {
      await writePlaceholderMcpBinding({
        bindingId: template.bindingId,
        serverId: template.serverId,
        spaceId: ids.spaceId,
        name: template.name,
        ...(template.description !== undefined ? { description: template.description } : {}),
        scope: { tenantId: ids.tenantId as string, spaceId: ids.spaceId },
        authJson: placeholderAuthJson,
        subscribeListChanged: template.subscribeListChanged,
        samplingPolicy: template.samplingPolicy,
        conflictPolicy: 'skip',
        tx,
      });
      updatedArtifacts.push({
        artifactType: 'mcp_binding',
        artifactKey: template.bindingId,
        action: 'installed',
      });
      installedUserDataKeys.add(
        provenanceArtifactKey({ artifactType: 'mcp_binding', artifactKey: template.bindingId }),
      );
    } else {
      keptUserDataArtifacts.push({
        artifactType: 'mcp_binding',
        artifactKey: template.bindingId,
      });
      credentialsReset = credentialsReset || merge.reset;
    }
  }

  const repo = createMemoryDocRepository(tx, createTenantContext(ids.tenantId), {
    inTransaction: true,
  });

  const absentMemorySeeds: typeof bundle.memorySeed = [];
  for (const seed of bundle.memorySeed) {
    const existing = await repo.getByPath(seed.path, ids.spaceId);
    if (existing) {
      keptUserDataArtifacts.push({ artifactType: 'memory_doc', artifactKey: seed.path });
    } else {
      absentMemorySeeds.push(seed);
    }
  }
  const pendingEmbedJobs: MemoryDocEmbedJob[] = [];
  if (absentMemorySeeds.length > 0) {
    const seedResult = await applyMemorySeeds({
      memorySeed: absentMemorySeeds,
      spaceId: ids.spaceId,
      tenantId: ids.tenantId,
      repo,
    });
    pendingEmbedJobs.push(...seedResult.pendingEmbedJobs);
    for (const seed of absentMemorySeeds) {
      updatedArtifacts.push({
        artifactType: 'memory_doc',
        artifactKey: seed.path,
        action: 'installed',
      });
      installedUserDataKeys.add(
        provenanceArtifactKey({ artifactType: 'memory_doc', artifactKey: seed.path }),
      );
    }
  }

  const absentArtifactSeeds: typeof bundle.artifactSeed = [];
  for (const seed of bundle.artifactSeed) {
    if (await uiArtifactExists(tx, ids.spaceId, seed.bundleArtifactKey)) {
      keptUserDataArtifacts.push({
        artifactType: 'ui_artifact',
        artifactKey: seed.bundleArtifactKey,
      });
    } else {
      absentArtifactSeeds.push(seed);
    }
  }
  if (absentArtifactSeeds.length > 0) {
    await applyArtifactSeeds({
      bundle: { bundleId: bundle.bundleId, artifactSeed: absentArtifactSeeds },
      tenantId: ids.tenantId as string,
      spaceId: ids.spaceId,
      tx,
      payloadStore: ids.payloadStore,
    });
    for (const seed of absentArtifactSeeds) {
      updatedArtifacts.push({
        artifactType: 'ui_artifact',
        artifactKey: seed.bundleArtifactKey,
        action: 'installed',
      });
      installedUserDataKeys.add(
        provenanceArtifactKey({ artifactType: 'ui_artifact', artifactKey: seed.bundleArtifactKey }),
      );
    }
  }

  const setupChecklist = await generatePostInstallManifest({
    bundle,
    tenantId: ids.tenantId as string,
    spaceId: ids.spaceId,
    tx,
    repo,
  });

  return {
    updatedArtifacts,
    keptUserDataArtifacts,
    credentialsReset,
    missingVariables: [],
    setupChecklist,
    installedUserDataKeys,
    pendingEmbedJobs,
  };
}

async function uiArtifactExists(
  tx: PostgresJsDatabase,
  spaceId: string,
  bundleArtifactKey: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT id FROM ui_artifacts
    WHERE space_id = ${spaceId}::uuid
      AND bundle_artifact_key = ${bundleArtifactKey}
      AND deleted_at IS NULL
    LIMIT 1
  `);
  return rows.length > 0;
}

async function dispatchUpdate(
  tx: PostgresJsDatabase,
  entry: CatalogEntry,
  ids: { tenantId: TenantId; spaceId: string; payloadStore?: PayloadStore | undefined },
): Promise<UpdateDispatchOutcome> {
  switch (entry.kind) {
    case 'bundle':
      return dispatchBundleUpdate(tx, entry, ids);
    case 'connector':
      return dispatchConnectorUpdate(tx, entry, ids);
    case 'applet':
      // A new version on the installed head — instances stay pinned and move
      // only through the lifecycle upgrade surface, never on store update.
      return dispatchAppletUpdate(tx, entry, ids);
  }
}

// ============================================================================
// The update transaction
// ============================================================================

interface UpdateTxOutcome {
  response: StoreUpdateResponse;
  entryKind: CatalogEntry['kind'];
  /** Linkable-seed embed jobs — published post-commit by the caller. */
  pendingEmbedJobs: MemoryDocEmbedJob[];
}

async function runStoreUpdate(
  tx: PostgresJsDatabase,
  entry: CatalogEntry,
  ids: {
    tenantId: TenantId;
    spaceId: string;
    actorUserId: string;
    payloadStore?: PayloadStore | undefined;
  },
  opts: { mode: StoreUpdateMode; offShelf: boolean },
): Promise<UpdateTxOutcome> {
  const acquired = await tryAcquireStoreMutationLock(tx, ids.spaceId);
  if (!acquired) {
    throw new StoreUpdateError(409, {
      error: 'Another store mutation is in progress for this space. Retry shortly.',
      code: 'STORE_MUTATION_IN_PROGRESS',
    });
  }

  const now = new Date().toISOString();
  const existing = await getStoreInstall(tx, ids.spaceId, entry.catalogId);
  if (!existing) {
    throw new StoreUpdateError(404, notInstalledBody(entry.catalogId, opts.offShelf));
  }
  if (existing.state === 'removing') {
    throw new StoreUpdateError(409, {
      error: `'${entry.catalogId}' is being removed from this space. Retry after the removal completes.`,
      code: 'REMOVAL_IN_PROGRESS',
    });
  }
  if (existing.installedVersion >= entry.version) {
    throw new StoreUpdateError(409, {
      error:
        `'${entry.catalogId}' is already at version ${existing.installedVersion}; ` +
        `the catalog offers ${entry.version} — nothing to update.`,
      code: 'ALREADY_CURRENT',
      catalogId: entry.catalogId,
      currentVersion: existing.installedVersion,
      catalogVersion: entry.version,
    });
  }

  if (opts.mode === 'keep') {
    await setStoreInstallSkippedVersion(tx, ids.spaceId, entry.catalogId, entry.version, {
      updatedAt: now,
      updatedBy: ids.actorUserId,
    });
    const install = await getStoreInstall(tx, ids.spaceId, entry.catalogId);
    return {
      response: {
        catalogId: entry.catalogId,
        mode: 'keep',
        fromVersion: existing.installedVersion,
        toVersion: existing.installedVersion,
        updatedArtifacts: [],
        keptUserDataArtifacts: [],
        orphanedArtifacts: [],
        credentialsReset: false,
        missingVariables: [],
        setupChecklist: [],
        install: install ?? existing,
      },
      entryKind: entry.kind,
      pendingEmbedJobs: [],
    };
  }

  const divergence: StoreInstallDivergence = await computeInstallDivergence(
    tx,
    { tenantId: ids.tenantId, spaceId: ids.spaceId, payloadStore: ids.payloadStore },
    entry.catalogId,
    { registryContents: deriveRegistryArtifactContents(entry) },
  );
  if (divergence.customized && opts.mode !== 'replace_customized') {
    throw new StoreUpdateError(409, {
      error:
        `'${entry.catalogId}' has been customized in this space. ` +
        `Choose 'replace_customized' to discard the customizations, or 'keep' to stay on the installed version.`,
      code: 'STORE_CUSTOMIZED',
      catalogId: entry.catalogId,
      divergence,
    });
  }

  const previousArtifacts = await listStoreInstallArtifacts(tx, ids.spaceId, entry.catalogId);

  const dispatch = await dispatchUpdate(tx, entry, ids);

  const plan = deriveInstallProvenance(entry, {
    spaceId: ids.spaceId,
    actorUserId: ids.actorUserId,
    now,
  });

  // Provenance the new version no longer covers is released — the space
  // artifacts stay; the response names what fell out of store management.
  const nextOwnKeys = new Set(
    plan.artifacts
      .filter((artifact) => artifact.catalogId === entry.catalogId)
      .map(provenanceArtifactKey),
  );
  const orphanedArtifacts: StoreUpdateResponse['orphanedArtifacts'] = [];
  for (const row of previousArtifacts) {
    if (nextOwnKeys.has(provenanceArtifactKey(row))) continue;
    await deleteStoreInstallArtifact(
      tx,
      ids.spaceId,
      entry.catalogId,
      row.artifactType,
      row.artifactKey,
    );
    orphanedArtifacts.push({ artifactType: row.artifactType, artifactKey: row.artifactKey });
  }
  if (entry.kind === 'bundle') {
    const claimant = buildBundleClaimant(entry.catalogId);
    const nextClaimedIds = new Set(
      plan.claims.filter((claim) => claim.claimedBy === claimant).map((claim) => claim.catalogId),
    );
    for (const claim of await listStoreInstallClaimsByClaimant(tx, ids.spaceId, claimant)) {
      if (nextClaimedIds.has(claim.catalogId)) continue;
      await deleteStoreInstallClaim(tx, ids.spaceId, claim.catalogId, claimant);
    }
  }

  // user_data_keep rows keep their original stamps — except the ones this
  // dispatch wrote fresh (new-in-version seeds/placeholders).
  const keepStampKeys = new Set(
    plan.artifacts
      .filter((artifact) => artifact.preservation === 'user_data_keep')
      .map(provenanceArtifactKey),
  );
  for (const key of dispatch.installedUserDataKeys) keepStampKeys.delete(key);
  await writeProvenance(tx, plan, {
    entryRow: 'replace',
    skips: { memberCatalogIds: new Set<string>(), artifactKeys: keepStampKeys },
  });

  // Cross-claimant re-stamp: every row sharing (space, type, key) moves to
  // the new hash, so a shared member's other claimants stay pristine.
  const restampedKeys = new Set<string>();
  for (const artifact of plan.artifacts) {
    if (artifact.preservation !== 'replace_on_update') continue;
    const key = provenanceArtifactKey(artifact);
    if (restampedKeys.has(key)) continue;
    restampedKeys.add(key);
    await restampStoreInstallArtifactHash(tx, ids.spaceId, artifact);
  }

  const install = await getStoreInstall(tx, ids.spaceId, entry.catalogId);
  return {
    response: {
      catalogId: entry.catalogId,
      mode: opts.mode,
      fromVersion: existing.installedVersion,
      toVersion: entry.version,
      updatedArtifacts: dispatch.updatedArtifacts,
      keptUserDataArtifacts: dispatch.keptUserDataArtifacts,
      orphanedArtifacts,
      credentialsReset: dispatch.credentialsReset,
      missingVariables: dispatch.missingVariables,
      setupChecklist: dispatch.setupChecklist,
      install: install ?? plan.install,
    },
    entryKind: entry.kind,
    pendingEmbedJobs: dispatch.pendingEmbedJobs,
  };
}

// ============================================================================
// Post-commit invalidations
// ============================================================================

function publishUpdateInvalidations(
  redis: Redis,
  tenantId: TenantId,
  spaceId: string,
  entry: CatalogEntry,
): void {
  switch (entry.kind) {
    case 'connector':
      if (entry.sourceKind === 'api') {
        publishApiConnectorInstallInvalidations(
          redis,
          tenantId,
          spaceId as SpaceId,
          entry.payload.definition.apiId,
        );
      } else {
        publishMcpConnectorInstallInvalidations(
          redis,
          tenantId,
          spaceId as SpaceId,
          entry.payload.definition.serverId,
          connectorDefaultBindingId(entry.payload.definition.serverId),
        );
      }
      return;
    case 'bundle': {
      const bundle = entry.payload;
      if (bundle.apiDefinitions.length > 0) {
        publishApiCatalogInvalidation(redis, tenantId as string, spaceId, { kind: 'definition' });
      }
      if (bundle.apiBindingTemplates.length > 0) {
        publishApiCatalogInvalidation(redis, tenantId as string, spaceId, { kind: 'binding' });
      }
      for (const definition of bundle.mcpDefinitions) {
        publishMcpCatalogInvalidation(redis, tenantId as string, spaceId, {
          kind: 'definition',
          serverId: definition.serverId,
        });
      }
      for (const template of bundle.mcpBindingTemplates) {
        publishMcpCatalogInvalidation(redis, tenantId as string, spaceId, {
          kind: 'binding',
          serverId: template.serverId,
          bindingId: template.bindingId,
        });
      }
      return;
    }
    // The applet write already invalidates the in-process artifact-binding
    // cache; instances resolve the pinned version by id, uncached.
    case 'applet':
      return;
  }
}

// ============================================================================
// Entry point
// ============================================================================

export async function executeStoreUpdate(
  params: ExecuteStoreUpdateParams,
): Promise<ExecuteStoreUpdateResult> {
  const {
    db,
    redis,
    tenantId,
    spaceId,
    actorUserId,
    catalogId,
    expectedVersion,
    idempotencyKey,
    mode,
    payloadStore,
  } = params;
  const resolveEntry = params.entryResolver ?? getCatalogEntry;

  const resolved = await resolveShelfEntry(db, tenantId, catalogId, resolveEntry);
  if (!resolved.ok) return resolved;
  const { entry, offShelf } = resolved;

  const tenantCtx = createTenantContext(tenantId);
  // An off-shelf listing the space never installed must fail exactly like an
  // unknown id — any later check (version) would disclose its existence.
  if (offShelf) {
    const existing = await withTenantSchema(db, tenantCtx, async (tx) =>
      getStoreInstall(tx, spaceId, entry.catalogId),
    );
    if (!existing) {
      return { ok: false, statusCode: 404, body: listingNotFoundBody(catalogId) };
    }
  }

  if (entry.version !== expectedVersion) {
    return {
      ok: false,
      statusCode: 409,
      body: {
        error:
          `Listing '${entry.catalogId}' changed since preview ` +
          `(expected version ${expectedVersion}, current ${entry.version}). Re-preview and retry.`,
        code: 'CATALOG_CHANGED',
        catalogId: entry.catalogId,
        expectedVersion,
        currentVersion: entry.version,
      } satisfies StoreCatalogChangedError,
    };
  }

  const idempotencyRedisKey = storeUpdateIdempotencyRedisKey(
    tenantId,
    spaceId,
    entry.catalogId,
    idempotencyKey,
  );
  if (redis) {
    const claimed = await redis.set(
      idempotencyRedisKey,
      IDEMPOTENCY_PENDING,
      'EX',
      STORE_UPDATE_IDEMPOTENCY_PENDING_TTL_SECONDS,
      'NX',
    );
    if (!claimed) {
      const recorded = await redis.get(idempotencyRedisKey);
      if (recorded && recorded !== IDEMPOTENCY_PENDING) {
        return { ok: true, response: StoreUpdateResponseSchema.parse(JSON.parse(recorded)) };
      }
      return {
        ok: false,
        statusCode: 409,
        body: {
          error: 'An identical store update is already in progress. Retry shortly.',
          code: 'STORE_MUTATION_IN_PROGRESS',
        },
      };
    }
  }

  let outcome: UpdateTxOutcome;
  try {
    outcome = await withTenantSchema(db, tenantCtx, async (tx) =>
      runStoreUpdate(
        tx,
        entry,
        { tenantId, spaceId, actorUserId, payloadStore },
        { mode, offShelf },
      ),
    );
  } catch (err) {
    if (redis) await redis.del(idempotencyRedisKey);
    if (err instanceof StoreUpdateError) {
      return { ok: false, statusCode: err.statusCode, body: err.body };
    }
    throw err;
  }

  if (redis && mode !== 'keep') {
    publishUpdateInvalidations(redis, tenantId, spaceId, entry);
  }
  if (redis) {
    await publishMemorySeedEmbedJobs(redis, outcome.pendingEmbedJobs);
  }
  if (redis) {
    await redis.set(
      idempotencyRedisKey,
      JSON.stringify(outcome.response),
      'EX',
      STORE_UPDATE_IDEMPOTENCY_TTL_SECONDS,
    );
  }
  return { ok: true, response: outcome.response };
}

export async function executeStoreUpdatePreview(
  params: ExecuteStoreUpdatePreviewParams,
): Promise<ExecuteStoreUpdatePreviewResult> {
  const { db, tenantId, spaceId, catalogId } = params;
  const resolveEntry = params.entryResolver ?? getCatalogEntry;

  const resolved = await resolveShelfEntry(db, tenantId, catalogId, resolveEntry);
  if (!resolved.ok) return resolved;
  const { entry, offShelf } = resolved;

  const registryContents = deriveRegistryArtifactContents(entry);
  const result = await withTenantSchema(db, createTenantContext(tenantId), async (tx) => {
    const install = await getStoreInstall(tx, spaceId, entry.catalogId);
    if (!install) return null;
    const divergence = await computeInstallDivergence(
      tx,
      { tenantId, spaceId, payloadStore: params.payloadStore },
      entry.catalogId,
      { registryContents },
    );
    return { install, divergence };
  });
  if (!result) {
    return { ok: false, statusCode: 404, body: notInstalledBody(entry.catalogId, offShelf) };
  }

  return {
    ok: true,
    response: {
      catalogId: entry.catalogId,
      currentVersion: result.install.installedVersion,
      catalogVersion: entry.version,
      updateAvailable: deriveInstalledState(entry, result.install).updateAvailable,
      ...(result.install.skippedVersion !== undefined
        ? { skippedVersion: result.install.skippedVersion }
        : {}),
      divergence: result.divergence,
    },
  };
}
