import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from '@aflow/redis';
import { getSessionState } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { failureWithError, successWithData, validationError } from '@aflow/executor-runtime';
import { PlanNodeUpdateInputSchema } from '@aflow/schemas';
import {
  createPlanNodeStore,
  updatePlanNode,
  readMergedPullRequest,
  restrictedPlanWriteAuthority,
} from '@aflow/cybernetic-runtime';
import { readBindingEndpoint } from './bindingRead.js';

export async function executePlanNodeUpdate(
  ctx: ExecutorContext,
  deps: { db: PostgresJsDatabase; redis: Redis; payloadStore: PayloadStore },
): Promise<StepResult> {
  const input = PlanNodeUpdateInputSchema.parse(await ctx.readPayload(ctx.job.inputRef));
  if (!ctx.spaceId) return failureWithError(ctx, validationError('Plan writes require a space'));
  const spaceId = ctx.spaceId;
  const state = await getSessionState(deps.redis, ctx.tenantId, ctx.runId).catch(() => null);
  const result = await updatePlanNode(
    {
      store: createPlanNodeStore(deps.db, ctx.tenantId),
      spaceId,
      redis: deps.redis,
      tenantId: ctx.tenantId,
      actorKind: 'agent',
      resident: restrictedPlanWriteAuthority(state),
      readMergedPullRequest: (url, nodeId) =>
        readMergedPullRequest(deps.db, ctx.tenantId, spaceId, url, nodeId, {
          payloadStore: deps.payloadStore,
          readBinding: (bindingId, endpointId, params) =>
            readBindingEndpoint(
              {
                ...deps,
                tenantId: ctx.tenantId,
                spaceId,
                runId: ctx.runId,
                ...(ctx.job.credentialOwnerId
                  ? { credentialOwnerId: ctx.job.credentialOwnerId }
                  : {}),
              },
              bindingId,
              endpointId,
              params,
            ),
        }),
    },
    input,
  );
  if (!result.ok)
    return failureWithError(ctx, {
      ...validationError(result.message, result.details),
      code: result.code,
      retryable: result.code === 'PLAN_NODE_ATTESTATION_UNAVAILABLE',
    });
  return successWithData(ctx, {
    node: result.node,
    ...(result.carrier ? { carrier: result.carrier } : {}),
    ...(result.carrierFailure ? { carrierFailure: result.carrierFailure } : {}),
  });
}
