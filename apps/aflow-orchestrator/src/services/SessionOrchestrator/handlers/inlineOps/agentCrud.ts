import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';
import type { OperationId, AgentSlug, AgentId } from '@aflow/schemas';
import { AgentSlugSchema } from '@aflow/schemas';
import { addStepResult } from '@aflow/redis';
import { encodeInlineOpOutputRef } from './helpers.js';
import {
  getDatabase,
  createTenantContext,
  createAgentRepository,
  listCustomAgentsInSpace,
  resolveAgentRef,
} from '@aflow/database';
import type { InlineHandlerArgs } from './types.js';
import { requireSpaceId } from './spaceScope.js';

// ============================================================================

export async function handleAgentCrudInline(args: InlineHandlerArgs): Promise<void> {
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
    const tenantCtx = createTenantContext(context.tenantId);
    const agentRepo = createAgentRepository(db, tenantCtx);
    let outputData: Record<string, unknown>;

    /**
     * Resolve a caller-supplied agent identifier to the agent's UUID. Accepts
     * either `agentId` (UUID, preferred) or `agentSlug` (per-space slug,
     * history-aware). Returns null if neither is provided.
     */
    const resolveTargetId = async (
      spaceId: string,
    ): Promise<{ id: AgentId; viaSlug?: AgentSlug } | null> => {
      const rawId = input['agentId'];
      if (typeof rawId === 'string' && rawId.length > 0) {
        return { id: rawId as AgentId };
      }
      const rawSlug = input['agentSlug'] ?? input['slug'];
      if (typeof rawSlug === 'string' && rawSlug.length > 0) {
        const slugParse = AgentSlugSchema.safeParse(rawSlug);
        if (!slugParse.success) {
          throw new Error(`Invalid agentSlug: ${slugParse.error.issues[0]?.message ?? ''}`);
        }
        const resolved = await resolveAgentRef(db, context.tenantId, {
          spaceId,
          agentSlug: slugParse.data,
        });
        return { id: resolved.target.agentId, viaSlug: slugParse.data };
      }
      return null;
    };

    switch (operationId) {
      case 'agent.manage.create': {
        const slugRaw = input['slug'] ?? input['agentSlug'];
        if (typeof slugRaw !== 'string') {
          throw new Error('agent.manage.create requires "slug"');
        }
        const slugParse = AgentSlugSchema.safeParse(slugRaw);
        if (!slugParse.success) {
          throw new Error(`Invalid slug: ${slugParse.error.issues[0]?.message ?? ''}`);
        }
        const name = (input['name'] as string | undefined) ?? slugParse.data;
        const description = input['description'] as string | undefined;
        const definitionInput = input['definition'];
        if (definitionInput === null || typeof definitionInput !== 'object') {
          throw new Error('agent.manage.create requires "definition"');
        }
        const tags = (input['tags'] as string[] | undefined) ?? [];
        const createSpaceId = requireSpaceId(context);

        const definition = definitionInput as Record<string, unknown>;
        const metadata = (definition['metadata'] as Record<string, unknown> | undefined) ?? {};
        const definitionJson = {
          ...definition,
          flowId: slugParse.data,
          metadata: {
            ...metadata,
            ...(description ? { description } : {}),
            ...(tags.length > 0 ? { tags } : {}),
          },
        };

        const created = await agentRepo.create({
          spaceId: createSpaceId,
          slug: slugParse.data,
          name,
          ...(description !== undefined ? { description } : {}),
          initialVersion: {
            version: '1',
            definition: definitionJson as Parameters<
              typeof agentRepo.create
            >[0]['initialVersion']['definition'],
          },
        });

        outputData = {
          agentId: created.agent.id,
          slug: created.agent.slug,
          version: created.version.version,
          createdAt: created.agent.createdAt.toISOString(),
        };
        break;
      }

      case 'agent.manage.get': {
        const spaceId = requireSpaceId(context);
        const resolved = await resolveTargetId(spaceId);
        if (!resolved) {
          throw new Error('agent.manage.get requires "agentId" (UUID) or "agentSlug"');
        }
        const agent = await agentRepo.getById(resolved.id);
        if (!agent) throw new Error(`Agent not found`);
        const latestVersion = await agentRepo.getLatestVersion(resolved.id);
        const defJson = (latestVersion?.definitionJson ?? {}) as Record<string, unknown>;
        const metadata = (defJson['metadata'] as Record<string, unknown> | undefined) ?? {};

        outputData = {
          agentId: agent.id,
          slug: agent.slug,
          name: agent.name,
          ...(agent.description ? { description: agent.description } : {}),
          version: latestVersion?.version ?? '',
          definition: defJson,
          tags: (metadata['tags'] as string[] | undefined) ?? [],
          spaceId: agent.spaceId,
          ...(agent.archivedAt ? { archivedAt: agent.archivedAt.toISOString() } : {}),
          createdAt: agent.createdAt.toISOString(),
          updatedAt: agent.updatedAt.toISOString(),
        };
        break;
      }

      case 'agent.manage.update': {
        const spaceId = requireSpaceId(context);
        const resolved = await resolveTargetId(spaceId);
        if (!resolved) {
          throw new Error('agent.manage.update requires "agentId" (UUID) or "agentSlug"');
        }
        const newName = input['name'] as string | undefined;
        const newDescription = input['description'] as string | undefined;
        const newSlugRaw = input['newSlug'] ?? input['slug'];
        let newSlug: AgentSlug | undefined;
        if (
          typeof newSlugRaw === 'string' &&
          newSlugRaw.length > 0 &&
          newSlugRaw !== resolved.viaSlug
        ) {
          const slugParse = AgentSlugSchema.safeParse(newSlugRaw);
          if (!slugParse.success) {
            throw new Error(`Invalid newSlug: ${slugParse.error.issues[0]?.message ?? ''}`);
          }
          newSlug = slugParse.data;
        }

        const updated = await agentRepo.update(resolved.id, {
          ...(newSlug ? { slug: newSlug } : {}),
          ...(newName !== undefined ? { name: newName } : {}),
          ...(newDescription !== undefined ? { description: newDescription } : {}),
        });
        if (!updated) throw new Error(`Agent not found`);

        // Optionally publish a new version if `definition` was supplied.
        let newVersion: string | undefined;
        if (input['definition'] && typeof input['definition'] === 'object') {
          const latest = await agentRepo.getLatestVersion(resolved.id);
          const parsedVersion = parseInt(latest?.version ?? '1', 10);
          newVersion = Number.isNaN(parsedVersion)
            ? `${latest?.version ?? '1'}.1`
            : String(parsedVersion + 1);
          await agentRepo.publishVersion({
            agentId: resolved.id,
            version: newVersion,
            definition: input['definition'] as Parameters<
              typeof agentRepo.publishVersion
            >[0]['definition'],
          });
        }

        outputData = {
          agentId: updated.id,
          slug: updated.slug,
          ...(newVersion ? { version: newVersion } : {}),
          updatedAt: updated.updatedAt.toISOString(),
        };
        break;
      }

      case 'agent.manage.delete': {
        const spaceId = requireSpaceId(context);
        const resolved = await resolveTargetId(spaceId);
        if (!resolved) {
          throw new Error('agent.manage.delete requires "agentId" (UUID) or "agentSlug"');
        }
        await agentRepo.archive(resolved.id);
        outputData = {
          agentId: resolved.id,
          deleted: true,
          deletedAt: new Date().toISOString(),
        };
        break;
      }

      case 'agent.manage.list': {
        const tags = input['tags'] as string[] | undefined;
        const search = input['search'] as string | undefined;
        const queryLimit = (input['limit'] as number | undefined) ?? 20;
        const queryOffset = (input['offset'] as number | undefined) ?? 0;
        const listSpaceId = requireSpaceId(context);

        const rows = await listCustomAgentsInSpace(db, context.tenantId, listSpaceId);

        const agents = rows.map((row) => ({
          agentId: row.id,
          slug: row.slug,
          name: row.name,
          ...(row.description ? { description: row.description } : {}),
          spaceId: row.spaceId,
          ...(row.archivedAt ? { archivedAt: row.archivedAt.toISOString() } : {}),
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        }));

        // Post-filter by search (name/slug)
        const filtered = search
          ? agents.filter(
              (a) =>
                a.name.toLowerCase().includes(search.toLowerCase()) ||
                a.slug.toLowerCase().includes(search.toLowerCase()),
            )
          : agents;

        // Tag filtering moved to caller — `agents` table doesn't store tags;
        // tags live on the latest version's metadata. If callers need this
        // filter, fold it into a later helper that joins agent_versions.
        if (tags && tags.length > 0) {
          getOrchestratorLogger().warn(
            '[agent.manage.list] tag filter is currently a no-op; tags live on agent_versions metadata',
          );
        }

        const paginated = filtered.slice(queryOffset, queryOffset + queryLimit);
        outputData = { agents: paginated, total: filtered.length };
        break;
      }

      case 'agent.manage.validate': {
        const definition: unknown = input['definition'];
        if (definition === null || typeof definition !== 'object') {
          throw new Error('agent.manage.validate requires a "definition" object');
        }

        const { validateAgentDefinition } = await import('@aflow/schemas');
        const result = validateAgentDefinition(
          definition as Parameters<typeof validateAgentDefinition>[0],
        );

        outputData = {
          valid: result.valid,
          issues: result.issues.map((i) => ({
            path: i.path,
            message: i.message,
            severity: i.level === 'info' ? ('warning' as const) : i.level,
          })),
          stepCount: result.stepCount,
          stateVariableCount: result.stateVariableCount,
        };
        break;
      }

      default:
        throw new Error(`Unknown agent.manage operation: ${operationId}`);
    }

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
      operationId: operationId as OperationId,
      attempt,
      idempotencyKey,
      status: 'SUCCEEDED',
      outputRef,
      resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });

    getOrchestratorLogger().debug(`[SessionOrchestrator] ${operationId} executed inline`);
  } catch (err) {
    const errorData = {
      code: 'AGENT_CRUD_OP_FAILED',
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
      operationId: operationId as OperationId,
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
