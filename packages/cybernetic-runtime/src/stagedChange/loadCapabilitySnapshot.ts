import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import type { TaskCapabilityGrant, TenantId } from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  apiBindings,
  apiDefinitions,
  mcpServerBindings,
} from '@aflow/database';
import { listSkillsForSpace, type SkillLoadContext } from '../skill.js';
import { collectOperationTaskApiRefs } from '../operationTaskApiRefs.js';
import type {
  ExistingSkillGrantReference,
  ProposalValidationSnapshot,
} from './proposalValidations.js';

export interface LoadSnapshotContext {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
}

export async function loadProposalValidationSnapshot(
  ctx: LoadSnapshotContext,
): Promise<ProposalValidationSnapshot> {
  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);

  const apiRows = await withTenantSchema(ctx.db, tenantCtx, async (tx) =>
    tx
      .select({
        bindingId: apiBindings.bindingId,
        apiId: apiBindings.apiId,
        scopeJson: apiBindings.scopeJson,
      })
      .from(apiBindings)
      .where(and(eq(apiBindings.enabled, 1), eq(apiBindings.spaceId, ctx.spaceId))),
  );

  const mcpRows = await withTenantSchema(ctx.db, tenantCtx, async (tx) =>
    tx
      .select({
        bindingId: mcpServerBindings.bindingId,
        serverId: mcpServerBindings.serverId,
        scopeJson: mcpServerBindings.scopeJson,
      })
      .from(mcpServerBindings)
      .where(eq(mcpServerBindings.enabled, 1)),
  );

  // Walk api_definitions only for apiIds that are referenced by visible
  // bindings. One query per definition keeps the schema explicit; for the
  // common case (<20 definitions per space) the round-trips are cheap.
  const visibleApiIds = new Set<string>();
  for (const row of apiRows) {
    const scope = row.scopeJson as Record<string, unknown> | null;
    const scopeSpaceId = scope?.['spaceId'] as string | undefined;
    if (!scopeSpaceId || scopeSpaceId === ctx.spaceId) {
      visibleApiIds.add(row.apiId);
    }
  }

  const endpointsByApiId = new Map<string, string[]>();
  if (visibleApiIds.size > 0) {
    const defRows = await withTenantSchema(ctx.db, tenantCtx, async (tx) =>
      tx
        .select({ apiId: apiDefinitions.apiId, definitionJson: apiDefinitions.definitionJson })
        .from(apiDefinitions)
        .where(eq(apiDefinitions.spaceId, ctx.spaceId)),
    );
    for (const row of defRows) {
      if (!visibleApiIds.has(row.apiId)) continue;
      const def = row.definitionJson as { endpoints?: Array<{ endpointId?: string }> } | null;
      const endpointIds: string[] = [];
      for (const ep of def?.endpoints ?? []) {
        if (typeof ep.endpointId === 'string') endpointIds.push(ep.endpointId);
      }
      endpointsByApiId.set(row.apiId, endpointIds);
    }
  }

  const apiSnapshot = apiRows
    .filter((row) => {
      const scope = row.scopeJson as Record<string, unknown> | null;
      const scopeSpaceId = scope?.['spaceId'] as string | undefined;
      return !scopeSpaceId || scopeSpaceId === ctx.spaceId;
    })
    .map((row) => ({
      bindingId: row.bindingId,
      apiId: row.apiId,
      endpointIds: endpointsByApiId.get(row.apiId) ?? [],
    }));

  const mcpSnapshot = mcpRows
    .filter((row) => {
      const scope = row.scopeJson as Record<string, unknown> | null;
      const scopeSpaceId = scope?.['spaceId'] as string | undefined;
      return !scopeSpaceId || scopeSpaceId === ctx.spaceId;
    })
    .map((row) => ({ bindingId: row.bindingId, serverId: row.serverId }));

  return { apiBindings: apiSnapshot, mcpBindings: mcpSnapshot };
}

export async function loadSkillGrantReferencesForApiId(
  ctx: LoadSnapshotContext,
  apiId: string,
): Promise<ExistingSkillGrantReference[]> {
  const skillCtx: SkillLoadContext = {
    db: ctx.db,
    tenantId: ctx.tenantId,
    spaceId: ctx.spaceId,
  };
  const skills = await listSkillsForSpace(skillCtx);
  const refs: ExistingSkillGrantReference[] = [];
  for (const skill of skills) {
    const workflow = skill.workflow;
    if (!workflow) continue;
    for (const task of workflow.tasks) {
      const grants = (task.context as { capabilities?: TaskCapabilityGrant } | undefined)
        ?.capabilities;
      if (!grants) continue;
      // Defensive: `integrations` is optional in raw stored workflow defs
      // (only the operations field is populated for platform skills that
      // grant Phoenix-native ops). Without this guard, the loop throws
      // "grants.integrations is not iterable" — same hazard as in
      // `proposalValidations.ts`.
      for (const grant of grants.integrations ?? []) {
        if (grant.sourceKind !== 'api') continue;
        if (grant.integrationId !== apiId) continue;
        if (grant.allTools) continue;
        const grantedEndpointIds = grant.toolNames.map((t) => t.toolName);
        if (grantedEndpointIds.length === 0) continue;
        refs.push({
          skillSlug: skill.manifest.workflowSlug,
          taskId: task.taskId,
          apiId,
          grantedEndpointIds,
        });
      }
    }
    // api.http.call operation tasks reference endpoints via inputTemplate, not a
    // context grant — include endpoint-bearing refs so a definition edit that
    // drops the endpoint is flagged as dangling. Direct-URL
    // refs carry no endpoint, so there is nothing for them to dangle.
    for (const ref of collectOperationTaskApiRefs(workflow.tasks)) {
      if (ref.apiId !== apiId || !ref.endpointId) continue;
      refs.push({
        skillSlug: skill.manifest.workflowSlug,
        taskId: ref.taskId,
        apiId,
        grantedEndpointIds: [ref.endpointId],
      });
    }
  }
  return refs;
}
