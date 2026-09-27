import type { Redis } from 'ioredis';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';
import type {
  StepExecutionId,
  OperationId,
  StepDefinition,
  TenantId,
  IdempotencyKey,
} from '@aflow/schemas';
import { addStepResult } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import { encodeInlineOpOutputRef } from './helpers.js';
import {
  getDatabase,
  withTenantSchema,
  createTenantContext,
  apiDefinitions,
  apiBindings,
  apiCredentials,
} from '@aflow/database';
import { eq } from 'drizzle-orm';
import type { FlowExecutionContext } from '../../types.js';
import { extractCredentialKeys } from '@aflow/schemas';
import { requireSpaceId } from './spaceScope.js';

interface DiscoveryDefinition {
  apiId: string;
  name: string;
  description?: string;
  version: string;
  enabled: boolean;
  /** Whether this API is fully connected and ready to call. */
  status: 'ready' | 'needs_setup';
  /** 'direct_url' bindings have no endpoints; call via api.http.call direct-URL mode. */
  callMode: 'endpoint' | 'direct_url';
  endpoints: Array<{
    endpointId: string;
    name: string;
    description?: string;
    method: string;
    pathTemplate: string;
    params: Array<{
      name: string;
      location: string;
      required: boolean;
      description?: string;
    }>;
    tags: string[];
  }>;
  tags: string[];
}

