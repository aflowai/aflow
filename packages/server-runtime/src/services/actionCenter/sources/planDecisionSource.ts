import { z } from 'zod';
import {
  ACTION_CENTER_ITEM_ID_PREFIX,
  PLAN_NODE_PROSE_MAX_CHARS,
  PLAN_NODE_UPDATE_OPERATION_ID,
  planItemSummary,
  planItemTitle,
  type ActionCenterItemOrigin,
  type PlanNode,
  type TenantId,
} from '@aflow/schemas';
import {
  createPlanNodeStore,
  createResidentScheduleStore,
  requestResidentWake,
  findOpenDecision,
  listOpenDecisions,
  updatePlanNode,
  type PlanNodeStore,
} from '@aflow/cybernetic-runtime';

import {
  ActionCenterResolveError,
  type ActionCenterContext,
  type ActionCenterResolveOutcome,
  type ActionCenterScope,
  type ActionCenterSource,
  type ActionCenterSourceDeps,
  type ActionCenterSourceItem,
} from '../types.js';
import { PLAN_WRITE_OPERATOR_ONLY } from '../../../lib/planWriteAuthority.js';

const ITEM_ID_PREFIX = ACTION_CENTER_ITEM_ID_PREFIX.planDecision;

const NodeIdSchema = z.string().uuid();

/**
 * A `decide` node in the space's plan, asking the operator for the choice
 * that is its outcome (Plan 322 D2, P3.2).
 *
 * Derived from the node on every read and stored nowhere, like a session
 * invitation: an open decision under an open branch is an open item, and the
 * node closing — answered here, on the plan page, or by the Helmsman — is the
 * item going away. The node's revision is the CAS token, so an answer to a
 * question the Helmsman has rewritten since the operator read it is refused.
 *
 * The answer is written as the node's `outcome` as it is marked done, through
 * `plan.node.update`'s engine, compare-and-set on that revision. That is where
 * every reader of the plan already looks — the attention block, the plan page,
 * `plan.node.get`, a stream's walk — and the item has no record of its own to
 * link to. Who answered, and when, is the audit row the aggregator writes.
 */
