/**
 * Inline handlers for store.listing.* — the agent's discovery, install and
 * update surface over the platform catalog. Search/get read through the same
 * shelf composition and derivations the Store's HTTP routes use. Install and
 * update run the shared executions the Store's routes run (Plan 345 B). Under
 * the space's autonomy `ratify`, install emits a `store_install` StagedChange
 * for operator ratification instead.
 */
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  getDatabase,
  createTenantContext,
  createMemoryDocRepository,
  createMemoryDirRepository,
  getTenantStoreShelfPolicy,
  withTenantSchema,
} from '@aflow/database';
import {
  StagedChangeSchema,
  StoreListingGetInputSchema,
  StoreListingGetOutputSchema,
  StoreListingInstallInputSchema,
  StoreListingInstallOutputSchema,
  StoreListingSearchInputSchema,
  StoreListingSearchOutputSchema,
  StoreListingUpdateInputSchema,
  StoreListingUpdateOutputSchema,
  type CatalogEntry,
  type StoreInstall,
} from '@aflow/schemas';
import { getCatalogEntry, listCatalog } from '@aflow/platform-artifacts';
import {
  deriveInstalledState,
  deriveListingRequirements,
  executeStoreInstall,
  executeStoreUpdate,
  getStoreInstall,
  isListingOnTenantShelf,
  listStoreInstalls,
  proposalDirForRoute,
  readSpaceAutonomyPolicy,
  readSpaceOwnerUserId,
  resolveProposalRoute,
  searchListableEntries,
  selectListableEntries,
  skillsToReconcile,
  toStoreListingInstalledState,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError, readInlineOpInput } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { sessionUser } from './sessionUser.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';

const PROPOSAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function parseInput<Output>(
  args: InlineHandlerArgs,
  schema: z.ZodType<Output, z.ZodTypeDef, unknown>,
  errorCode: string,
  startTime: number,
): Promise<Output | null> {
  const parsed = schema.safeParse(await readInlineOpInput(args));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    await emitStepError(
      args,
      errorCode,
      `Invalid input for ${args.stepDef.operation}: ${issues}`,
      startTime,
      'validation',
    );
    return null;
  }
  return parsed.data;
}

async function emitListingNotFound(
  args: InlineHandlerArgs,
  catalogId: string,
  startTime: number,
): Promise<void> {
  await emitStepError(
    args,
    'STORE_LISTING_NOT_FOUND',
    `Store listing '${catalogId}' not found. Discover installable listings with store.listing.search.`,
    startTime,
    'validation',
  );
}

function listingSummary(entry: CatalogEntry, install: StoreInstall | null) {
  return {
    ...entry,
    installedState: toStoreListingInstalledState(deriveInstalledState(entry, install)),
    requirements: deriveListingRequirements(entry),
  };
}

// ============================================================================
// store.listing.search
// ============================================================================

