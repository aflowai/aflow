/**
 * Store install execution — the one authority every install surface calls
 * (HTTP route, StagedChange ratification). Owns the full mutation contract:
 * expectedVersion check against the live catalog, tenant shelf gate,
 * idempotency claim/replay, the space-scoped advisory lock, per-kind dispatch
 * (including adopt-on-conflict for pre-store artifacts), provenance capture,
 * and post-commit catalog invalidations. Callers only map the typed result
 * onto their surface.
 */
import { sql, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from 'ioredis';
import {
  createTenantContext,
  getTenantStoreShelfPolicy,
  withTenantSchema,
  spaces,
} from '@aflow/database';
import {
  StoreInstallResponseSchema,
  processEditionDescriptor,
  type CatalogEntry,
  type CatalogBundleEntry,
  type ComposedLanes,
  type CatalogConnectorEntry,
  type PostInstallTask,
  type SkillBundle,
  type SpaceId,
  type StoreCatalogChangedError,
  type StoreInstallErrorBody,
  type StoreInstallResponse,
  type StoreInstallResult,
  type TenantId,
} from '@aflow/schemas';
import { getCatalogEntry, uncomposedListingReason } from '@aflow/platform-artifacts';
import { extractCredentialKeys } from '../stagedChange/apiWriteHelpers.js';
import { fetchPresentCredentialKeys } from '../stagedChange/bundleInstallManifest.js';
import {
  installSkillBundle,
  publishBundleInstallInvalidations,
  BundleInstallInProgressError,
  BundleInstallValidationError,
  BundlePartiallyInstalledError,
  type InstallSkillBundleResult,
} from '../stagedChange/skillBundleInstall.js';
import { tryAcquireStoreMutationLock } from '../stagedChange/storeMutationLock.js';
import {
  getStoreInstall,
  upsertStoreInstall,
  upsertStoreInstallArtifact,
  upsertStoreInstallClaim,
} from './storeInstallProvenance.js';
import {
  apiConnectorConsentPath,
  buildPlaceholderMcpAuth,
  connectorDefaultBindingId,
  connectorStatus,
  deriveMcpConnectorSetupState,
  installApiConnectorEntry,
  installMcpConnectorEntry,
  mcpConnectorConsentPath,
  publishApiConnectorInstallInvalidations,
  publishMcpConnectorInstallInvalidations,
  CONSENT_AUTH_KINDS,
} from './connectorInstall.js';
import {
  deriveApiConnectorSetupChecklist,
  deriveBundleProvenanceSkips,
  deriveInstallProvenance,
  isListingOnTenantShelf,
  provenanceArtifactKey,
  type StoreProvenancePlan,
  type StoreProvenanceSkips,
} from './storeDerivations.js';
import { dispatchAppletInstall } from './appletInstall.js';

// ============================================================================
// Result contract
// ============================================================================

export type StoreInstallFailureStatus = 400 | 404 | 409 | 422;

export type ExecuteStoreInstallResult =
  | { ok: true; response: StoreInstallResponse }
  | { ok: false; statusCode: StoreInstallFailureStatus; body: StoreInstallErrorBody };

class StoreInstallError extends Error {
  constructor(
    readonly statusCode: StoreInstallFailureStatus,
    readonly body: StoreInstallErrorBody,
  ) {
    super(body.error);
    this.name = 'StoreInstallError';
  }
}

/**
 * A per-kind backend reported the artifact already exists. `adoptable` means
 * the existing artifact is the listing's own (same identity, not archived), so
 * a fresh install can adopt it instead of failing.
 */
class StoreArtifactConflictError extends StoreInstallError {
  constructor(
    body: StoreInstallErrorBody,
    readonly adoptable: boolean,
  ) {
    super(409, body);
    this.name = 'StoreArtifactConflictError';
  }
}

export interface ExecuteStoreInstallParams {
  db: PostgresJsDatabase;
  redis: Redis | null;
  tenantId: TenantId;
  spaceId: string;
  actorUserId: string;
  catalogId: string;
  expectedVersion: number;
  idempotencyKey: string;
  /** Persists an artifact seed's source when it exceeds the inline payload cap. */
  payloadStore?: PayloadStore | undefined;
  /** Override for tests; defaults to the platform catalog registry. */
  entryResolver?: (catalogId: string) => CatalogEntry | null | undefined;
  /** The lanes this deployment composes; defaults to the process's own edition. */
  lanes?: ComposedLanes | undefined;
}

// ============================================================================
// Idempotency
// ============================================================================

const STORE_INSTALL_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
// The pending sentinel only guards the in-flight window — Node's default
// server requestTimeout (300s) bounds how long a request can still be running,
// so a crashed request never blocks retries for the full recorded-response TTL.
const STORE_INSTALL_IDEMPOTENCY_PENDING_TTL_SECONDS = 300;
const IDEMPOTENCY_PENDING = 'pending';

function storeInstallIdempotencyRedisKey(
  tenantId: string,
  spaceId: string,
  catalogId: string,
  idempotencyKey: string,
): string {
  return `aflow:idempotency:store_install:${tenantId}:${spaceId}:${catalogId}:${idempotencyKey}`;
}

// ============================================================================
// Per-kind dispatch types
// ============================================================================

export interface InstallDispatchOutcome {
  result: StoreInstallResult;
  setupChecklist: PostInstallTask[];
  invalidations: InstallInvalidations | null;
  /** Present when the backend reported skipped artifacts whose provenance must not be re-stamped. */
  provenanceSkips?: StoreProvenanceSkips;
}

type InstallInvalidations =
  | { kind: 'bundle'; bundle: SkillBundle; result: InstallSkillBundleResult }
  | { kind: 'api'; apiId: string }
  | { kind: 'mcp'; serverId: string; bindingId: string };

interface InstallTxOutcome {
  response: StoreInstallResponse;
  invalidations: InstallInvalidations | null;
}

function mapBundleResult(result: InstallSkillBundleResult): StoreInstallResult {
  return {
    kind: 'bundle',
    installedSkillCatalogIds: result.installedSkillCatalogIds,
    skippedSkillCatalogIds: [
      ...result.skippedSkillCatalogIds,
      ...result.repairedProjectionSkillCatalogIds,
    ],
    installedApiDefinitionIds: result.installedApiDefinitionIds,
    skippedApiDefinitionIds: result.skippedApiDefinitionIds,
    installedBindingIds: result.installedBindingIds,
    skippedBindingIds: result.skippedBindingIds,
    installedMcpDefinitionIds: result.installedMcpDefinitionIds,
    skippedMcpDefinitionIds: result.skippedMcpDefinitionIds,
    installedMcpBindingIds: result.installedMcpBindingIds,
    skippedMcpBindingIds: result.skippedMcpBindingIds,
    installedMemoryDocPaths: result.installedMemoryDocPaths,
    skippedMemoryDocPaths: result.skippedMemoryDocPaths,
    installedArtifactBindings: result.installedArtifactBindings,
    skippedArtifactBindings: result.skippedArtifactBindings,
    warnings: result.warnings,
  };
}

// ============================================================================
// Space gate
// ============================================================================

/** Skill and bundle installs require a cybernetic space (directives set). */
export async function isCyberneticSpaceById(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId);
  const [spaceRow] = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx.select({ directives: spaces.directives }).from(spaces).where(eq(spaces.id, spaceId)),
  );
  return Boolean(spaceRow?.directives);
}

