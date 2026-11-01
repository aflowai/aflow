import { z } from 'zod';
import {
  ACTION_CENTER_ITEM_ID_PREFIX,
  PLAN_NODE_UPDATE_OPERATION_ID,
  planItemSummary,
  planItemTitle,
  planNoteHoldsMergeWait,
} from '@aflow/schemas';
import {
  createPlanNodeStore,
  createResidentScheduleStore,
  requestResidentWake,
  listWaitingNodes,
  planAsk,
  findWaitingNode,
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
    id: `${ACTION_CENTER_ITEM_ID_PREFIX.planAsk}${node.nodeId}`,
    spaceId: node.spaceId,
    kind: 'human_approval',
    origin: { type: 'plan_ask', nodeId: node.nodeId, revision: node.revision },
    title: planItemTitle(node.status !== 'blocked' ? 'merge_wait' : 'blocked', node.title),
    summary: planItemSummary(planAsk(node).waitsOn),
    uiHints: {
      approveLabel: node.status !== 'blocked' ? 'Close done' : 'Approve',
      rejectLabel: 'Drop',
    },
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
      return (await listWaitingNodes(context(scope))).map(planAskItem);
    },
    async getById(ctx, id) {
      if (!id.startsWith(ACTION_CENTER_ITEM_ID_PREFIX.planAsk)) return null;
      const parsed = z
        .string()
        .uuid()
        .safeParse(id.slice(ACTION_CENTER_ITEM_ID_PREFIX.planAsk.length));
      if (!parsed.success) return null;
      const node = await findWaitingNode(context(ctx), parsed.data);
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
      const node = await findWaitingNode(context(ctx), observed.nodeId);
      const closesMerge =
        node !== null && node.status !== 'blocked' && planNoteHoldsMergeWait(node.note);
      const result =
        resolution.kind === 'approve'
          ? closesMerge
            ? await updatePlanNode(write, {
                ...input,
                status: 'done',
                outcome: 'The operator judged the merge and closed the node.',
              })
            : await openPlanNode(write, input)
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
