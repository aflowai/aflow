/**
 * Inline handlers for store.listing.* — the agent's discovery-and-propose
 * surface over the platform catalog. Search/get read through the same shelf
 * composition and derivations the Store's HTTP routes use; install only ever
 * emits a `store_install` StagedChange for operator ratification (ratification
 * runs the shared install execution — no direct install path exists here).
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
  type CatalogEntry,
  type StoreInstall,
} from '@aflow/schemas';
import { getCatalogEntry, listCatalog } from '@aflow/platform-artifacts';
import {
  deriveInstalledState,
  deriveListingRequirements,
  getStoreInstall,
  isListingOnTenantShelf,
  listStoreInstalls,
  proposalDirForRoute,
  resolveProposalRoute,
  searchListableEntries,
  selectListableEntries,
  toStoreListingInstalledState,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError, readInlineOpInput } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
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
          'Propose installs only for listings store.listing.get reports as not_installed; updates are applied by the operator from the Store.',
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
          'Re-read it with store.listing.get and re-propose with the current version.',
        startTime,
        'validation',
      );
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