// ============================================================================
// Per-kind install dispatch (runs inside the store transaction; backends
// nest their own tenant-schema transactions as savepoints on the same
// session, so the advisory lock and the final commit cover their writes).
// ============================================================================

async function dispatchBundleInstall(
  tx: PostgresJsDatabase,
  entry: CatalogBundleEntry,
  ids: { tenantId: TenantId; spaceId: string; payloadStore?: PayloadStore | undefined },
): Promise<InstallDispatchOutcome> {
  const result = await installSkillBundle(
    { tenantId: ids.tenantId, spaceId: ids.spaceId, db: tx, payloadStore: ids.payloadStore },
    entry.payload,
    {},
  );
  return {
    result: mapBundleResult(result),
    setupChecklist: result.postInstallManifest,
    invalidations: { kind: 'bundle', bundle: entry.payload, result },
    provenanceSkips: deriveBundleProvenanceSkips(entry.payload, result),
  };
}

async function dispatchConnectorInstall(
  tx: PostgresJsDatabase,
  entry: CatalogConnectorEntry,
  ids: { tenantId: TenantId; spaceId: string; payloadStore?: PayloadStore | undefined },
): Promise<InstallDispatchOutcome> {
  const context = {
    db: tx,
    redis: null,
    tenantId: ids.tenantId,
    spaceId: ids.spaceId as SpaceId,
  };
  if (entry.sourceKind === 'api') {
    const result = await installApiConnectorEntry({ entry: entry.payload, context });
    if (result.outcome === 'conflict') {
      throw new StoreArtifactConflictError(
        {
          error: result.error,
          code: 'ARTIFACT_CONFLICT',
          conflictingKey: result.conflictingApiId,
        },
        result.conflictingApiId === entry.payload.definition.apiId,
      );
    }
    if (result.outcome === 'invalid_entry' || result.outcome === 'oauth_client_unregistered') {
      throw new StoreInstallError(400, { error: result.error });
    }
    return {
      result: {
        kind: 'connector',
        sourceKind: 'api',
        integrationId: result.apiId,
        bindingId: result.bindingId,
        status: result.status,
        missingVariables: result.missingVariables,
        missingCredentialKeys: result.missingCredentialKeys,
        ...(result.consentPath !== undefined ? { consentPath: result.consentPath } : {}),
      },
      setupChecklist: deriveApiConnectorSetupChecklist(entry.payload, result.missingCredentialKeys),
      invalidations: { kind: 'api', apiId: result.apiId },
    };
  }
  const result = await installMcpConnectorEntry({ entry: entry.payload, context });
  if (result.outcome === 'conflict') {
    throw new StoreArtifactConflictError(
      {
        error: result.error,
        code: 'ARTIFACT_CONFLICT',
        conflictingKey: result.conflictingServerId,
      },
      result.conflictingServerId === entry.payload.definition.serverId,
    );
  }
  return {
    result: {
      kind: 'connector',
      sourceKind: 'mcp',
      integrationId: result.serverId,
      bindingId: result.bindingId,
      status: result.status,
      missingVariables: [],
      missingCredentialKeys: result.missingCredentialKeys,
      ...(result.consentPath !== undefined ? { consentPath: result.consentPath } : {}),
    },
    setupChecklist: result.setupChecklist,
    invalidations: { kind: 'mcp', serverId: result.serverId, bindingId: result.bindingId },
  };
}

