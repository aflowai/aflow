import {
  IntegrationRegistryLookupInputSchema,
  type IntegrationRegistryLookupOutput,
  type TenantId,
} from '@aflow/schemas';
import {
  createTenantContext,
  getDatabase,
  getTenantStoreShelfPolicy,
  withTenantSchema,
} from '@aflow/database';
import { listCatalog } from '@aflow/platform-artifacts';
import {
  deriveInstalledState,
  listStoreInstalls,
  searchListableEntries,
  toStoreListingInstalledState,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError, readInlineOpInput } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { readIntegrations } from '../../helpers/integrationReader.js';
import { buildIntegrationScopeFilter } from '../../helpers/integrationScope.js';
import { loadDiscoveryScope } from './discoveryScopeReader.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';

function matchesIdentifier(needle: string, ...haystack: Array<string | undefined>): boolean {
  const n = needle.toLowerCase();
  return haystack.some((h) => typeof h === 'string' && h.toLowerCase().includes(n));
}

const MAX_CATALOG_CANDIDATES = 3;

type CatalogCandidates = NonNullable<IntegrationRegistryLookupOutput['catalogCandidates']>;

async function findCatalogCandidates(
  tenantId: TenantId,
  spaceId: string,
  identifier: string,
): Promise<CatalogCandidates> {
  const db = getDatabase();
  const tenantCtx = createTenantContext(tenantId);
  const [installs, shelf] = await Promise.all([
    withTenantSchema(db, tenantCtx, async (tx) => listStoreInstalls(tx, spaceId)),
    getTenantStoreShelfPolicy(db, tenantId),
  ]);
  const installByCatalogId = new Map(installs.map((install) => [install.catalogId, install]));
  const entries = searchListableEntries(
    listCatalog(),
    new Set(installByCatalogId.keys()),
    shelf,
    identifier,
    { maxResults: MAX_CATALOG_CANDIDATES },
  );
  return entries.map((entry) => ({
    catalogId: entry.catalogId,
    name: entry.name,
    kind: entry.kind,
    version: entry.version,
    installedState: toStoreListingInstalledState(
      deriveInstalledState(entry, installByCatalogId.get(entry.catalogId) ?? null),
    ),
  }));
}

export async function handleIntegrationRegistryLookupInline(
  args: InlineHandlerArgs,
): Promise<void> {
  const startTime = Date.now();
  const logger = getOrchestratorLogger();

  try {
    const spaceId = requireSpaceId(args.context);
    const tenantId = args.context.tenantId;

    const opInput = await readInlineOpInput(args);
    const inputParse = IntegrationRegistryLookupInputSchema.safeParse(opInput);
    if (!inputParse.success) {
      await emitStepError(
        args,
        'INTEGRATION_REGISTRY_LOOKUP_INVALID_INPUT',
        `Invalid input for integration.registry.lookup: ${inputParse.error.message}`,
        startTime,
        'validation',
      );
      return;
    }
    const { identifier } = inputParse.data;

    const discoveryScope = await loadDiscoveryScope(args.redis, args.context);
    const scopeFilter = buildIntegrationScopeFilter(discoveryScope, true, true);
    const { descriptors } = await readIntegrations(tenantId, spaceId, {
      ...scopeFilter,
      includeDefinitionOnly: true,
    });

    const matches: IntegrationRegistryLookupOutput['matches'] = [];
    for (const d of descriptors) {
      if (!matchesIdentifier(identifier, d.integrationId, d.bindingId, d.name)) {
        continue;
      }
      const match: IntegrationRegistryLookupOutput['matches'][number] = {
        sourceKind: d.sourceKind,
        status: d.status,
        identifier: d.integrationId,
        ...(d.sourceKind === 'api' ? { apiId: d.integrationId } : { serverId: d.integrationId }),
        ...(d.bindingId ? { bindingId: d.bindingId } : {}),
        ...(d.name ? { definitionName: d.name } : {}),
        ...(d.credentialStatus ? { credentialStatus: d.credentialStatus } : {}),
        toolCount: d.toolCount,
      };
      matches.push(match);
    }

    // Roll-up status: bound > needs_credentials > disabled > definition-only
    // > unknown. Order encodes operator-action priority: a 'disabled' rollup
    // tells the operator to re-enable the existing binding, NOT register a
    // new one (which is what 'definition-only' implies). Reviewer P2 —
    // previously this fell through 'disabled' matches to 'definition-only',
    // misdirecting callers. Helmsman should always branch on
    // `matches[*].status` when the user named a specific vendor.
    let status: IntegrationRegistryLookupOutput['status'];
    if (matches.length === 0) {
      status = 'unknown';
    } else if (matches.some((m) => m.status === 'bound')) {
      status = 'bound';
    } else if (matches.some((m) => m.status === 'needs_credentials')) {
      status = 'needs_credentials';
    } else if (matches.some((m) => m.status === 'disabled')) {
      status = 'disabled';
    } else {
      status = 'definition-only';
    }

    const output: IntegrationRegistryLookupOutput = { status, matches };
    // Only when the vendor has no binding at all — needs_credentials/disabled
    // vendors are fixed on the existing binding, not by installing a listing.
    if (status === 'unknown' || status === 'definition-only') {
      const catalogCandidates = await findCatalogCandidates(tenantId, spaceId, identifier);
      if (catalogCandidates.length > 0) output.catalogCandidates = catalogCandidates;
    }

    logger.info(
      `[integration.registry.lookup] identifier="${identifier}" status=${status} matches=${matches.length.toString()}`,
    );

    await emitStepSuccess(args, output, startTime);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emitStepError(
      args,
      'INTEGRATION_REGISTRY_LOOKUP_FAILED',
      `integration.registry.lookup failed: ${message}`,
      startTime,
      'internal',
    );
  }
}