export async function handleStoreListingSearchInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const logger = getOrchestratorLogger();

  try {
    const spaceId = requireSpaceId(args.context);
    const tenantId = args.context.tenantId;
    const input = await parseInput(
      args,
      StoreListingSearchInputSchema,
      'STORE_LISTING_SEARCH_INVALID_INPUT',
      startTime,
    );
    if (!input) return;

    const db = getDatabase();
    const tenantCtx = createTenantContext(tenantId);
    const [installs, shelf] = await Promise.all([
      withTenantSchema(db, tenantCtx, async (tx) => listStoreInstalls(tx, spaceId)),
      getTenantStoreShelfPolicy(db, tenantId),
    ]);
    const installByCatalogId = new Map(installs.map((install) => [install.catalogId, install]));
    const installedCatalogIds = new Set(installByCatalogId.keys());

    const base = listCatalog(input.kind !== undefined ? { kind: input.kind } : undefined);
    const entries = input.query
      ? searchListableEntries(base, installedCatalogIds, shelf, input.query, {
          maxResults: input.maxResults,
        })
      : selectListableEntries(base, installedCatalogIds, shelf).slice(0, input.maxResults);

    const output = StoreListingSearchOutputSchema.parse({
      listings: entries.map((entry) =>
        listingSummary(entry, installByCatalogId.get(entry.catalogId) ?? null),
      ),
    });

    logger.info(
      `[store.listing.search] query="${input.query ?? ''}" kind=${input.kind ?? 'any'} results=${String(output.listings.length)}`,
    );
    await emitStepSuccess(args, output, startTime);
  } catch (err) {
    logger.error(
      `[store.listing.search] Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    await emitStepError(
      args,
      'STORE_LISTING_SEARCH_FAILED',
      err instanceof Error ? err.message : String(err),
      startTime,
      'internal',
    );
  }
}

// ============================================================================
// store.listing.get
// ============================================================================

export async function handleStoreListingGetInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const logger = getOrchestratorLogger();

  try {
    const spaceId = requireSpaceId(args.context);
    const tenantId = args.context.tenantId;
    const input = await parseInput(
      args,
      StoreListingGetInputSchema,
      'STORE_LISTING_GET_INVALID_INPUT',
      startTime,
    );
    if (!input) return;

    const entry = getCatalogEntry(input.catalogId);
    if (!entry) {
      await emitListingNotFound(args, input.catalogId, startTime);
      return;
    }

    const db = getDatabase();
    const tenantCtx = createTenantContext(tenantId);
    const [install, shelf] = await Promise.all([
      withTenantSchema(db, tenantCtx, async (tx) => getStoreInstall(tx, spaceId, entry.catalogId)),
      getTenantStoreShelfPolicy(db, tenantId),
    ]);
    if (!isListingOnTenantShelf(entry, new Set(install ? [entry.catalogId] : []), shelf)) {
      await emitListingNotFound(args, input.catalogId, startTime);
      return;
    }

    const output = StoreListingGetOutputSchema.parse({
      listing: entry,
      installedState: toStoreListingInstalledState(deriveInstalledState(entry, install)),
      requirements: deriveListingRequirements(entry),
    });
    await emitStepSuccess(args, output, startTime);
  } catch (err) {
    logger.error(
      `[store.listing.get] Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    await emitStepError(
      args,
      'STORE_LISTING_GET_FAILED',
      err instanceof Error ? err.message : String(err),
      startTime,
      'internal',
    );
  }
}

// ============================================================================
// store.listing.install
// ============================================================================