async function dispatchInstall(
  tx: PostgresJsDatabase,
  entry: CatalogEntry,
  ids: { tenantId: TenantId; spaceId: string; payloadStore?: PayloadStore | undefined },
): Promise<InstallDispatchOutcome> {
  switch (entry.kind) {
    case 'bundle':
      return dispatchBundleInstall(tx, entry, ids);
    case 'connector':
      return dispatchConnectorInstall(tx, entry, ids);
    case 'applet':
      return dispatchAppletInstall(tx, entry, ids);
  }
}

// ============================================================================
// Same-version reinstall — a no-op that reports CURRENT state without
// re-running any write path (the connector backends would conflict, the
// skill path would reject the existing slug).
// ============================================================================

async function buildNoOpDispatch(
  tx: PostgresJsDatabase,
  entry: CatalogEntry,
  ids: { tenantId: TenantId; spaceId: string; payloadStore?: PayloadStore | undefined },
): Promise<InstallDispatchOutcome> {
  switch (entry.kind) {
    case 'bundle':
      // installSkillBundle is idempotent — a re-call skips complete skills,
      // repairs drifted projections, and regenerates the checklist.
      return dispatchBundleInstall(tx, entry, ids);
    case 'connector':
      return buildConnectorNoOpDispatch(tx, entry, ids.spaceId);
    case 'applet':
      // Idempotent like the bundle path — unchanged content short-circuits.
      return dispatchAppletInstall(tx, entry, ids);
  }
}

