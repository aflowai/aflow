import {
  IntegrationRegistryListInputSchema,
  type IntegrationRegistryListOutput,
} from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError, readInlineOpInput } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { readIntegrations } from '../../helpers/integrationReader.js';
import { buildIntegrationScopeFilter } from '../../helpers/integrationScope.js';
import { loadDiscoveryScope } from './discoveryScopeReader.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';

export async function handleIntegrationRegistryListInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const logger = getOrchestratorLogger();

  try {
    const spaceId = requireSpaceId(args.context);
    const tenantId = args.context.tenantId;

    const opInput = await readInlineOpInput(args);
    const parse = IntegrationRegistryListInputSchema.safeParse(opInput ?? {});
    if (!parse.success) {
      await emitStepError(
        args,
        'INTEGRATION_REGISTRY_LIST_INVALID_INPUT',
        `Invalid input for integration.registry.list: ${parse.error.message}`,
        startTime,
        'validation',
      );
      return;
    }
    const { sourceKinds, includeDefinitionOnly } = parse.data;

    const discoveryScope = await loadDiscoveryScope(args.redis, args.context);
    const requestedApi = sourceKinds ? sourceKinds.includes('api') : true;
    const requestedMcp = sourceKinds ? sourceKinds.includes('mcp') : true;
    const filter: Parameters<typeof readIntegrations>[2] = buildIntegrationScopeFilter(
      discoveryScope,
      requestedApi,
      requestedMcp,
    );
    if (includeDefinitionOnly === true) filter.includeDefinitionOnly = true;

    const { descriptors, definitionOnlyCount } = await readIntegrations(tenantId, spaceId, filter);

    const output: IntegrationRegistryListOutput = {
      items: descriptors.map((d) => ({
        sourceKind: d.sourceKind,
        integrationId: d.integrationId,
        ...(d.bindingId ? { bindingId: d.bindingId } : {}),
        name: d.name,
        ...(d.description ? { description: d.description } : {}),
        status: d.status,
        toolCount: d.toolCount,
        ...(d.credentialStatus ? { credentialStatus: d.credentialStatus } : {}),
      })),
      total: descriptors.length,
      definitionOnlyCount,
    };

    logger.info(
      `[integration.registry.list] items=${String(output.items.length)} defOnly=${String(definitionOnlyCount)}`,
    );

    await emitStepSuccess(args, output, startTime);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emitStepError(
      args,
      'INTEGRATION_REGISTRY_LIST_FAILED',
      `integration.registry.list failed: ${message}`,
      startTime,
      'internal',
    );
  }
}