export async function loadApiDefinitionsFromDb(
  tenantId: TenantId,
  opts: { includeUnbound?: boolean; spaceId: string },
): Promise<DiscoveryDefinition[]> {
  try {
    const db = getDatabase();
    const tenantCtx = createTenantContext(tenantId);

    const { rows, bindingsByApiId, credentialKeys } = await withTenantSchema(
      db,
      tenantCtx,
      async (tx) => {
        const defRows = await tx
          .select()
          .from(apiDefinitions)
          .where(eq(apiDefinitions.spaceId, opts.spaceId));
        const bindingRows = await tx
          .select()
          .from(apiBindings)
          .where(eq(apiBindings.spaceId, opts.spaceId));
        let credKeys = new Set<string>();
        try {
          const credRows = await tx
            .select({ credentialKey: apiCredentials.credentialKey })
            .from(apiCredentials);
          credKeys = new Set(credRows.map((c) => c.credentialKey));
        } catch {
          // credentials table may not exist yet
        }
        const byApiId = new Map<string, Array<(typeof bindingRows)[number]>>();
        for (const b of bindingRows) {
          const list = byApiId.get(b.apiId) ?? [];
          list.push(b);
          byApiId.set(b.apiId, list);
        }
        return { rows: defRows, bindingsByApiId: byApiId, credentialKeys: credKeys };
      },
    );

    const includeUnbound = opts.includeUnbound === true;

    return rows
      .filter((r) => includeUnbound || bindingsByApiId.has(r.apiId))
      .map((r) => {
        const def = r.definitionJson as Record<string, unknown>;
        const endpoints = (def['endpoints'] ?? []) as DiscoveryDefinition['endpoints'];
        const callMode = def['callMode'] === 'direct_url' ? 'direct_url' : 'endpoint';

        // Determine readiness: binding must exist, auth must have credential keys, and all keys must be stored.
        const apiBindingList = bindingsByApiId.get(r.apiId) ?? [];
        let ready = apiBindingList.length > 0;
        for (const b of apiBindingList) {
          const authJson = b.authJson as Record<string, unknown>;
          const authType = authJson['type'] as string;
          if (authType && authType !== 'none') {
            const keys = extractCredentialKeys(authJson);
            if (keys.length === 0) {
              ready = false;
            } else {
              for (const k of keys) {
                if (!credentialKeys.has(k)) ready = false;
              }
            }
          }
        }

        return {
          apiId: r.apiId,
          name: r.name,
          ...(r.description ? { description: r.description } : {}),
          version: r.version,
          enabled: r.enabled === 1,
          status: ready ? ('ready' as const) : ('needs_setup' as const),
          callMode,
          endpoints,
          tags: (r.tags as string[] | undefined) ?? [],
        };
      });
  } catch (err) {
    console.warn(
      `[inlineOps] Failed to load API definitions from DB for tenant ${tenantId}, returning empty list:`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/**
 * Handle platform.list_api_definitions inline: query the tenant's API
 * definitions from the database and return a secrets-free summary for the agent.
 * Only APIs that have at least one binding are returned (no orphan definitions).
 */
export async function handleListApiDefinitionsInline(
  redis: Redis,
  payloadStore: PayloadStore,
  context: FlowExecutionContext,
  stepDef: StepDefinition,
  stepExecutionId: StepExecutionId,
  idempotencyKey: IdempotencyKey,
  resolvedInputRef: string,
  attempt: number,
  _scheduledAtMs: number,
  parentStepExecutionId?: StepExecutionId,
): Promise<void> {
  const startTime = Date.now();
  try {
    let input: Record<string, unknown> = {};
    try {
      const data = await payloadStore.retrieve(resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      /* empty input — return all definitions */
    }

    const filterApiIds = input['apiIds'] as string[] | undefined;
    const filterTags = input['tags'] as string[] | undefined;
    const enabledOnly = input['enabledOnly'] !== false;
    const includeUnbound = input['includeUnbound'] === true;

    // Load definitions from the tenant's DB
    const allDefinitions = await loadApiDefinitionsFromDb(context.tenantId, {
      includeUnbound,
      spaceId: requireSpaceId(context),
    });

    // Apply filters
    let filtered = allDefinitions;

    if (enabledOnly) {
      filtered = filtered.filter((d) => d.enabled);
    }
    if (filterApiIds && filterApiIds.length > 0) {
      const apiIdSet = new Set(filterApiIds);
      filtered = filtered.filter((d) => apiIdSet.has(d.apiId));
    }
    if (filterTags && filterTags.length > 0) {
      filtered = filtered.filter((d) => filterTags.some((t) => d.tags.includes(t)));
    }

    // Build agent-friendly output (no secrets, no auth details)
    const apis = filtered.map((d) => ({
      apiId: d.apiId,
      name: d.name,
      ...(d.description ? { description: d.description } : {}),
      version: d.version,
      ...(d.callMode === 'direct_url' ? { callMode: 'direct_url' } : {}),
      endpoints: d.endpoints,
      tags: d.tags,
    }));

    const outputData = {
      apis,
      count: apis.length,
    };

    const outputRef = await encodeInlineOpOutputRef(
      payloadStore,
      context,
      stepExecutionId,
      attempt,
      outputData,
    );

    await addStepResult(redis, {
      messageVersion: 1,
      tenantId: context.tenantId,
      sessionId: context.runId,
      stepExecutionId,
      parentStepExecutionId: parentStepExecutionId ?? null,
      stepId: stepDef.stepId,
      stepType: stepDef.stepType,
      operationId: stepDef.operation as OperationId,
      attempt,
      idempotencyKey,
      status: 'SUCCEEDED',
      outputRef,
      resolvedInputRef: resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });

    getOrchestratorLogger().debug(
      `[SessionOrchestrator] platform.list_api_definitions executed inline: ${String(apis.length)} APIs returned`,
    );
  } catch (err) {
    const errorData = {
      code: 'LIST_API_DEFINITIONS_FAILED',
      message: err instanceof Error ? err.message : String(err),
      classification: 'internal' as const,
      retryable: false,
      timestamp: new Date().toISOString(),
    };
    const errorRef = `inline:${Buffer.from(JSON.stringify(errorData)).toString('base64')}`;

    await addStepResult(redis, {
      messageVersion: 1,
      tenantId: context.tenantId,
      sessionId: context.runId,
      stepExecutionId,
      parentStepExecutionId: parentStepExecutionId ?? null,
      stepId: stepDef.stepId,
      stepType: stepDef.stepType,
      operationId: stepDef.operation as OperationId,
      attempt,
      idempotencyKey,
      status: 'FAILED',
      errorRef: errorRef,
      error: errorData,
      resolvedInputRef: resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });
  }
}