async function buildConnectorNoOpDispatch(
  tx: PostgresJsDatabase,
  entry: CatalogConnectorEntry,
  spaceId: string,
): Promise<InstallDispatchOutcome> {
  if (entry.sourceKind === 'api') {
    const payload = entry.payload;
    const apiId = payload.definition.apiId;
    const bindingId = connectorDefaultBindingId(apiId);
    const isOAuth = payload.authKind === 'oauth2_authorization_code';
    const bindingRows = await tx.execute<{ auth_json: Record<string, unknown> }>(sql`
      SELECT auth_json FROM api_bindings
      WHERE binding_id = ${bindingId} AND space_id = ${spaceId}::uuid
      LIMIT 1
    `);
    const authJson = bindingRows[0]?.auth_json;
    const credentialKeys = isOAuth ? [] : authJson ? extractCredentialKeys(authJson) : [];
    const present = await fetchPresentCredentialKeys(tx, spaceId, new Set(credentialKeys));
    const missing = credentialKeys.filter((key) => !present.has(key));
    return {
      result: {
        kind: 'connector',
        sourceKind: 'api',
        integrationId: apiId,
        bindingId,
        status: connectorStatus(isOAuth, missing),
        missingVariables: (payload.definition.variables ?? [])
          .filter((variable) => variable.required)
          .map((variable) => variable.name),
        missingCredentialKeys: missing,
        ...(isOAuth ? { consentPath: apiConnectorConsentPath(bindingId) } : {}),
      },
      setupChecklist: deriveApiConnectorSetupChecklist(payload, missing),
      invalidations: null,
    };
  }
  const payload = entry.payload;
  const serverId = payload.definition.serverId;
  const bindingId = connectorDefaultBindingId(serverId);
  const isConsent = CONSENT_AUTH_KINDS.has(payload.authKind);
  const { slots } = buildPlaceholderMcpAuth(payload.authKind, bindingId, payload.credentialPrompts);
  const setupState = await deriveMcpConnectorSetupState({
    tx,
    spaceId,
    bindingId,
    serverId,
    name: payload.definition.name,
    authKind: payload.authKind,
    slots,
  });
  return {
    result: {
      kind: 'connector',
      sourceKind: 'mcp',
      integrationId: serverId,
      bindingId,
      status: connectorStatus(isConsent, setupState.missingCredentialKeys),
      missingVariables: [],
      missingCredentialKeys: setupState.missingCredentialKeys,
      ...(isConsent ? { consentPath: mcpConnectorConsentPath(bindingId) } : {}),
    },
    setupChecklist: setupState.setupChecklist,
    invalidations: null,
  };
}

// ============================================================================
// The install transaction
// ============================================================================