export function createPlanDecisionSource(deps: ActionCenterSourceDeps): ActionCenterSource {
  const storeFor = (tenantId: TenantId): PlanNodeStore => createPlanNodeStore(deps.db, tenantId);

  return {
    name: 'planDecision',
    rowScope: 'space',
    handlesOriginTypes: ['plan_decision'],

    async listOpen(scope: ActionCenterScope): Promise<ActionCenterSourceItem[]> {
      const decisions = await listOpenDecisions({
        store: storeFor(scope.tenantId),
        spaceId: scope.spaceId,
      });
      return decisions.map(toItem);
    },

    async getById(
      ctx: ActionCenterContext,
      itemId: string,
    ): Promise<ActionCenterSourceItem | null> {
      if (!itemId.startsWith(ITEM_ID_PREFIX)) return null;
      const nodeId = itemId.slice(ITEM_ID_PREFIX.length);
      if (!NodeIdSchema.safeParse(nodeId).success) return null;
      const node = await findOpenDecision(
        { store: storeFor(ctx.tenantId), spaceId: ctx.spaceId },
        nodeId,
      );
      return node ? toItem(node) : null;
    },

    async resolve(
      ctx: ActionCenterContext,
      item: ActionCenterSourceItem,
      resolution,
      observed?: ActionCenterItemOrigin,
    ): Promise<ActionCenterResolveOutcome> {
      if (item.origin.type !== 'plan_decision') {
        throw new ActionCenterResolveError(
          'INVALID_RESOLUTION',
          `The plan decision source cannot resolve a ${item.origin.type} item.`,
        );
      }
      // The answer is a write to the plan, so it is taken from the operator
      // alone — the rule the plan page's write reads (planWriteAuthority).
      if (ctx.actorIsInteractiveUser !== true) {
        throw new ActionCenterResolveError('FORBIDDEN', PLAN_WRITE_OPERATOR_ONLY);
      }
      // `item` was re-read for this call; the revision the operator answered
      // is the one they observed, and the write is compare-and-set on it.
      if (observed?.type !== 'plan_decision' || observed.nodeId !== item.origin.nodeId) {
        throw new ActionCenterResolveError(
          'INVALID_RESOLUTION',
          'A decision is answered against the revision it was shown at: send the item’s origin as it was read.',
        );
      }
      const answer = resolution.kind === 'submit' ? resolution.payload : undefined;
      if (typeof answer !== 'string' || answer.trim().length === 0) {
        throw new ActionCenterResolveError(
          'INVALID_RESOLUTION',
          'A decision is answered in words: submit the choice as text. It becomes the step’s outcome.',
        );
      }
      if (answer.trim().length > PLAN_NODE_PROSE_MAX_CHARS) {
        throw new ActionCenterResolveError(
          'INVALID_RESOLUTION',
          `A decision holds at most ${String(PLAN_NODE_PROSE_MAX_CHARS)} characters; this one has ${String(answer.trim().length)}.`,
        );
      }

      const store = storeFor(ctx.tenantId);
      const { nodeId, revision } = observed;
      const result = await updatePlanNode(
        {
          store,
          spaceId: ctx.spaceId,
          redis: deps.redis,
          tenantId: ctx.tenantId,
          createdBy: ctx.actorUserId,
          actorKind: 'human',
        },
        { nodeId, expectedRevision: revision, status: 'done', outcome: answer.trim() },
      );
      if (result.ok) {
        await requestResidentWake(
          { redis: deps.redis, schedules: createResidentScheduleStore(deps.db) },
          { tenantId: ctx.tenantId, spaceId: ctx.spaceId, cause: 'node_written' },
        );
        return {
          resolvedAt: result.node.updatedAt,
          dispatchedOperationId: PLAN_NODE_UPDATE_OPERATION_ID,
        };
      }
      if (result.code === 'PLAN_NODE_STALE') {
        const now = await findOpenDecision({ store, spaceId: ctx.spaceId }, nodeId);
        throw new ActionCenterResolveError(
          'STALE_ACTION_CENTER_ITEM',
          now
            ? `This decision is at revision ${String(now.revision)}; the answer was given to revision ${String(revision)}, so nothing was written. Read it again before answering.`
            : 'This decision has been closed since it was shown, so the answer was not recorded.',
          'stale_target',
          undefined,
          now ? toItem(now) : undefined,
        );
      }
      if (result.code === 'PLAN_NODE_NOT_FOUND') {
        throw new ActionCenterResolveError(
          'NOT_FOUND',
          'This decision is not in the space’s plan any more.',
        );
      }
      throw new ActionCenterResolveError('INVALID_RESOLUTION', result.message);
    },
  };
}

function toItem(node: PlanNode): ActionCenterSourceItem {
  return {
    id: `${ITEM_ID_PREFIX}${node.nodeId}`,
    spaceId: node.spaceId,
    kind: 'human_input',
    origin: { type: 'plan_decision', nodeId: node.nodeId, revision: node.revision },
    title: planItemTitle('decide', node.title),
    summary: planItemSummary(`${node.goal}\n\nDecided when: ${node.criteria}`),
    uiHints: { mode: 'textarea', submitLabel: 'Decide' },
    resolutionSchema: {
      type: 'string',
      minLength: 1,
      maxLength: PLAN_NODE_PROSE_MAX_CHARS,
      description: "Your choice, recorded as the plan step's outcome.",
    },
    requestedAt: node.createdAt,
    requestedBy: { kind: 'agent', label: 'Helmsman · plan' },
    priority: node.status === 'blocked' ? 'high' : 'normal',
    relatesTo: [],
    resolverAuthority: { kind: 'space' },
    status: 'open',
  };
}
