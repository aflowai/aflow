import { eq, desc, and } from 'drizzle-orm';
import {
  getDatabase,
  withTenantSchema,
  createTenantContext,
  guardrailPolicies,
  guardrailViolations,
} from '@aflow/database';
import type { GuardrailPolicyRow, GuardrailViolationRow } from '@aflow/database';
import type { GuardrailPolicy } from '@aflow/schemas';
import { compilePolicies } from '../../../../GuardrailGate/policyCompiler.js';
import type { InlineHandlerArgs } from '../types.js';
import { emitStepSuccess, emitStepError } from '../helpers.js';
import { requireSpaceId } from '../spaceScope.js';
import { classifyInlineCrudCatch } from '../classifyInlineCatch.js';
import { getOrchestratorLogger } from '../../../../../lib/orchestratorLogger.js';
import { publishGuardrailCacheInvalidation } from './cache.js';

// ============================================================================
// guardrail.policy.* / guardrail.violation.* — Guardrail CRUD
// ============================================================================

export async function handleGuardrailCrudInline(args: InlineHandlerArgs): Promise<void> {
  const {
    redis,
    payloadStore,
    context,
    stepDef,
    stepExecutionId: _stepExecutionId,
    idempotencyKey: _idempotencyKey,
    resolvedInputRef,
    attempt: _attempt,
    parentStepExecutionId: _parentStepExecutionId,
  } = args;
  const startTime = Date.now();
  const operationId = stepDef.operation;
  const spaceId = requireSpaceId(context);

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
    let outputData: Record<string, unknown>;

    switch (operationId) {
      case 'guardrail.policy.create': {
        const policyId = input['policyId'] as string;
        const name = input['name'] as string;

        await withTenantSchema(db, tenantCtx, async (tx) => {
          const vals: Record<string, unknown> = {
            policyId,
            name,
            scope: input['scope'],
            rails: input['rails'],
            spaceId,
          };
          if (input['description'] !== undefined) vals['description'] = input['description'];
          if (input['version'] !== undefined) vals['version'] = input['version'];
          if (input['settings'] !== undefined) vals['settings'] = input['settings'];
          if (input['tags'] !== undefined) vals['tags'] = input['tags'];

          await tx.insert(guardrailPolicies).values(vals as typeof guardrailPolicies.$inferInsert);
        });

        await publishGuardrailCacheInvalidation(redis, context.tenantId);
        outputData = { policyId, createdAt: new Date().toISOString() };
        break;
      }

      case 'guardrail.policy.get': {
        const policyId = input['policyId'] as string;

        const rows = (await withTenantSchema(db, tenantCtx, async (tx) => {
          return tx
            .select()
            .from(guardrailPolicies)
            .where(
              and(eq(guardrailPolicies.policyId, policyId), eq(guardrailPolicies.spaceId, spaceId)),
            )
            .limit(1);
        })) as GuardrailPolicyRow[];

        const row = rows[0];
        if (!row) throw new Error(`Guardrail policy "${policyId}" not found`);

        outputData = {
          policyId: row.policyId,
          name: row.name,
          ...(row.description ? { description: row.description } : {}),
          version: row.version,
          scope: row.scope,
          rails: row.rails,
          ...(row.settings ? { settings: row.settings } : {}),
          ...(row.tags ? { tags: row.tags } : {}),
          createdAt: new Date(row.createdAt).toISOString(),
          updatedAt: new Date(row.updatedAt).toISOString(),
        };
        break;
      }

      case 'guardrail.policy.update': {
        const policyId = input['policyId'] as string;

        const result = (await withTenantSchema(db, tenantCtx, async (tx) => {
          const updates: Record<string, unknown> = { updatedAt: new Date() };
          if (input['name'] !== undefined) updates['name'] = input['name'];
          if (input['description'] !== undefined) updates['description'] = input['description'];
          if (input['version'] !== undefined) updates['version'] = input['version'];
          if (input['scope'] !== undefined) updates['scope'] = input['scope'];
          if (input['rails'] !== undefined) updates['rails'] = input['rails'];
          if (input['settings'] !== undefined) updates['settings'] = input['settings'];
          if (input['tags'] !== undefined) updates['tags'] = input['tags'];

          return tx
            .update(guardrailPolicies)
            .set(updates)
            .where(
              and(eq(guardrailPolicies.policyId, policyId), eq(guardrailPolicies.spaceId, spaceId)),
            )
            .returning();
        })) as GuardrailPolicyRow[];

        if (result.length === 0) throw new Error(`Guardrail policy "${policyId}" not found`);

        await publishGuardrailCacheInvalidation(redis, context.tenantId);
        outputData = { policyId, updatedAt: new Date().toISOString() };
        break;
      }

      case 'guardrail.policy.delete': {
        const policyId = input['policyId'] as string;

        const result = await withTenantSchema(db, tenantCtx, async (tx) => {
          return tx
            .delete(guardrailPolicies)
            .where(
              and(eq(guardrailPolicies.policyId, policyId), eq(guardrailPolicies.spaceId, spaceId)),
            )
            .returning();
        });

        if (result.length === 0) throw new Error(`Guardrail policy "${policyId}" not found`);

        await publishGuardrailCacheInvalidation(redis, context.tenantId);
        outputData = { policyId, deleted: true };
        break;
      }

      case 'guardrail.policy.list': {
        const queryLimit = (input['limit'] as number | undefined) ?? 20;
        const queryOffset = (input['offset'] as number | undefined) ?? 0;

        const rows = (await withTenantSchema(db, tenantCtx, async (tx) => {
          return tx
            .select()
            .from(guardrailPolicies)
            .where(eq(guardrailPolicies.spaceId, spaceId))
            .orderBy(desc(guardrailPolicies.createdAt))
            .limit(queryLimit)
            .offset(queryOffset);
        })) as GuardrailPolicyRow[];

        const policies = rows.map((r) => ({
          policyId: r.policyId,
          name: r.name,
          ...(r.description ? { description: r.description } : {}),
          version: r.version,
          railCount: Array.isArray(r.rails) ? (r.rails as unknown[]).length : 0,
          ...(r.tags ? { tags: r.tags } : {}),
          createdAt: new Date(r.createdAt).toISOString(),
          updatedAt: new Date(r.updatedAt).toISOString(),
        }));

        // Count total
        const [countResult] = (await withTenantSchema(db, tenantCtx, async (tx) => {
          const { sql } = await import('drizzle-orm');
          return tx
            .select({ count: sql<number>`count(*)` })
            .from(guardrailPolicies)
            .where(eq(guardrailPolicies.spaceId, spaceId));
        })) as Array<{ count: number }>;

        outputData = { policies, total: countResult?.count ?? 0 };
        break;
      }

      case 'guardrail.policy.get_effective': {
        const flowId = input['flowId'] as string;

        // Load policies for this space and compile for this flow
        const allPolicies = (await withTenantSchema(db, tenantCtx, async (tx) => {
          return tx.select().from(guardrailPolicies).where(eq(guardrailPolicies.spaceId, spaceId));
        })) as GuardrailPolicyRow[];

        const parsedPolicies: GuardrailPolicy[] = allPolicies.map((row) => ({
          policyId: row.policyId,
          name: row.name,
          ...(row.description ? { description: row.description } : {}),
          version: row.version,
          scope: row.scope as GuardrailPolicy['scope'],
          rails: row.rails as GuardrailPolicy['rails'],
          settings: row.settings as GuardrailPolicy['settings'],
          ...(row.tags ? { tags: row.tags } : {}),
        }));

        const compiled = compilePolicies(parsedPolicies, {
          tenantId: context.tenantId,
          targetKey: `legacy-flow:${flowId}`,
        });

        outputData = compiled as unknown as Record<string, unknown>;
        break;
      }

      case 'guardrail.violation.list': {
        const queryLimit = (input['limit'] as number | undefined) ?? 20;
        const queryOffset = (input['offset'] as number | undefined) ?? 0;
        const sessionIdFilter = input['sessionId'] as string | undefined;
        const policyIdFilter = input['policyId'] as string | undefined;
        const railIdFilter = input['railId'] as string | undefined;

        const rows = (await withTenantSchema(db, tenantCtx, async (tx) => {
          let query = tx.select().from(guardrailViolations);

          // Build conditions
          const conditions: Array<ReturnType<typeof eq>> = [];
          if (sessionIdFilter) conditions.push(eq(guardrailViolations.sessionId, sessionIdFilter));
          if (policyIdFilter) conditions.push(eq(guardrailViolations.policyId, policyIdFilter));
          if (railIdFilter) conditions.push(eq(guardrailViolations.railId, railIdFilter));

          if (conditions.length > 0) {
            query = query.where(and(...conditions)) as typeof query;
          }

          return query
            .orderBy(desc(guardrailViolations.createdAt))
            .limit(queryLimit)
            .offset(queryOffset);
        })) as GuardrailViolationRow[];

        const violations = rows.map((r) => ({
          sessionId: r.sessionId,
          ...(r.stepExecutionId ? { stepExecutionId: r.stepExecutionId } : {}),
          policyId: r.policyId,
          railId: r.railId,
          trigger: r.trigger,
          violationType: r.violationType,
          actionTaken: r.actionTaken,
          ...(r.detail ? { detail: r.detail as Record<string, unknown> } : {}),
          durationMs: r.durationMs ?? 0,
          createdAt: new Date(r.createdAt).toISOString(),
        }));

        // Count total with same filters
        const [countResult] = (await withTenantSchema(db, tenantCtx, async (tx) => {
          const { sql } = await import('drizzle-orm');
          let query = tx.select({ count: sql<number>`count(*)` }).from(guardrailViolations);

          const conditions: Array<ReturnType<typeof eq>> = [];
          if (sessionIdFilter) conditions.push(eq(guardrailViolations.sessionId, sessionIdFilter));
          if (policyIdFilter) conditions.push(eq(guardrailViolations.policyId, policyIdFilter));
          if (railIdFilter) conditions.push(eq(guardrailViolations.railId, railIdFilter));

          if (conditions.length > 0) {
            query = query.where(and(...conditions)) as typeof query;
          }

          return query;
        })) as Array<{ count: number }>;

        outputData = { violations, total: countResult?.count ?? 0 };
        break;
      }

      default:
        throw new Error(`Unknown guardrail operation: ${operationId}`);
    }

    await emitStepSuccess(args, outputData, startTime);
    getOrchestratorLogger().debug(`[guardrailCrud] ${operationId} executed inline`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await emitStepError(
      args,
      'GUARDRAIL_OP_FAILED',
      msg,
      startTime,
      classifyInlineCrudCatch(msg, 'Unknown guardrail operation:'),
    );
  }
}