async function runStoreInstall(
  tx: PostgresJsDatabase,
  entry: CatalogEntry,
  ids: {
    tenantId: TenantId;
    spaceId: string;
    actorUserId: string;
    payloadStore?: PayloadStore | undefined;
  },
  opts: { offShelf: boolean },
): Promise<InstallTxOutcome> {
  const acquired = await tryAcquireStoreMutationLock(tx, ids.spaceId);
  if (!acquired) {
    throw new StoreInstallError(409, {
      error: 'Another store mutation is in progress for this space. Retry shortly.',
      code: 'STORE_MUTATION_IN_PROGRESS',
    });
  }

  const now = new Date().toISOString();
  const existing = await getStoreInstall(tx, ids.spaceId, entry.catalogId);

  // Off-shelf listings do not exist for this tenant unless the space
  // already installed them (reinstall/update stays possible).
  if (opts.offShelf && !existing) {
    throw new StoreInstallError(404, {
      error: `Store listing '${entry.catalogId}' not found`,
    });
  }

  if (existing?.state === 'removing') {
    throw new StoreInstallError(409, {
      error: `'${entry.catalogId}' is being removed from this space. Retry after the removal completes.`,
      code: 'REMOVAL_IN_PROGRESS',
    });
  }

  if (existing?.installedVersion === entry.version) {
    const dispatch = await buildNoOpDispatch(tx, entry, ids);
    const plan = deriveInstallProvenance(entry, {
      spaceId: ids.spaceId,
      actorUserId: ids.actorUserId,
      now,
    });
    await writeProvenance(tx, plan, {
      entryRow: 'keep',
      ...(dispatch.provenanceSkips !== undefined ? { skips: dispatch.provenanceSkips } : {}),
    });
    return {
      response: {
        result: dispatch.result,
        setupChecklist: dispatch.setupChecklist,
        install: existing,
      },
      invalidations: dispatch.invalidations,
    };
  }

  if (existing) {
    throw new StoreInstallError(409, {
      error:
        `'${entry.catalogId}' is installed at version ${existing.installedVersion}; ` +
        `version ${entry.version} is an update, not a reinstall.`,
      code: 'ALREADY_INSTALLED',
      catalogId: entry.catalogId,
      currentVersion: existing.installedVersion,
      catalogVersion: entry.version,
    });
  }

  if (entry.status === 'deprecated') {
    throw new StoreInstallError(400, {
      error: `Listing '${entry.catalogId}' is deprecated and cannot be installed fresh.`,
    });
  }

  const plan = deriveInstallProvenance(entry, {
    spaceId: ids.spaceId,
    actorUserId: ids.actorUserId,
    now,
  });
  let dispatch: InstallDispatchOutcome;
  try {
    dispatch = await dispatchInstall(tx, entry, ids);
    await writeProvenance(tx, plan, {
      entryRow: 'replace',
      ...(dispatch.provenanceSkips !== undefined ? { skips: dispatch.provenanceSkips } : {}),
    });
  } catch (err) {
    if (!(err instanceof StoreArtifactConflictError) || !err.adoptable) throw err;
    // Pre-store artifact with no provenance row: adopt it — record the
    // current registry version as the installed baseline with keep-mode
    // upserts so nothing existing is overwritten. Content that has drifted
    // from the registry then simply reads as customized.
    dispatch = await buildNoOpDispatch(tx, entry, ids);
    await writeProvenance(tx, plan, {
      entryRow: 'keep',
      skips: {
        memberCatalogIds: new Set(plan.memberInstalls.map((member) => member.catalogId)),
        artifactKeys: new Set(plan.artifacts.map(provenanceArtifactKey)),
      },
    });
  }
  return {
    response: {
      result: dispatch.result,
      setupChecklist: dispatch.setupChecklist,
      install: plan.install,
    },
    invalidations: dispatch.invalidations,
  };
}

export async function writeProvenance(
  tx: PostgresJsDatabase,
  plan: StoreProvenancePlan,
  opts: { entryRow: 'replace' | 'keep'; skips?: StoreProvenanceSkips },
): Promise<void> {
  await upsertStoreInstall(tx, plan.install, { onConflict: opts.entryRow });
  for (const member of plan.memberInstalls) {
    const memberMode =
      opts.skips === undefined || opts.skips.memberCatalogIds.has(member.catalogId)
        ? 'keep'
        : 'replace';
    await upsertStoreInstall(tx, member, { onConflict: memberMode });
  }
  for (const artifact of plan.artifacts) {
    const artifactMode = opts.skips?.artifactKeys.has(provenanceArtifactKey(artifact))
      ? 'keep'
      : 'replace';
    await upsertStoreInstallArtifact(tx, artifact, { onConflict: artifactMode });
  }
  for (const claim of plan.claims) {
    await upsertStoreInstallClaim(tx, claim);
  }
}

function publishInvalidations(
  redis: Redis,
  tenantId: string,
  spaceId: string,
  invalidations: InstallInvalidations,
): void {
  switch (invalidations.kind) {
    case 'bundle':
      publishBundleInstallInvalidations(
        redis,
        tenantId,
        spaceId,
        invalidations.bundle,
        invalidations.result,
      );
      break;
    case 'api':
      publishApiConnectorInstallInvalidations(
        redis,
        tenantId as TenantId,
        spaceId as SpaceId,
        invalidations.apiId,
      );
      break;
    case 'mcp':
      publishMcpConnectorInstallInvalidations(
        redis,
        tenantId as TenantId,
        spaceId as SpaceId,
        invalidations.serverId,
        invalidations.bindingId,
      );
      break;
  }
}