export async function handleStoreListingInstallInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const logger = getOrchestratorLogger();

  try {
    const spaceId = requireSpaceId(args.context);
    const tenantId = args.context.tenantId;
    const input = await parseInput(
      args,
      StoreListingInstallInputSchema,
      'STORE_LISTING_INSTALL_INVALID_INPUT',
      startTime,
    );
    if (!input) return;

    const entry = getCatalogEntry(input.catalogId);
    if (!entry) {
      await emitListingNotFound(args, input.catalogId, startTime);
      return;
    }

    const db = getDatabase();
    const tenantCtx = createTenantContext(tenantId);
    const [install, shelf] = await Promise.all([
      withTenantSchema(db, tenantCtx, async (tx) => getStoreInstall(tx, spaceId, entry.catalogId)),
      getTenantStoreShelfPolicy(db, tenantId),
    ]);
    if (!isListingOnTenantShelf(entry, new Set(install ? [entry.catalogId] : []), shelf)) {
      await emitListingNotFound(args, input.catalogId, startTime);
      return;
    }
    if (install) {
      await emitStepError(
        args,
        'STORE_LISTING_ALREADY_INSTALLED',
        `'${entry.catalogId}' is already installed in this space (version ${String(install.installedVersion)}). ` +
          'Install only a listing store.listing.get reports as not_installed. Apply an available update with store.listing.update.',
        startTime,
        'validation',
      );
      return;
    }
    if (entry.status === 'deprecated') {
      await emitStepError(
        args,
        'STORE_LISTING_NOT_INSTALLABLE',
        `Listing '${entry.catalogId}' is deprecated and cannot be newly installed. Search the store for a current alternative.`,
        startTime,
        'validation',
      );
      return;
    }
    if (entry.version !== input.expectedVersion) {
      await emitStepError(
        args,
        'STORE_LISTING_VERSION_CHANGED',
        `Listing '${entry.catalogId}' is at version ${String(entry.version)}, not ${String(input.expectedVersion)}. ` +
          'Re-read it with store.listing.get and install it at the current version.',
        startTime,
        'validation',
      );
      return;
    }

    const { autonomy } = await readSpaceAutonomyPolicy(db, tenantId, spaceId);
    if (autonomy === 'full') {
      await installNow(args, entry, spaceId, startTime);
      return;
    }

    const proposalId = randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MS).toISOString();
    const ops = [
      {
        op: 'store_install' as const,
        catalogId: entry.catalogId,
        expectedVersion: entry.version,
        listing: {
          name: entry.name,
          kind: entry.kind,
          tagline: entry.tagline,
          requirements: deriveListingRequirements(entry),
        },
      },
    ];
    const route = resolveProposalRoute({ ops });
    const stagedChange = StagedChangeSchema.parse({
      id: proposalId,
      kind: 'store_install',
      source: 'bind_capability',
      status: 'proposed',
      proposal: {
        summary: `Install from Store: ${entry.name}`,
        rationale: `${entry.tagline} Installs catalog listing '${entry.catalogId}' v${String(entry.version)} (${entry.kind}).`,
        confidence: 'high',
        ops,
      },
      evidence: {
        sourceSessionIds: [args.context.runId],
      },
      authorityLevel: 'require_operator',
      resolutionRoute: route,
      proposedAt: now,
      expiresAt,
      coachSessionId: args.context.runId,
    });

    const docRepo = createMemoryDocRepository(db, tenantCtx);
    const dirRepo = createMemoryDirRepository(db, tenantCtx);
    const path = `${proposalDirForRoute(route)}/${proposalId}.json`;
    await dirRepo.ensureParentDirs(path, { spaceId });

    const content = JSON.stringify(stagedChange, null, 2);
    await docRepo.put({
      path,
      writeMode: 'create',
      docType: 'json',
      mimeType: 'application/json',
      inlineContent: content,
      payloadRef: null,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      contentHash: '',
      preview: content.substring(0, 200),
      tags: ['coach', 'staged', 'store_install'],
      summary: `Install from Store: ${entry.name}`,
      semanticType: 'staged_change',
      indexing: 'disabled',
      scope: { spaceId },
      provenance: { actor: 'system:store-listing' },
    });

    logger.info(
      `[store.listing.install] Proposed install of '${entry.catalogId}' v${String(entry.version)} (proposal=${proposalId})`,
    );

    try {
      const { appendEntityEvent } = await import('@aflow/redis');
      await appendEntityEvent(args.redis, {
        tenantId,
        spaceId,
        event: {
          eventId: randomUUID(),
          eventType: 'entity.coach.proposal',
          spaceId,
          tenantId,
          timestamp: Date.now(),
          causedBySessionId: args.context.runId,
          causedByStepExecutionId: args.stepExecutionId,
          payload: {
            stagedChangeId: proposalId,
            kind: 'store_install',
            catalogId: entry.catalogId,
          },
          summary: `Store install of "${entry.name}" proposed for review`,
        },
      });
    } catch {
      // Best-effort event emission
    }

    const output = StoreListingInstallOutputSchema.parse({
      proposalId,
      catalogId: entry.catalogId,
      status: 'proposed',
    });
    await emitStepSuccess(args, output, startTime);
  } catch (err) {
    logger.error(
      `[store.listing.install] Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    await emitStepError(
      args,
      'STORE_LISTING_INSTALL_FAILED',
      err instanceof Error ? err.message : String(err),
      startTime,
      'internal',
    );
  }
}

/**
 * Who an agent's install or update is recorded under: the user who started
 * the session, else the space's owner. Null where neither is known.
 */
async function actingUser(args: InlineHandlerArgs, spaceId: string): Promise<string | null> {
  return (
    (await sessionUser(args)) ??
    (await readSpaceOwnerUserId(getDatabase(), args.context.tenantId, spaceId))
  );
}

async function emitNoActingUser(args: InlineHandlerArgs, startTime: number): Promise<void> {
  await emitStepError(
    args,
    'STORE_LISTING_NO_ACTOR',
    'Neither the session nor the space names a user to record this change under, so nothing was changed.',
    startTime,
    'internal',
  );
}

/** Under autonomy `full`: the install the Store page runs, on the agent's word. */
async function installNow(
  args: InlineHandlerArgs,
  entry: CatalogEntry,
  spaceId: string,
  startTime: number,
): Promise<void> {
  const actorUserId = await actingUser(args, spaceId);
  if (actorUserId === null) {
    await emitNoActingUser(args, startTime);
    return;
  }
  const result = await executeStoreInstall({
    db: getDatabase(),
    redis: args.redis,
    tenantId: args.context.tenantId,
    spaceId,
    actorUserId,
    catalogId: entry.catalogId,
    expectedVersion: entry.version,
    idempotencyKey: args.idempotencyKey,
    payloadStore: args.payloadStore,
  });
  if (!result.ok) {
    await emitStepError(
      args,
      result.body.code ?? 'STORE_LISTING_INSTALL_REFUSED',
      `The install of '${entry.catalogId}' was refused: ${result.body.error}`,
      startTime,
      result.statusCode === 409 ? 'conflict' : 'validation',
    );
    return;
  }
  getOrchestratorLogger().info(
    `[store.listing.install] Installed '${entry.catalogId}' v${String(entry.version)} in space ${spaceId}`,
  );
  const output = StoreListingInstallOutputSchema.parse({
    status: 'installed',
    catalogId: entry.catalogId,
    installedVersion: entry.version,
    setupChecklist: result.response.setupChecklist,
  });
  await emitStepSuccess(args, output, startTime);
}

// ============================================================================
// store.listing.update
// ============================================================================

export async function handleStoreListingUpdateInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const logger = getOrchestratorLogger();

  try {
    const spaceId = requireSpaceId(args.context);
    const input = await parseInput(
      args,
      StoreListingUpdateInputSchema,
      'STORE_LISTING_UPDATE_INVALID_INPUT',
      startTime,
    );
    if (!input) return;

    // Under `ratify` an update is the operator's act, as it was before Plan 345:
    // the agent applies none, so no customization is discarded unasked.
    const { autonomy } = await readSpaceAutonomyPolicy(
      getDatabase(),
      args.context.tenantId,
      spaceId,
    );
    if (autonomy !== 'full') {
      await emitStepError(
        args,
        'STORE_LISTING_UPDATE_NEEDS_OPERATOR',
        `The space's autonomy is \`${autonomy}\`, so an update of '${input.catalogId}' is the operator's. ` +
          'Tell them the update is available: they apply it from the Store page.',
        startTime,
        'permission',
      );
      return;
    }

    const actorUserId = await actingUser(args, spaceId);
    if (actorUserId === null) {
      await emitNoActingUser(args, startTime);
      return;
    }
    const result = await executeStoreUpdate({
      db: getDatabase(),
      redis: args.redis,
      tenantId: args.context.tenantId,
      spaceId,
      actorUserId,
      catalogId: input.catalogId,
      expectedVersion: input.expectedVersion,
      idempotencyKey: args.idempotencyKey,
      mode: input.mode,
      payloadStore: args.payloadStore,
    });
    if (!result.ok) {
      if (result.statusCode === 404) {
        await emitListingNotFound(args, input.catalogId, startTime);
        return;
      }
      const remedy =
        result.body.code === 'STORE_CUSTOMIZED'
          ? ' The space changed an artifact this update replaces: update with mode `replace_customized` to discard those changes, or `keep` to skip this version.'
          : result.body.code === 'CATALOG_CHANGED'
            ? ' Re-read the listing with store.listing.get and update to its current version.'
            : '';
      await emitStepError(
        args,
        result.body.code ?? 'STORE_LISTING_UPDATE_REFUSED',
        `The update of '${input.catalogId}' was refused: ${result.body.error}${remedy}`,
        startTime,
        result.statusCode === 409 ? 'conflict' : 'validation',
      );
      return;
    }

    const response = result.response;
    logger.info(
      `[store.listing.update] '${response.catalogId}' v${String(response.fromVersion)} → v${String(response.toVersion)} (${response.mode}) in space ${spaceId}`,
    );
    const output = StoreListingUpdateOutputSchema.parse({
      catalogId: response.catalogId,
      mode: response.mode,
      fromVersion: response.fromVersion,
      toVersion: response.toVersion,
      updatedArtifacts: response.updatedArtifacts,
      reconcile: skillsToReconcile(response),
      credentialsReset: response.credentialsReset,
      setupChecklist: response.setupChecklist,
    });
    await emitStepSuccess(args, output, startTime);
  } catch (err) {
    logger.error(
      `[store.listing.update] Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    await emitStepError(
      args,
      'STORE_LISTING_UPDATE_FAILED',
      err instanceof Error ? err.message : String(err),
      startTime,
      'internal',
    );
  }
}
