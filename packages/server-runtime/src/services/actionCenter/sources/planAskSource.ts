import { z } from 'zod';
import { PLAN_NODE_UPDATE_OPERATION_ID } from '@aflow/schemas';
import {
  createPlanNodeStore,
  createResidentScheduleStore,
  requestResidentWake,
  listAskedNodes,
  planAsk,
  findAskedNode,
  openPlanNode,
  updatePlanNode,
} from '@aflow/cybernetic-runtime';
import type { PlanNode } from '@aflow/schemas';
import {
  ActionCenterResolveError,
  type ActionCenterSource,
  type ActionCenterSourceDeps,
  type ActionCenterSourceItem,
} from '../types.js';
import { PLAN_WRITE_OPERATOR_ONLY } from '../../../lib/planWriteAuthority.js';

export function planAskItem(node: PlanNode): ActionCenterSourceItem {
  return {
    id: `plan-ask:${node.nodeId}`,
    spaceId: node.spaceId,
    kind: 'human_approval',
    origin: { type: 'plan_ask', nodeId: node.nodeId, revision: node.revision },
    title: `Blocked: ${node.title}`.slice(0, 256),
    summary: planAsk(node).waitsOn.slice(0, 2_000),
    uiHints: { approveLabel: 'Approve', rejectLabel: 'Drop' },
    requestedAt: node.updatedAt,
    requestedBy: { kind: 'agent', label: 'Helmsman · plan' },
    priority: 'high',
    relatesTo: [],
    resolverAuthority: { kind: 'space' },
    status: 'open',
  };
}

export function createPlanAskSource(deps: ActionCenterSourceDeps): ActionCenterSource {
  const context = (scope: { tenantId: string; spaceId: string }) => ({
    ...scope,
    store: createPlanNodeStore(deps.db, scope.tenantId),
    redis: deps.redis,
  });
  return {
    name: 'planAsk',
    rowScope: 'space',
    handlesOriginTypes: ['plan_ask'],
    async listOpen(scope) {
      return (await listAskedNodes(context(scope))).map(planAskItem);
    },
    async getById(ctx, id) {
      if (!id.startsWith('plan-ask:')) return null;
      const parsed = z.string().uuid().safeParse(id.slice('plan-ask:'.length));
      if (!parsed.success) return null;
      const node = await findAskedNode(context(ctx), parsed.data);
      return node ? planAskItem(node) : null;
    },
    async resolve(ctx, item, resolution, observed) {
      if (!ctx.actorIsInteractiveUser)
        throw new ActionCenterResolveError('FORBIDDEN', PLAN_WRITE_OPERATOR_ONLY);
      if (
        item.origin.type !== 'plan_ask' ||
        observed?.type !== 'plan_ask' ||
        observed.nodeId !== item.origin.nodeId ||
        !['approve', 'reject'].includes(resolution.kind)
      ) {
        throw new ActionCenterResolveError(
          'INVALID_RESOLUTION',
          'Approve or drop the blocked step against the origin shown.',
        );
      }
      const write = { ...context(ctx), createdBy: ctx.actorUserId, actorKind: 'human' as const };
      const input = { nodeId: observed.nodeId, expectedRevision: observed.revision };
      const result =
        resolution.kind === 'approve'
          ? await openPlanNode(write, input)
          : await updatePlanNode(write, {
              ...input,
              status: 'dropped',
              outcome: 'Dropped by the operator in the Action Center.',
            });
      if (!result.ok)
        throw new ActionCenterResolveError(
          result.code === 'PLAN_NODE_STALE' ? 'STALE_ACTION_CENTER_ITEM' : 'INVALID_RESOLUTION',
          result.message,
        );
      await requestResidentWake(
        { redis: deps.redis, schedules: createResidentScheduleStore(deps.db) },
        { tenantId: ctx.tenantId, spaceId: ctx.spaceId, cause: 'node_written' },
      );
      return {
        resolvedAt: result.node.updatedAt,
        ...(result.carrierFailure ? { carrierFailure: result.carrierFailure } : {}),
        dispatchedOperationId: PLAN_NODE_UPDATE_OPERATION_ID,
      };
    },
  };
}