// ============================================================================
// Entry point
// ============================================================================

export async function executeStoreInstall(
  params: ExecuteStoreInstallParams,
): Promise<ExecuteStoreInstallResult> {
  const {
    db,
    redis,
    tenantId,
    spaceId,
    actorUserId,
    catalogId,
    expectedVersion,
    idempotencyKey,
    payloadStore,
  } = params;
  const resolveEntry = params.entryResolver ?? getCatalogEntry;

  const entry = resolveEntry(catalogId) ?? null;
  if (!entry) {
    return {
      ok: false,
      statusCode: 404,
      body: { error: `Store listing '${catalogId}' not found` },
    };
  }

  // Every install path ends here — the route and an operator-ratified
  // proposal alike — so a listing whose lane this deployment does not compose
  // is refused once, before anything is written, in the words the operation
  // itself would use. The lane is a fact about the catalog, not the tenant,
  // so answering it discloses nothing the shelf check protects.
  const laneRefusal = uncomposedListingReason(entry, params.lanes ?? processEditionDescriptor());
  if (laneRefusal !== null) {
    return {
      ok: false,
      statusCode: 400,
      body: { error: laneRefusal, code: 'LANE_NOT_COMPOSED', catalogId: entry.catalogId },
    };
  }

  const tenantCtx = createTenantContext(tenantId);
  const shelf = await getTenantStoreShelfPolicy(db, tenantId);
  const offShelf = !isListingOnTenantShelf(entry, new Set(), shelf);
  // An off-shelf listing the space never installed must fail exactly like an
  // unknown id — any later check (version, space) would disclose its existence.
  if (offShelf) {
    const existing = await withTenantSchema(db, tenantCtx, async (tx) =>
      getStoreInstall(tx, spaceId, entry.catalogId),
    );
    if (!existing) {
      return {
        ok: false,
        statusCode: 404,
        body: { error: `Store listing '${catalogId}' not found` },
      };
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
  if (entry.kind === 'bundle' && !(await isCyberneticSpaceById(db, tenantId, spaceId))) {
    return {
      ok: false,
      statusCode: 400,
      body: { error: 'Space is not cybernetic (no directives set)' },
    };
  }

  const idempotencyRedisKey = storeInstallIdempotencyRedisKey(
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
      STORE_INSTALL_IDEMPOTENCY_PENDING_TTL_SECONDS,
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

  let outcome: InstallTxOutcome;
  try {
    outcome = await withTenantSchema(db, tenantCtx, async (tx) =>
      runStoreInstall(tx, entry, { tenantId, spaceId, actorUserId, payloadStore }, { offShelf }),
    );
  } catch (err) {
    if (redis) await redis.del(idempotencyRedisKey);
    if (err instanceof StoreInstallError) {
      return { ok: false, statusCode: err.statusCode, body: err.body };
    }
    if (err instanceof BundleInstallInProgressError) {
      return {
        ok: false,
        statusCode: 409,
        body: { error: err.message, code: err.code, bundleId: err.bundleId },
      };
    }
    if (err instanceof BundlePartiallyInstalledError) {
      return {
        ok: false,
        statusCode: 409,
        body: {
          error: err.message,
          code: err.code,
          bundleId: err.bundleId,
          skillCatalogId: err.skillCatalogId,
          presentArtifacts: [...err.presentArtifacts],
          missingArtifacts: [...err.missingArtifacts],
        },
      };
    }
    if (err instanceof BundleInstallValidationError) {
      return {
        ok: false,
        statusCode: 422,
        body: {
          error: err.message,
          code: err.code,
          bundleId: err.bundleId,
          errors: [...err.errors],
        },
      };
    }
    throw err;
  }

  if (redis && outcome.invalidations) {
    publishInvalidations(redis, tenantId, spaceId, outcome.invalidations);
  }
  if (redis) {
    await redis.set(
      idempotencyRedisKey,
      JSON.stringify(outcome.response),
      'EX',
      STORE_INSTALL_IDEMPOTENCY_TTL_SECONDS,
    );
  }
  return { ok: true, response: outcome.response };
}
