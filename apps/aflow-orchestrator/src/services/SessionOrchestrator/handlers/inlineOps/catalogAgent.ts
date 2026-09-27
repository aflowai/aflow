import { addStepResult } from '@aflow/redis';
import { encodeInlineOpOutputRef } from './helpers.js';
import {
  getDatabase,
  listCustomAgentsInSpace,
  listPlatformRoles,
  loadAgentTargetDefinition,
  withTenantSchema,
  createTenantContext,
  spaces,
} from '@aflow/database';
import { eq } from 'drizzle-orm';
import type { PersistentAgentTarget, SystemRole, AgentId } from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';
import { requireSpaceId } from './spaceScope.js';

export async function handleCatalogAgentInline(args: InlineHandlerArgs): Promise<void> {
  const {
    redis,
    payloadStore,
    context,
    stepDef,
    stepExecutionId,
    idempotencyKey,
    resolvedInputRef,
    attempt,
    parentStepExecutionId,
  } = args;
  const startTime = Date.now();
  const operationId = stepDef.operation;

  try {
    // Read input
    let input: Record<string, unknown> = {};
    try {
      const data = await payloadStore.retrieve(resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      /* empty input */
    }

    const db = getDatabase();
    const spaceId = requireSpaceId(context);

    let outputData: Record<string, unknown>;

    switch (operationId) {
      case 'catalog.agent.list': {
        const search = input['search'] as string | undefined;
        const queryLimit = Math.min((input['limit'] as number | undefined) ?? 20, 50);

        const tenantCtx = createTenantContext(context.tenantId);
        const [platformRoles, customRows, spaceSlugRows] = await Promise.all([
          Promise.resolve(listPlatformRoles()),
          listCustomAgentsInSpace(db, context.tenantId, spaceId),
          withTenantSchema(db, tenantCtx, async (tx) =>
            tx.select({ slug: spaces.slug }).from(spaces).where(eq(spaces.id, spaceId)).limit(1),
          ),
        ]);
        const spaceSlug = spaceSlugRows[0]?.slug;

        interface CatalogAgentItem {
          target: PersistentAgentTarget;
          slug: string;
          spaceSlug?: string;
          route?: string;
          name: string;
          description: string;
          system: boolean;
        }

        const platformItems: CatalogAgentItem[] = platformRoles.map((entry) => {
          const defJson = entry.definition as unknown as Record<string, unknown>;
          const metadata = (defJson['metadata'] as Record<string, unknown> | undefined) ?? {};
          return {
            target: { kind: 'platform-role', systemRole: entry.systemRole as SystemRole },
            slug: entry.systemRole,
            ...(spaceSlug ? { spaceSlug } : {}),
            name: (metadata['name'] as string | undefined) ?? entry.systemRole,
            description: (metadata['description'] as string | undefined) ?? '',
            system: true,
            // No `route` — platform agents are invocation targets, not URL
            // destinations. Helmsman should delegate to them rather than
            // emit a link.
          };
        });

        const customItems: CatalogAgentItem[] = customRows.map((row) => ({
          target: { kind: 'custom-agent', agentId: row.id as AgentId },
          slug: row.slug,
          ...(spaceSlug ? { spaceSlug } : {}),
          ...(spaceSlug
            ? {
                route: `/s/${encodeURIComponent(spaceSlug)}/agents/${encodeURIComponent(row.slug)}`,
              }
            : {}),
          name: row.name,
          description: row.description ?? '',
          system: false,
        }));

        let agents: CatalogAgentItem[] = [...platformItems, ...customItems];

        // Post-filter by search (name/description ILIKE)
        if (search) {
          const lower = search.toLowerCase();
          agents = agents.filter(
            (a) =>
              a.name.toLowerCase().includes(lower) || a.description.toLowerCase().includes(lower),
          );
        }

        // Apply limit
        agents = agents.slice(0, queryLimit);

        outputData = { agents, total: agents.length };
        break;
      }

      case 'catalog.agent.get': {
        const rawTarget = input['target'];
        const targetParse = rawTarget
          ? (await import('@aflow/schemas')).PersistentAgentTargetSchema.safeParse(rawTarget)
          : null;
        if (!targetParse?.success) {
          throw new Error(
            'catalog.agent.get requires "target" — a PersistentAgentTarget ' +
              '({ kind: "platform-role", systemRole: ... } | { kind: "custom-agent", agentId: <uuid> }).',
          );
        }
        const targetForLookup = targetParse.data;

        let resolved;
        try {
          resolved = await loadAgentTargetDefinition(
            db,
            context.tenantId,
            targetForLookup,
            'latest',
          );
        } catch {
          throw new Error(
            `Agent not found for target. Use catalog.agent.list to see available agents.`,
          );
        }

        const defJson = resolved.definition as unknown as Record<string, unknown>;
        const metadata = (defJson['metadata'] as Record<string, unknown> | undefined) ?? {};
        const stateVars =
          (defJson['stateVariables'] as Array<Record<string, unknown>> | undefined) ?? [];

        // Extract input contract from state variables
        const inputVars = stateVars
          .filter((v) => v['lifecycle'] && (v['lifecycle'] as Record<string, unknown>)['isInput'])
          .map((v) => ({
            variableId: v['variableId'] as string,
            name: v['name'] as string,
            inputRole: v['inputRole'] as string | undefined,
            typeSchema: v['typeSchema'],
          }));

        outputData = {
          target: resolved.target,
          name: (metadata['name'] as string | undefined) ?? '',
          description: (metadata['description'] as string | undefined) ?? '',
          version: resolved.version,
          system: resolved.isPlatform,
          tags: (metadata['tags'] as string[] | undefined) ?? [],
          inputContract: inputVars,
          supportedModes: (defJson['supportedModes'] as string[] | undefined) ?? [],
        };
        break;
      }

      default:
        throw new Error(`Unknown catalog.agent operation: ${operationId}`);
    }

    // Emit success result
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
      operationId,
      attempt,
      idempotencyKey,
      status: 'SUCCEEDED',
      outputRef,
      resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });
  } catch (err) {
    const errorData = {
      code: 'CATALOG_AGENT_OP_FAILED',
      message: err instanceof Error ? err.message : String(err),
      classification: 'validation' as const,
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
      operationId,
      attempt,
      idempotencyKey,
      status: 'FAILED',
      errorRef,
      error: errorData,
      resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });
  }
}
