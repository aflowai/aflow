/**
 * The plan engine (Plan 322 D7): the one authority over `plan_nodes`. The
 * orchestrator's `plan.node.*` inline ops call it, and so will the operator's
 * routes; each maps `{ ok: false, code, message, details }` onto its own
 * surface. Every write bumps the space's attention generation, so the next
 * turn of any session in the space reads the tree as it now stands.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { readMergedPullRequest } from './mergedPullRequest.js';
import type { Redis } from 'ioredis';
import {
  isClosedPlanNodeStatus,
  planNodeInstructions,
  planNodeOperatorLine,
  PLAN_NODE_APPROVED_HEAD,
  PLAN_NODE_MERGE_WAIT_LINE,
  PLAN_NODE_CHILDREN_LIMIT,
  PLAN_NODE_CONVERSATION_LINK_LABEL,
  PLAN_NODE_REVISE_HEAD,
  PLAN_NODE_DEPENDENCIES_LIMIT,
  PLAN_NODE_LEARNINGS_LIMIT,
  PLAN_NODE_LINKS_LIMIT,
  PLAN_NODE_LIST_DEFAULT_LIMIT,
  PLAN_LANE_ITEM_RUNS_LIMIT,
  PLAN_OPEN_DECISIONS_LIMIT,
  PLAN_NODE_RUNS_LIMIT,
  PLAN_NODE_PROSE_MAX_CHARS,
  PLAN_TREE_DEPTH_LIMIT,
  PLAN_TREE_WALK_NODE_LIMIT,
  OPEN_PLAN_NODE_STATUSES,
  PLAN_NODE_LIVE_CHECK_HEAD,
  PLAN_NODE_PROPOSED_HEAD,
  PLAN_NODE_ASK_HEAD,
  planNodeCardInOrder,
  planNodeCreatedStatus,
  type CoachLearning,
  type PlanNode,
  type PlanNodeCreateInput,
  type PlanNodeDependency,
  type PlanNodeDependInput,
  type PlanNodeLearnInput,
  type PlanNodeLearning,
  type PlanNodeDetailOutput,
  type PlanNodeDetailQuery,
  type PlanNodeGetOutput,
  type PlanNodeLink,
  type PlanNodeLinkInput,
  type PlanNodeLiveCheck,
  type PlanNodeListInput,
  type PlanNodeListOutput,
  type PlanNodeOpen,
  type PlanNodePlaceRefusalDetails,
  type PlanNodeRevise,
  type PlanNodeRefusalDetails,
  type PlanNodeStatus,
  type PlanNodeSummary,
  type PlanNodeUpdateInput,
  type PlanBoardOutput,
  type PlanLaneItem,
  type PlanOverviewOutput,
} from '@aflow/schemas';
import { isFindingsCarrier } from './carrier.js';
import { askedRevision, claimAsk, isAsked } from './asks.js';
import { logCyberneticError } from '../logger.js';
import { publishActionCenterWake } from '@aflow/redis';
import { bumpAttentionGeneration } from '../attentionCache.js';
import { emitPlanUpdated } from '../entityEvents.js';
import { findPlanRoots, orderPlanTree, type PlanTreeWalkBounds } from './tree.js';
import {
  buildPlanBoard,
  buildPlanOverview,
  cardPullRequest,
  decodePlanLinkCursor,
  encodePlanLinkCursor,
  type PlanBoardOptions,
} from './board.js';
import type { PlanNodePatch, PlanNodeStore } from './store.js';
import type { PlanPlaceAnchor } from './placement.js';
import { carrierNode, PLAN_CARRIER_FINDINGS_LIMIT } from './carrier.js';
import {
  notFound,
  openHasNoOutcome,
  operatorNoteTooLong,
  placementRefusal,
  refusalDetails,
  reopenedNote,
  reopenedNoteTooLong,
  sameColumn,
  stale,
  unchanged,
} from './refusals.js';

/** How far any read of a space's plan walks the tree. */
export const PLAN_TREE_WALK_BOUNDS: PlanTreeWalkBounds = {
  maxDepth: PLAN_TREE_DEPTH_LIMIT,
  maxNodes: PLAN_TREE_WALK_NODE_LIMIT,
};

export type PlanOpErrorCode =
  | 'PLAN_NODE_NOT_FOUND'
  | 'PLAN_NODE_STALE'
  | 'PLAN_NODE_CYCLE'
  | 'PLAN_NODE_TOO_DEEP'
  | 'PLAN_NODE_OPEN_HAS_NO_OUTCOME'
  | 'PLAN_NODE_UNCHANGED'
  | 'PLAN_NODE_PLACE_STALE'
  | 'PLAN_NODE_NOTE_TOO_LONG'
  | 'PLAN_NODE_LINK_EXISTS'
  | 'PLAN_LINK_CURSOR_INVALID'
  | 'PLAN_LIST_CURSOR_INVALID'
  | 'PLAN_LIST_CURSOR_STALE'
  | 'PLAN_NODE_DEPENDENCY_CYCLE'
  | 'PLAN_NODE_DEPENDENCY_WALK_LIMIT'
  | 'PLAN_NODE_ATTESTATION_UNAVAILABLE'
  | 'PLAN_NODE_RESIDENT_SCOPE'
  | 'PLAN_NODE_LIVE_CHECK_PERSON'
  | 'PLAN_LEARNING_NOT_FOUND';

export interface PlanOpError {
  ok: false;
  code: PlanOpErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type PlanOpResult<T> = ({ ok: true } & T) | PlanOpError;

export interface PlanReadContext {
  store: PlanNodeStore;
  spaceId: string;
}

export interface PlanWriteContext extends PlanReadContext {
  redis: Redis;
  tenantId: string;
  /** The user behind the writing session; recorded as `created_by` on a new node. */
  createdBy?: string;
  /** The writer's authority, never the person who started an agent's session. */
  actorKind?: 'human' | 'agent';
  /**
   * The operator's conversation writing, where the writer is one (Plan 337
   * P4): an update it lands links it on the node as a `session` link.
   */
  conversationId?: string;
  /**
   * The writer is a resident wake (Plan 331 D5): it proposes new work, created
   * blocked, and never moves a blocked node on — approving scope is a person's.
   */
  resident?: boolean;
  readMergedPullRequest?: (url: string, nodeId: string) => ReturnType<typeof readMergedPullRequest>;
}

/** The columns a write is judged by; `openedAt` is stamped after, never compared. */
type ComparedPatch = Omit<PlanNodePatch, 'openedAt'>;

function changesNothing(
  current: PlanNode,
  patch: ComparedPatch,
  parentId: string | null | undefined,
): boolean {
  return (
    (parentId === undefined || parentId === current.parentId) &&
    Object.entries(patch).every(([column, value]) =>
      sameColumn(value, current[column as keyof ComparedPatch]),
    )
  );
}

async function written<T>(ctx: PlanWriteContext, value: T): Promise<T> {
  await bumpAttentionGeneration(ctx.redis, ctx.tenantId, ctx.spaceId);
  return value;
}

/**
 * Every committed write of a plan node — and of what is linked to it — returns
 * through here, never a refused one: the attention bump, then the plan page's
 * `entity.plan.updated` (Plan 332 D9). A new node write (P2's open and place)
 * inherits the signal by returning through `nodeWritten` or this.
 */
async function planWritten<T>(
  ctx: PlanWriteContext,
  node: { nodeId: string; revision: number },
  value: T,
): Promise<T> {
  await written(ctx, value);
  await emitPlanUpdated(ctx.redis, {
    tenantId: ctx.tenantId,
    spaceId: ctx.spaceId,
    nodeId: node.nodeId,
    revision: node.revision,
  });
  return value;
}

/**
 * A `decide` node's Action Center item is read from the nodes themselves, so
 * any node write — a decision created, rewritten or closed, or a branch above
 * one closed — can change what the space's Action Center shows.
 */
async function nodeWritten<T extends { node: PlanNode }>(
  ctx: PlanWriteContext,
  value: T,
): Promise<T> {
  publishActionCenterWake(ctx.redis, {
    source: 'plan_node_write',
    tenantId: ctx.tenantId,
    spaceId: ctx.spaceId,
  });
  return planWritten(ctx, value.node, value);
}

// ============================================================================
// plan.node.create
// ============================================================================

/** Plan 331 D8 leaves the folder read with the operator; no automatic reader is scheduled. */
export function liveCheckHead(check: PlanNodeLiveCheck): string {
  const holding =
    check.mergeCommitSha !== undefined
      ? `${check.mergeCommitSha}, the merge of ${check.pullRequest}`
      : `the merge of ${check.pullRequest}`;
  return `${PLAN_NODE_LIVE_CHECK_HEAD}waits on a person to read the connected folder's head holding ${holding} (host.binding.inspect with \`holds\`); the merged step closed on its merge.`;
}

function residentCreates(): PlanOpError {
  return {
    ok: false,
    code: 'PLAN_NODE_RESIDENT_SCOPE',
    message:
      'A resident wake proposes work and never approves its own scope, so nothing was written. Create the node ' +
      'with `proposed` saying why it is worth doing — it is created blocked until a person approves it — or, for ' +
      'a merged node whose criteria need the change running on the stack, with `liveCheck`.',
  };
}

function residentUnblocks(current: PlanNode): PlanOpError {
  return {
    ok: false,
    code: 'PLAN_NODE_RESIDENT_SCOPE',
    message:
      `Plan node "${current.title}" is ${current.status}, and only a person approves, closes or reopens it — Approve on the plan ` +
      'page or in the Action Center. A resident wake writes what the node waits on in its note and leaves its ' +
      'status as it stands; nothing was written.',
    details: { nodeId: current.nodeId, status: current.status },
  };
}

function createdNoteTooLong(noteLength: number): PlanOpError {
  return {
    ok: false,
    code: 'PLAN_NODE_NOTE_TOO_LONG',
    message:
      `A node created blocked has its first line say what it waits on, above the note, which would then hold ` +
      `${String(noteLength)} characters; a note holds at most ${String(PLAN_NODE_PROSE_MAX_CHARS)}, so nothing was ` +
      'written. Pass a shorter `note`, or none.',
    details: { noteLength, noteMaxChars: PLAN_NODE_PROSE_MAX_CHARS },
  };
}

/**
 * A node starts as `planNodeCreatedStatus` says (Plan 339 D6): approved work
 * `active`, and `blocked` only for a proposal (Plan 331 D5), a live check (D8)
 * or a card whose `waitsOn` names the operator's decision. A blocked node's
 * first line says what it waits on. A resident wake writes no `active` node.
 */
export async function createPlanNode(
  ctx: PlanWriteContext,
  input: PlanNodeCreateInput,
): Promise<PlanOpResult<{ node: PlanNode }>> {
  const parentId = input.parentId ?? null;
  const waitsOn = input.card?.waitsOn;
  const head =
    input.proposed !== undefined
      ? `${PLAN_NODE_PROPOSED_HEAD}${input.proposed}`
      : input.liveCheck !== undefined
        ? liveCheckHead(input.liveCheck)
        : waitsOn !== undefined
          ? `${PLAN_NODE_ASK_HEAD}${waitsOn.decision.replace(/\s*\n\s*/g, ' ')}`
          : undefined;
  if (ctx.resident === true && head === undefined) return residentCreates();
  const given = input.note !== undefined && input.note !== '' ? input.note : null;
  const note = head === undefined ? given : given === null ? head : `${head}\n${given}`;
  if (note !== null && note.length > PLAN_NODE_PROSE_MAX_CHARS) {
    return createdNoteTooLong(note.length);
  }
  const inserted = await ctx.store.insert(ctx.spaceId, {
    parentId,
    kind: input.kind,
    title: input.title,
    goal: input.goal,
    criteria: input.criteria,
    note,
    ...(input.card !== undefined ? { card: input.card } : {}),
    ...(input.position !== undefined ? { position: input.position } : {}),
    createdBy: ctx.createdBy ?? null,
    status: planNodeCreatedStatus(input),
  });
  if (inserted.outcome === 'inserted') {
    return nodeWritten(ctx, { ok: true as const, node: inserted.node });
  }
  if (parentId === null) throw new Error('the plan store refused a place to a root');
  return placementRefusal(inserted, null, parentId);
}

// ============================================================================
// plan.node.update — compare-and-set on the node's revision (Plan 322 D6)
// ============================================================================

export interface PlanNodeWritten {
  node: PlanNode;
  carrier?: PlanNode;
  carrierFailure?: string;
  linkFailure?: string;
}

export function updatePlanNode(
  ctx: PlanWriteContext,
  input: PlanNodeUpdateInput,
): Promise<PlanOpResult<PlanNodeWritten>> {
  return writePlanNode(ctx, input, {});
}

/**
 * A node closed done with findings linked to it proposes one carrier under
 * its parent (Plan 331 D6), with the findings it has not already handed on.
 */
async function readCarrierFindings(
  ctx: PlanWriteContext,
  closed: PlanNode,
): Promise<{ findings: PlanNodeLink[]; more: number } | undefined> {
  let page = await ctx.store.pageLinks(ctx.spaceId, closed.nodeId, {
    kind: 'finding',
    limit: PLAN_CARRIER_FINDINGS_LIMIT,
  });
  if (page.links.length === 0) return undefined;
  const since = await ctx.store.latestCarrierAt(ctx.spaceId, closed.nodeId);
  const findings: PlanNodeLink[] = [];
  let uncarried = 0;
  for (;;) {
    const fresh = page.links.filter(
      (link) => since === null || Date.parse(link.createdAt) > Date.parse(since),
    );
    uncarried += fresh.length;
    findings.push(...fresh.slice(0, PLAN_CARRIER_FINDINGS_LIMIT - findings.length));
    if (page.next === undefined) break;
    page = await ctx.store.pageLinks(ctx.spaceId, closed.nodeId, {
      kind: 'finding',
      limit: PLAN_CARRIER_FINDINGS_LIMIT,
      after: page.next,
    });
  }
  if (findings.length === 0) return undefined;
  return { findings, more: uncarried - findings.length };
}

async function proposeCarrier(
  ctx: PlanWriteContext,
  closed: PlanNode,
): Promise<PlanNode | undefined> {
  // A carrier read must not turn a committed close into a failed write.
  const read = await readCarrierFindings(ctx, closed);
  if (!read) return undefined;
  const { findings, more } = read;
  const inserted = await ctx.store.insert(ctx.spaceId, {
    ...carrierNode(closed, findings, more, { resident: ctx.resident === true }),
    createdBy: ctx.createdBy ?? null,
  });
  // The parent the closed node sat under is gone since its close: there is nowhere to propose it.
  if (inserted.outcome !== 'inserted')
    throw new Error('Carrier placement refused: ' + inserted.outcome);
  await nodeWritten(ctx, { node: inserted.node });
  return inserted.node;
}

/**
 * A resident write that answers the operator's Revise (Plan 337 P4) may
 * rewrite the proposal's goal and criteria, and no other resident write may.
 * It holds only while the node is blocked under the `Revise: …` line and still
 * at the revision the Revise was recorded at, so the rewrite lands once.
 * The rule above it keeps the node blocked.
 */
async function answersRevise(ctx: PlanWriteContext, current: PlanNode): Promise<boolean> {
  if (
    current.status !== 'blocked' ||
    planNodeInstructions(current.note)?.startsWith(PLAN_NODE_REVISE_HEAD) !== true
  ) {
    return false;
  }
  const sentAt = await ctx.redis.get(planNodeReviseKey(ctx, current.nodeId));
  return sentAt === String(current.revision);
}

/**
 * Links the operator's conversation on a node its update landed on. The
 * update has committed, so a failed link is reported beside it, never as a
 * failed write. A link leaves the revision where it stands, so the writer's
 * next update against the revision it was just given is not refused as stale.
 * A conversation already linked stays linked once.
 */
async function linkConversation(
  ctx: PlanWriteContext,
  node: PlanNode,
): Promise<string | undefined> {
  if (ctx.conversationId === undefined) return undefined;
  try {
    await ctx.store.insertLink(ctx.spaceId, {
      nodeId: node.nodeId,
      kind: 'session',
      ref: ctx.conversationId,
      label: PLAN_NODE_CONVERSATION_LINK_LABEL,
    });
    return undefined;
  } catch (error) {
    logCyberneticError('Conversation link failed after a plan node update landed.', error, {
      spaceId: ctx.spaceId,
      nodeId: node.nodeId,
      conversationId: ctx.conversationId,
    });
    return `The update landed at revision ${String(node.revision)}, but this conversation was not linked on node ${node.nodeId}. Link it with plan.node.link, kind "session", if the operator needs to find it from the node.`;
  }
}

async function writePlanNode(
  ctx: PlanWriteContext,
  input: PlanNodeUpdateInput,
  stamp: Pick<PlanNodePatch, 'openedAt' | 'spendCents'>,
): Promise<PlanOpResult<PlanNodeWritten>> {
  const current = await ctx.store.find(ctx.spaceId, input.nodeId);
  if (!current) return notFound(input.nodeId);
  if (current.revision !== input.expectedRevision) return stale(current, input);
  // The refusals below judge `current`, and the write lands only on its
  // revision: a node changed since this read is refused as stale instead.
  const status = input.status ?? current.status;
  if (input.outcome !== undefined && !isClosedPlanNodeStatus(status)) {
    return openHasNoOutcome(current, status);
  }
  if (
    ctx.resident === true &&
    (current.status === 'blocked' || isClosedPlanNodeStatus(current.status)) &&
    (input.status !== undefined || input.outcome !== undefined) &&
    !(current.status === 'blocked' && status === 'blocked' && input.outcome === undefined)
  ) {
    return residentUnblocks(current);
  }

  // The card follows the goal and criteria (Plan 337 D4): a resident rewrites it only answering a Revise.
  const rewritesProposal =
    input.goal !== undefined || input.criteria !== undefined || input.card !== undefined;
  if (
    ctx.resident === true &&
    (input.title !== undefined ||
      (rewritesProposal && !(await answersRevise(ctx, current))) ||
      input.parentId !== undefined ||
      input.position !== undefined ||
      input.status === 'dropped' ||
      (input.status === 'done' &&
        (current.note?.includes(PLAN_NODE_LIVE_CHECK_HEAD) ||
          current.note?.split('\n').some(isFindingsCarrier))))
  )
    return residentUnblocks(current);
  if (
    ctx.actorKind !== 'human' &&
    current.note?.includes(PLAN_NODE_LIVE_CHECK_HEAD) &&
    (input.status !== undefined || input.outcome !== undefined || input.note !== undefined)
  ) {
    return {
      ok: false,
      code: 'PLAN_NODE_LIVE_CHECK_PERSON',
      message:
        'Only a person may attest the folder-head read or complete this live check. Nothing was written.',
      details: { nodeId: current.nodeId },
    };
  }

  const pullRequest =
    ctx.resident === true && input.status === 'done'
      ? await ctx.store.newestLink(ctx.spaceId, current.nodeId, 'pull_request')
      : null;
  if (ctx.resident === true && input.status === 'done') {
    let attestation = {
      merged: false,
      reason: 'No pull request is linked to this step.',
      evidence:
        'Pull request: not linked\nMerge commit: not reported\nMerged by: not reported\nMerged at: not reported\nMerge delivers recorded commit or branch: not attested',
    };
    try {
      if (pullRequest !== null && !ctx.readMergedPullRequest)
        throw new Error('Merge attestation reader unavailable');
      if (pullRequest !== null && ctx.readMergedPullRequest)
        attestation = await ctx.readMergedPullRequest(pullRequest.ref, current.nodeId);
    } catch {
      return {
        ok: false,
        code: 'PLAN_NODE_ATTESTATION_UNAVAILABLE',
        message:
          'GitHub merge attestation failed. Leave this node open and retry the close on a later wake.',
        details: { nodeId: current.nodeId },
      };
    }
    if (!attestation.merged) {
      let waiting = current;
      const line = `${PLAN_NODE_MERGE_WAIT_LINE} ${attestation.reason}\n\n${attestation.evidence}`;
      const previous = current.note?.indexOf(PLAN_NODE_MERGE_WAIT_LINE) ?? -1;
      const context = previous >= 0 ? current.note!.slice(0, previous).trimEnd() : current.note;
      const note = context ? `${context}\n${line}` : line;
      if (!current.note?.includes(line)) {
        const updated = await ctx.store.updateAtRevision(
          ctx.spaceId,
          current.nodeId,
          current.revision,
          {
            note:
              note.length <= PLAN_NODE_PROSE_MAX_CHARS
                ? note
                : `${line}\n${context ?? ''}`.slice(0, PLAN_NODE_PROSE_MAX_CHARS),
          },
        );
        if (!updated) return stale(current, input);
        waiting = updated;
        await nodeWritten(ctx, { node: waiting });
      }
      const record = await askedRevision(ctx, waiting.nodeId);
      if (!isAsked(waiting, record)) await claimAsk(ctx, waiting, record, false);
      return {
        ok: false,
        code: 'PLAN_NODE_RESIDENT_SCOPE',
        message:
          'This scheduled close requires a linked pull request GitHub reports merged at close time, delivering this node’s recorded work. The node waits on a person.',
        details: { nodeId: current.nodeId },
      };
    }
  }
  const patch: PlanNodePatch = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.goal !== undefined) patch.goal = input.goal;
  if (input.criteria !== undefined) patch.criteria = input.criteria;
  if (input.note !== undefined) patch.note = input.note === '' ? null : input.note;
  if (input.outcome !== undefined) patch.outcome = input.outcome;
  if (input.card !== undefined) patch.card = planNodeCardInOrder(input.card);
  if (input.position !== undefined) patch.position = input.position;

  if (input.status !== undefined) {
    patch.status = input.status;
    if (!isClosedPlanNodeStatus(input.status)) {
      patch.closedAt = null;
      if (isClosedPlanNodeStatus(current.status)) {
        const note = reopenedNote(current, patch.note);
        if (typeof note === 'string' && note.length > PLAN_NODE_PROSE_MAX_CHARS) {
          return reopenedNoteTooLong(current, note.length);
        }
        if (note !== undefined) patch.note = note;
        patch.outcome = null;
      }
    } else if (current.closedAt === undefined) patch.closedAt = new Date();
  }

  if (
    ctx.actorKind === 'human' &&
    input.status === 'active' &&
    current.status === 'blocked' &&
    current.note?.includes(PLAN_NODE_LIVE_CHECK_HEAD)
  ) {
    patch.status = 'done';
    patch.closedAt = new Date();
    patch.outcome =
      "The operator approved the live check after reading the connected folder's head holding the merge.";
  }

  const parentId = input.parentId;
  if (changesNothing(current, patch, parentId)) return unchanged(current, input);
  Object.assign(patch, stamp);
  let node: PlanNode | null;
  if (parentId !== undefined && parentId !== current.parentId) {
    const move = await ctx.store.moveAtRevision(
      ctx.spaceId,
      input.nodeId,
      input.expectedRevision,
      parentId,
      patch,
    );
    if (move.outcome === 'moved') node = move.node;
    else if (move.outcome === 'stale') node = null;
    else if (parentId === null) throw new Error('the plan store refused a move to the root');
    else return placementRefusal(move, input.nodeId, parentId);
  } else {
    node = await ctx.store.updateAtRevision(
      ctx.spaceId,
      input.nodeId,
      input.expectedRevision,
      patch,
    );
  }
  if (!node) {
    // Another session wrote between the read and this write.
    const now = await ctx.store.find(ctx.spaceId, input.nodeId);
    return now ? stale(now, input) : notFound(input.nodeId);
  }
  const linkFailure = await linkConversation(ctx, node);
  const written = await nodeWritten(ctx, {
    ok: true as const,
    node,
    ...(linkFailure !== undefined ? { linkFailure } : {}),
  });
  if (isClosedPlanNodeStatus(current.status) || node.status !== 'done') return written;
  try {
    const carrier = await proposeCarrier(ctx, node);
    return carrier !== undefined ? { ...written, carrier } : written;
  } catch (error) {
    logCyberneticError(
      'Carrier failed after close. Recover the findings linked to the closed node before proposing further work.',
      error,
      {
        spaceId: ctx.spaceId,
        nodeId: node.nodeId,
        findings: { nodeId: node.nodeId, kind: 'finding' },
      },
    );
    return {
      ...written,
      carrierFailure: `Carrier failed for closed node ${node.nodeId}. Read its linked findings and create a step that carries them.`,
    };
  }
}

// ============================================================================
// The operator's open and place (Plan 332 D6)
// ============================================================================

export type PlanNodeOpenRequest = PlanNodeOpen & { nodeId: string };

/**
 * Moves a `blocked`, `done` or `dropped` node to `active` through
 * `updatePlanNode`, so it is judged and written as every update is. On a
 * blocked live check approval closes it with the person's folder-head read. On
 * other blocked nodes `why` goes above the note as one `Approved: …` line, its
 * first line, which the next brief opens with (`planNodeInstructions`). On
 * a closed node the update's reopen rule (`reopenedNote`) heads the note with
 * what the node claimed; a `why` follows as `Reopened: …` in place of the
 * prior note, which describes work the reopen declares unfinished, and no
 * `why` keeps that note under the engine's line.
 */
export async function openPlanNode(
  ctx: PlanWriteContext,
  request: PlanNodeOpenRequest,
): Promise<
  PlanOpResult<{
    node: PlanNode;
    from: PlanNodeStatus;
    carrier?: PlanNode;
    carrierFailure?: string;
  }>
> {
  const update: PlanNodeUpdateInput = {
    nodeId: request.nodeId,
    expectedRevision: request.expectedRevision,
    status: 'active',
  };
  const current = await ctx.store.find(ctx.spaceId, request.nodeId);
  if (!current) return notFound(request.nodeId);
  if (current.revision !== request.expectedRevision) return stale(current, update);
  if (current.status === 'active' || current.status === 'waiting') {
    return {
      ok: false,
      code: 'PLAN_NODE_UNCHANGED',
      message:
        `Plan node "${current.title}" is ${current.status}, not blocked, done or dropped, so there is nothing ` +
        `to approve or reopen and nothing was written; it stays at revision ${String(current.revision)}.`,
      details: refusalDetails(current, update),
    };
  }
  if (request.why !== undefined) {
    if (current.status === 'blocked') {
      const note = headedNote(
        planNodeOperatorLine(PLAN_NODE_APPROVED_HEAD, request.why),
        current.note,
      );
      if (note.length > PLAN_NODE_PROSE_MAX_CHARS) {
        return operatorNoteTooLong(current, note.length, 'Approving');
      }
      update.note = note;
    } else {
      update.note = `Reopened: ${request.why}`;
    }
  }
  if (isClosedPlanNodeStatus(current.status) && current.note?.includes(PLAN_NODE_LIVE_CHECK_HEAD)) {
    update.status = 'blocked';
    update.note = `${request.why !== undefined ? `Reopened: ${request.why}\n` : ''}${current.note}`;
  }
  const written = await writePlanNode(ctx, update, {
    openedAt: new Date(),
    ...(request.spendCents !== undefined ? { spendCents: request.spendCents } : {}),
  });
  return written.ok ? { ...written, from: current.status } : written;
}

/** The operator's line above the note as it stands. */
function headedNote(line: string, note: string | undefined): string {
  return note !== undefined ? `${line}\n${note}` : line;
}

export type PlanNodeReviseRequest = PlanNodeRevise & { nodeId: string };

/**
 * Sends a `blocked` node back for revision (Plan 337 P4) through
 * `updatePlanNode`: the status stays blocked, and `why` goes above the note as
 * one `Revise: …` line. The write moves the revision like any other, which is
 * what re-arms a rule keyed on it. The Helmsman rewrites the node from that
 * line, a resident wake only at the revision recorded here (`answersRevise`).
 */
export async function revisePlanNode(
  ctx: PlanWriteContext,
  request: PlanNodeReviseRequest,
): Promise<PlanOpResult<{ node: PlanNode }>> {
  const current = await ctx.store.find(ctx.spaceId, request.nodeId);
  if (!current) return notFound(request.nodeId);
  const note = headedNote(planNodeOperatorLine(PLAN_NODE_REVISE_HEAD, request.why), current.note);
  const update: PlanNodeUpdateInput = {
    nodeId: request.nodeId,
    expectedRevision: request.expectedRevision,
    note,
  };
  if (current.revision !== request.expectedRevision) return stale(current, update);
  if (current.status !== 'blocked') {
    return {
      ok: false,
      code: 'PLAN_NODE_UNCHANGED',
      message:
        `Plan node "${current.title}" is ${current.status}, not blocked, so there is no proposal to send back ` +
        `and nothing was written; it stays at revision ${String(current.revision)}.`,
      details: refusalDetails(current, update),
    };
  }
  if (note.length > PLAN_NODE_PROSE_MAX_CHARS) {
    return operatorNoteTooLong(current, note.length, 'Sending back');
  }
  const written = await writePlanNode(ctx, update, {});
  if (written.ok) {
    await ctx.redis.set(
      planNodeReviseKey(ctx, written.node.nodeId),
      String(written.node.revision),
      'PX',
      PLAN_NODE_REVISE_RECORD_TTL_MS,
    );
  }
  return written;
}

/**
 * How long the revision a node was sent back at is kept. A record that lapses
 * is written again by the next firing that asks, so the bound still holds.
 */
export const PLAN_NODE_REVISE_RECORD_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * Where the revision a node was sent back at is kept. A write past it that
 * leaves the `Revise: …` line in place is a rewrite the line survived.
 */
export function planNodeReviseKey(
  ctx: { tenantId: string; spaceId: string },
  nodeId: string,
): string {
  return ['plan:node:revise', ctx.tenantId, ctx.spaceId, nodeId].join(':');
}

export type PlanNodePlaceRequest = {
  nodeId: string;
  expectedRevision: number;
} & PlanPlaceAnchor;

/**
 * Puts a node directly before or after a sibling — roots among roots — against
 * the revision the operator read. A sibling that moved away is refused with
 * the siblings as they stand; the node's revision moves, a renumbered
 * sibling's never does.
 */
export async function placePlanNode(
  ctx: PlanWriteContext,
  request: PlanNodePlaceRequest,
): Promise<PlanOpResult<{ node: PlanNode }>> {
  const { nodeId, expectedRevision } = request;
  const anchor: PlanPlaceAnchor =
    'before' in request ? { before: request.before } : { after: request.after };
  const placed = await ctx.store.placeAtRevision(ctx.spaceId, nodeId, expectedRevision, anchor);
  const asked: PlanNodeUpdateInput = { nodeId, expectedRevision };
  switch (placed.outcome) {
    case 'not_found':
      return notFound(nodeId);
    case 'stale':
      return stale(placed.node, asked);
    case 'unchanged':
      return {
        ok: false,
        code: 'PLAN_NODE_UNCHANGED',
        message: `Plan node "${placed.node.title}" already stands there among its siblings, so nothing was written.`,
        details: refusalDetails(placed.node, asked),
      };
    case 'not_sibling': {
      const anchorId = 'before' in anchor ? anchor.before : anchor.after;
      const details: PlanNodePlaceRefusalDetails = { nodeId, siblings: placed.siblings };
      return {
        ok: false,
        code: 'PLAN_NODE_PLACE_STALE',
        message:
          `Plan node "${anchorId}" is not a sibling of "${nodeId}" any more, so nothing was written. ` +
          'error.details.siblings is their order as it now stands.',
        details,
      };
    }
    case 'placed':
      return nodeWritten(ctx, { ok: true as const, node: placed.node });
  }
}

// ============================================================================
// plan.node.get / plan.node.list
// ============================================================================

export async function getPlanNode(
  ctx: PlanReadContext,
  nodeId: string,
): Promise<PlanOpResult<PlanNodeGetOutput>> {
  // The rail's read without its placement, its first page of every link kind,
  // and what a session needs beyond it: what the node waits on and what was
  // learned above it.
  const detail = await readPlanNode(
    ctx,
    nodeId,
    { limit: PLAN_NODE_LINKS_LIMIT },
    { placement: false },
  );
  if (!detail.ok) return detail;
  const { nextCursor: _nextCursor, ok: _ok, ...read } = detail;
  const [dependencies, dependents, learnings] = await Promise.all([
    ctx.store.listDependencies(ctx.spaceId, nodeId, PLAN_NODE_DEPENDENCIES_LIMIT),
    ctx.store.listDependents(ctx.spaceId, nodeId, PLAN_NODE_DEPENDENCIES_LIMIT),
    lineageOf(ctx, read.node).then((lineage) =>
      ctx.store.listLearningsOf(ctx.spaceId, lineage, PLAN_NODE_LEARNINGS_LIMIT),
    ),
  ]);
  return {
    ok: true,
    ...read,
    dependencies: dependencies.dependencies,
    dependenciesTotal: dependencies.total,
    dependents: dependents.dependents,
    dependentsTotal: dependents.total,
    learnings: learnings.learnings.map(planNodeLearning),
    learningsTotal: learnings.total,
  };
}

/**
 * The node and every node above it, nearest first: a learning written on a
 * stream's root is about every node under it.
 */
async function lineageOf(ctx: PlanReadContext, node: PlanNode): Promise<string[]> {
  const lineage = [node.nodeId];
  let parentId = node.parentId;
  for (let depth = 0; parentId !== null && depth < PLAN_TREE_DEPTH_LIMIT; depth++) {
    lineage.push(parentId);
    const parents = await ctx.store.parentsOf(ctx.spaceId, [parentId]);
    parentId = parents.get(parentId) ?? null;
  }
  return lineage;
}

/** A plan-scope learning as a node's read shows it. */
function planNodeLearning(learning: CoachLearning): PlanNodeLearning {
  if (learning.scope.kind !== 'plan')
    throw new Error('a node read met a learning of another scope');
  return {
    learningId: learning.learningId,
    nodeId: learning.scope.planNodeId,
    kind: learning.kind,
    statement: learning.statement,
    confidence: learning.confidence,
    runIds: [...new Set(learning.evidence.citations.map((c) => c.runId))],
    createdAt: learning.createdAt,
  };
}

/**
 * What a page of `plan.node.list` read, as a digest: the input's filter and
 * every matching node in order with what places it. Every page re-walks the
 * tree, so a later page is the earlier one's continuation only while this is
 * unchanged — a node created, closed, reopened or moved in between shifts
 * every position after it.
 */
function planListView(
  statuses: ReadonlySet<PlanNodeStatus>,
  rootId: string | undefined,
  matching: readonly PlanNodeSummary[],
): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([[...statuses].sort(), rootId ?? null]));
  for (const node of matching) {
    hash.update(
      `\n${node.nodeId}|${String(node.revision)}|${node.status}|${node.parentId ?? ''}|${String(node.position)}`,
    );
  }
  return hash.digest('base64url').slice(0, 22);
}

interface PlanListCursor {
  offset: number;
  view: string;
}

function encodePlanListCursor(cursor: PlanListCursor): string {
  return Buffer.from(JSON.stringify([cursor.offset, cursor.view]), 'utf8').toString('base64url');
}

function decodePlanListCursor(cursor: string): PlanListCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [offset, view] = parsed as unknown[];
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 1) return null;
    return typeof view === 'string' && view.length > 0 ? { offset, view } : null;
  } catch {
    return null;
  }
}

export async function listPlanNodes(
  ctx: PlanReadContext,
  input: Partial<PlanNodeListInput>,
): Promise<PlanOpResult<PlanNodeListOutput>> {
  const statuses = new Set(input.status ?? OPEN_PLAN_NODE_STATUSES);
  const limit = input.limit ?? PLAN_NODE_LIST_DEFAULT_LIMIT;
  const cursor = input.cursor !== undefined ? decodePlanListCursor(input.cursor) : undefined;
  if (cursor === null) {
    return {
      ok: false,
      code: 'PLAN_LIST_CURSOR_INVALID',
      message:
        'This cursor was not issued by plan.node.list: pass the `truncated.next.cursor` of the page before, or none for the first page.',
    };
  }

  const start = input.rootId !== undefined ? { rootId: input.rootId } : {};
  if (start.rootId !== undefined && !(await ctx.store.find(ctx.spaceId, start.rootId))) {
    return notFound(start.rootId, 'root');
  }
  // A list of open nodes walks through open nodes only, so the walk's node
  // ceiling counts what the caller is shown rather than closed history. A
  // named root is read whatever its status, so a closed one lists the open
  // work under it, and is itself listed only if its status was asked for.
  const openOnly = [...statuses].every((status) => !isClosedPlanNodeStatus(status));
  const walk = await ctx.store.walk(ctx.spaceId, {
    ...start,
    ...(openOnly ? { statuses: OPEN_PLAN_NODE_STATUSES } : {}),
    ...PLAN_TREE_WALK_BOUNDS,
  });
  const matching = orderPlanTree(walk.nodes, start)
    .map((placed) => placed.node)
    .filter((node) => statuses.has(node.status));

  const view = planListView(statuses, input.rootId, matching);
  if (cursor !== undefined && cursor.view !== view) {
    return {
      ok: false,
      code: 'PLAN_LIST_CURSOR_STALE',
      message:
        'The plan changed since the page this cursor came from: a node was created, closed, reopened or moved, ' +
        'or this list names another `status` or `rootId`. Its next page would skip or repeat nodes, so none was ' +
        'returned. List again without `cursor` to read the plan as it now stands.',
    };
  }
  const offset = cursor?.offset ?? 0;
  const end = offset + limit;
  const pageCut = matching.length > end;
  // A bound the walk met hides nodes whatever `limit` is, so it is the one to name.
  const bound = walk.truncated ?? (pageCut ? { bound: 'limit' as const, value: limit } : undefined);
  return {
    ok: true,
    nodes: matching.slice(offset, end),
    ...(bound !== undefined
      ? {
          truncated: {
            ...bound,
            matched: matching.length,
            ...(pageCut ? { next: { cursor: encodePlanListCursor({ offset: end, view }) } } : {}),
          },
        }
      : {}),
  };
}

// ============================================================================
// The space's plan as the operator reads it (Plan 322 P3)
// ============================================================================

/**
 * The space's plans as the overview reads them (Plan 332 D7): every root as a
 * row with its state and, open, its steps counted by the board's column rule;
 * and the Needs you, In flight and Up next lanes across every open plan. One
 * recursive read, stopped at the node bound, returns the roots and the open
 * steps and counts the closed ones, so the rows and the lanes agree on which
 * plans are open and no done step is read as a row. The lanes' rows are
 * looked up in the same snapshot — their newest pull requests, and the runs
 * on the In flight rows — so a row's `runsTotal` and its `runs` agree.
 */
export async function readPlanOverview(ctx: PlanReadContext): Promise<PlanOverviewOutput> {
  const {
    placed: overview,
    pullRequests,
    runs,
  } = await ctx.store.readOverview(ctx.spaceId, PLAN_TREE_WALK_BOUNDS, (read) => {
    const placed = buildPlanOverview(read, PLAN_TREE_WALK_BOUNDS);
    const { needsYou, inFlight, upNext } = placed.lanes;
    const shown = [...needsYou.items, ...inFlight.items, ...upNext.items];
    return {
      placed,
      pullRequestsOf: [...new Set(shown.map((item) => item.nodeId))],
      runsOf: inFlight.items.filter((item) => (item.runsTotal ?? 0) > 0).map((item) => item.nodeId),
      runsPerNode: PLAN_LANE_ITEM_RUNS_LIMIT,
    };
  });
  const { needsYou, inFlight, upNext } = overview.lanes;
  const decorate = (item: PlanLaneItem): PlanLaneItem => {
    const pullRequest = pullRequests.get(item.nodeId);
    const onIt = runs.get(item.nodeId);
    return {
      ...item,
      ...(pullRequest !== undefined ? { pullRequest: cardPullRequest(pullRequest) } : {}),
      ...(item.runs !== undefined && onIt !== undefined ? { runs: onIt } : {}),
    };
  };
  return {
    ...overview,
    lanes: {
      ...overview.lanes,
      needsYou: { ...needsYou, items: needsYou.items.map(decorate) },
      inFlight: { ...inFlight, items: inFlight.items.map(decorate) },
      upNext: { ...upNext, items: upNext.items.map(decorate) },
    },
  };
}

/**
 * One plan as the operator's board reads it (P3.3, scoped to one root by Plan
 * 332 D7): the root and every node under it, each with its card's facts —
 * counts, rounds, newest pull request, a parent's progress — and no links or
 * prose, which the node detail reads on demand; the plan's tally; done nodes
 * closed before `closedSince` left out. Only a root is a plan: a step's id is
 * not found here, and no other root's nodes are read.
 */
export async function readPlanBoard(
  ctx: PlanReadContext,
  rootId: string,
  opts: PlanBoardOptions = {},
): Promise<PlanOpResult<PlanBoardOutput>> {
  const found = await ctx.store.find(ctx.spaceId, rootId);
  // Only a root is a plan: a step's id, like an id the space never held, finds none.
  if (found?.parentId !== null) return notFound(rootId, 'root');
  const walk = await ctx.store.walk(ctx.spaceId, { rootId, ...PLAN_TREE_WALK_BOUNDS });
  const placed = orderPlanTree(walk.nodes, { rootId });
  const nodeIds = placed.map((p) => p.node.nodeId);
  const [facts, tallies, pullRequests, inFlight] = await Promise.all([
    ctx.store.boardFactsOf(ctx.spaceId, nodeIds),
    ctx.store.linkTalliesOf(ctx.spaceId, nodeIds),
    ctx.store.newestPullRequestsOf(ctx.spaceId, nodeIds),
    ctx.store.inFlightRunCountsOf(ctx.spaceId, nodeIds),
  ]);
  const board = buildPlanBoard(placed, { facts, tallies, pullRequests, inFlight }, opts);
  const root = board.roots[0];
  const tally = board.tallies[0];
  // Deleted between the find and the walk.
  if (root === undefined || tally === undefined) return notFound(rootId, 'root');
  return {
    ok: true,
    root,
    tally,
    ...(walk.truncated !== undefined ? { truncated: walk.truncated } : {}),
  };
}

/**
 * One node for the board's rail: in full, its children, a page of its links
 * — of one kind and label where `linkKind` and `linkLabel` name them — the runs in flight for it and
 * every node under it, and its activity and closed ancestor as the board
 * derives them.
 */
export async function readPlanNodeDetail(
  ctx: PlanReadContext,
  nodeId: string,
  page: PlanNodeDetailQuery,
): Promise<PlanOpResult<PlanNodeDetailOutput>> {
  return readPlanNode(ctx, nodeId, page, { placement: true });
}

/** What a node's read carries beyond the node and its pages, where the caller asks. */
interface PlanNodeReadExtras {
  /**
   * The node's activity and its closed ancestor, as the board places it: the
   * rail's, read over the whole subtree and the node's ancestors. A session's
   * `plan.node.get` and the stream's own read of its node show neither.
   */
  placement: boolean;
}

type PlanNodeRead = Omit<PlanNodeDetailOutput, 'activity' | 'closedAncestor'> &
  Partial<Pick<PlanNodeDetailOutput, 'activity' | 'closedAncestor'>>;

async function readPlanNode(
  ctx: PlanReadContext,
  nodeId: string,
  page: PlanNodeDetailQuery,
  extras: { placement: true },
): Promise<PlanOpResult<PlanNodeDetailOutput>>;
async function readPlanNode(
  ctx: PlanReadContext,
  nodeId: string,
  page: PlanNodeDetailQuery,
  extras: PlanNodeReadExtras,
): Promise<PlanOpResult<PlanNodeRead>>;
async function readPlanNode(
  ctx: PlanReadContext,
  nodeId: string,
  page: PlanNodeDetailQuery,
  extras: PlanNodeReadExtras,
): Promise<PlanOpResult<PlanNodeRead>> {
  const after = page.cursor !== undefined ? decodePlanLinkCursor(page.cursor) : undefined;
  if (after === null) {
    return {
      ok: false,
      code: 'PLAN_LINK_CURSOR_INVALID',
      message:
        'This cursor was not issued by this read: pass the `nextCursor` of the page before, or none for the newest page.',
    };
  }
  const node = await ctx.store.find(ctx.spaceId, nodeId);
  if (!node) return notFound(nodeId);
  // Every status: a run in flight for a node closed under it is still in flight.
  const subtree = await ctx.store.walk(ctx.spaceId, { rootId: nodeId, ...PLAN_TREE_WALK_BOUNDS });
  const subtreeIds = subtree.nodes.map((n) => n.nodeId);
  const [children, links, runs, placement] = await Promise.all([
    ctx.store.listChildren(ctx.spaceId, nodeId, PLAN_NODE_CHILDREN_LIMIT),
    ctx.store.pageLinks(ctx.spaceId, nodeId, {
      ...(page.linkKind !== undefined ? { kind: page.linkKind } : {}),
      ...(page.linkLabel !== undefined ? { label: page.linkLabel } : {}),
      ...(after !== undefined ? { after } : {}),
      limit: page.limit,
    }),
    ctx.store.listRunsServing(ctx.spaceId, subtreeIds, PLAN_NODE_RUNS_LIMIT),
    extras.placement
      ? Promise.all([
          ctx.store.closedAncestorOf(ctx.spaceId, nodeId),
          ctx.store.inFlightRunCountsOf(ctx.spaceId, subtreeIds),
        ])
      : undefined,
  ]);
  const read: PlanNodeRead = {
    node,
    children: children.children,
    childrenTotal: children.total,
    links: links.links,
    linksTotal: links.total,
    ...(links.next !== undefined ? { nextCursor: encodePlanLinkCursor(links.next) } : {}),
    runs: runs.runs,
    runsTotal: runs.total,
  };
  if (placement === undefined) return { ok: true, ...read };
  const [closedAncestor, inFlight] = placement;
  // The board's rule: the node's own runs count whatever its status, a run
  // under it only where it serves an active node.
  const servesIt = (n: { nodeId: string; status: string }) =>
    (inFlight.get(n.nodeId) ?? 0) > 0 && (n.nodeId === nodeId || n.status === 'active');
  const activity =
    servesIt(node) || subtree.nodes.some(servesIt) ? ('in_flight' as const) : ('idle' as const);
  return {
    ok: true,
    ...read,
    activity,
    ...(closedAncestor !== null ? { closedAncestor } : {}),
  };
}

// ============================================================================
// The decisions the plan asks of the operator (Plan 322 P3.2)
// ============================================================================

/**
 * The space's open `decide` nodes, in tree order, whose every ancestor is open
 * too: a decision under a closed branch left the plan with it. Read through
 * the walk every read of the plan takes, so its bounds hold here as well.
 */
export async function listOpenDecisions(ctx: PlanReadContext): Promise<PlanNode[]> {
  const walk = await ctx.store.walk(ctx.spaceId, {
    statuses: OPEN_PLAN_NODE_STATUSES,
    ...PLAN_TREE_WALK_BOUNDS,
  });
  const decisions = orderPlanTree(walk.nodes)
    .map((placed) => placed.node)
    .filter((node) => node.kind === 'decide')
    .slice(0, PLAN_OPEN_DECISIONS_LIMIT);
  const nodes = await Promise.all(decisions.map((d) => ctx.store.find(ctx.spaceId, d.nodeId)));
  // Re-judged on the full read: a node closed between the walk and here is not asked.
  return nodes.filter(
    (node): node is PlanNode =>
      node !== null && node.kind === 'decide' && !isClosedPlanNodeStatus(node.status),
  );
}

/**
 * One open `decide` node by id, by the rule `listOpenDecisions` lists by;
 * null for any other node, a closed one, or one under a closed branch.
 */
export async function findOpenDecision(
  ctx: PlanReadContext,
  nodeId: string,
): Promise<PlanNode | null> {
  const node = await ctx.store.find(ctx.spaceId, nodeId);
  if (node?.kind !== 'decide' || isClosedPlanNodeStatus(node.status)) return null;
  let parentId = node.parentId;
  for (let depth = 0; parentId !== null && depth < PLAN_TREE_DEPTH_LIMIT; depth++) {
    const parent = await ctx.store.find(ctx.spaceId, parentId);
    if (!parent || isClosedPlanNodeStatus(parent.status)) return null;
    parentId = parent.parentId;
  }
  return parentId === null ? node : null;
}

// ============================================================================
// plan.node.link — and the links a run serving a node leaves when it ends
// ============================================================================

export async function linkPlanNode(
  ctx: PlanWriteContext,
  input: PlanNodeLinkInput,
): Promise<PlanOpResult<{ link: PlanNodeLink }>> {
  const inserted = await ctx.store.insertLink(ctx.spaceId, {
    nodeId: input.nodeId,
    kind: input.kind,
    ref: input.ref,
    label: input.label ?? null,
  });
  switch (inserted.outcome) {
    case 'node_not_found':
      return notFound(input.nodeId);
    case 'exists':
      return {
        ok: false,
        code: 'PLAN_NODE_LINK_EXISTS',
        message:
          `Plan node "${input.nodeId}" already links ${input.kind} "${input.ref}", so nothing was written. ` +
          'A record is linked to a node once; plan.node.get lists what is linked.',
        details: { ...inserted.link },
      };
    case 'inserted':
      return planWritten(
        ctx,
        { nodeId: input.nodeId, revision: inserted.revision },
        { ok: true as const, link: inserted.link },
      );
  }
}

export interface EndedPlanRun {
  nodeId: string;
  runId: string;
  slug: string;
  status: 'completed' | 'failed' | 'cancelled';
  /** The pull request the run opened or found open, as its promoted output names it. */
  pullRequestUrl?: string;
}

/**
 * Link a run serving a node to that node as it ends, and the pull request it
 * holds. Either already linked — a run ends once, and a branch appended to
 * keeps its pull request — is left as it stands; a node that is gone takes
 * nothing.
 */
export async function linkEndedRun(ctx: PlanWriteContext, run: EndedPlanRun): Promise<void> {
  const links = [
    { kind: 'run' as const, ref: run.runId, label: `${run.slug} ${run.status}` },
    ...(run.pullRequestUrl !== undefined
      ? [
          {
            kind: 'pull_request' as const,
            ref: run.pullRequestUrl,
            label: `from ${run.slug} run ${run.runId}`,
          },
        ]
      : []),
  ];
  let revision: number | undefined;
  for (const link of links) {
    const inserted = await ctx.store.insertLink(ctx.spaceId, { nodeId: run.nodeId, ...link });
    if (inserted.outcome === 'node_not_found') return;
    if (inserted.outcome === 'inserted') revision = inserted.revision;
  }
  if (revision !== undefined) await planWritten(ctx, { nodeId: run.nodeId, revision }, undefined);
}

// ============================================================================
// plan.node.depend — compare-and-set on the waiting node's revision (Plan 322 P2)
// ============================================================================

function dependencyRefusalDetails(current: PlanNode): Record<string, unknown> {
  const details: PlanNodeRefusalDetails = {
    nodeId: current.nodeId,
    revision: current.revision,
    status: current.status,
    updatedAt: current.updatedAt,
    differingFields: [],
  };
  return details;
}

function dependencyStale(current: PlanNode, input: PlanNodeDependInput): PlanOpError {
  return {
    ok: false,
    code: 'PLAN_NODE_STALE',
    message:
      `Plan node "${current.title}" is at revision ${String(current.revision)}; this change to what it waits on was ` +
      `decided against revision ${String(input.expectedRevision)}, so nothing was written. Read the node with ` +
      `plan.node.get — its dependencies are there — and write again against revision ${String(current.revision)}.`,
    details: dependencyRefusalDetails(current),
  };
}

function dependencyUnchanged(
  current: PlanNode,
  input: PlanNodeDependInput,
  held: PlanNodeDependency | null,
): PlanOpError {
  const stands =
    held === null
      ? `does not wait on "${input.dependsOnId}"`
      : `already waits on "${input.dependsOnId}" being ${held.condition}`;
  return {
    ok: false,
    code: 'PLAN_NODE_UNCHANGED',
    message:
      `Plan node "${current.title}" ${stands}, so nothing was written and it stays at revision ` +
      `${String(current.revision)}. plan.node.get lists what it waits on.`,
    details: dependencyRefusalDetails(current),
  };
}

function dependencyCycle(input: PlanNodeDependInput, path: readonly string[]): PlanOpError {
  const loop = path.map((id) => `"${id}"`).join(' waits on ');
  return {
    ok: false,
    code: 'PLAN_NODE_DEPENDENCY_CYCLE',
    message:
      `Plan node "${input.nodeId}" cannot wait on "${input.dependsOnId}": ${loop}, so none of them could ever ` +
      'start. Nothing was written. Remove one edge of that loop with plan.node.depend and `remove: true`, or ' +
      'wait on another node.',
    details: { nodeId: input.nodeId, dependsOnId: input.dependsOnId, path: [...path] },
  };
}

/**
 * Sets, changes or removes one edge: `input.nodeId` waits on
 * `input.dependsOnId`. It is a write of the waiting node — compare-and-set on
 * its revision, which moves on — so a session that decided on what a node
 * waits on cannot lose another's change to it. An edge that would close a loop
 * is refused in the transaction that would write it.
 */
export async function dependPlanNode(
  ctx: PlanWriteContext,
  input: PlanNodeDependInput,
): Promise<PlanOpResult<{ node: PlanNode; dependency?: PlanNodeDependency }>> {
  const current = await ctx.store.find(ctx.spaceId, input.nodeId);
  if (!current) return notFound(input.nodeId);
  if (current.revision !== input.expectedRevision) return dependencyStale(current, input);
  if (!(await ctx.store.find(ctx.spaceId, input.dependsOnId))) {
    return notFound(input.dependsOnId, 'dependency');
  }
  const condition = input.condition ?? null;
  const held = await ctx.store.findDependency(ctx.spaceId, input.nodeId, input.dependsOnId);
  if (condition === null ? held === null : held?.condition === condition) {
    return dependencyUnchanged(current, input, held);
  }
  const write = await ctx.store.setDependencyAtRevision(
    ctx.spaceId,
    input.nodeId,
    input.expectedRevision,
    input.dependsOnId,
    condition,
  );
  switch (write.outcome) {
    case 'written':
      return nodeWritten(ctx, {
        ok: true as const,
        node: write.node,
        ...(write.dependency !== undefined ? { dependency: write.dependency } : {}),
      });
    case 'stale': {
      // Another session wrote the node between the read and this write.
      const now = await ctx.store.find(ctx.spaceId, input.nodeId);
      return now ? dependencyStale(now, input) : notFound(input.nodeId);
    }
    case 'cycle':
      return dependencyCycle(input, write.path);
    case 'not_found':
      return notFound(input.dependsOnId, 'dependency');
    case 'walk_limit':
      return {
        ok: false,
        code: 'PLAN_NODE_DEPENDENCY_WALK_LIMIT',
        message:
          `More than ${String(write.maxNodes)} nodes are reached by following what "${input.dependsOnId}" waits on, ` +
          'so whether this edge closes a loop was not read, and nothing was written. Remove edges that no longer ' +
          'hold before adding more.',
        details: { nodeId: input.nodeId, dependsOnId: input.dependsOnId, maxNodes: write.maxNodes },
      };
  }
}

// ============================================================================
// plan.node.learn — a learning scoped to a node (Plan 322 D8)
// ============================================================================

/**
 * Records what working a node taught, scoped to it: every later read of the
 * node or of one under it returns it (`getPlanNode`), whichever session reads.
 * It is recorded as read at once — a plan learning reaches no run, so there is
 * nothing for an operator to ratify before it counts.
 */
export async function learnOnPlanNode(
  ctx: PlanWriteContext,
  input: PlanNodeLearnInput,
  writer: { sessionId: string },
): Promise<PlanOpResult<{ learning: PlanNodeLearning; superseded: string[] }>> {
  const supersedes = [...new Set(input.supersedes ?? [])];
  const learning: CoachLearning = {
    learningId: randomUUID(),
    coachSessionId: writer.sessionId,
    scope: { kind: 'plan', planNodeId: input.nodeId },
    kind: input.kind,
    statement: input.statement,
    evidence: { citations: input.evidence.citations },
    confidence: input.confidence,
    supersedes,
    authorityLevel: 'auto_record',
    status: 'auto_recorded',
    createdAt: new Date().toISOString(),
  };
  const inserted = await ctx.store.insertLearning(ctx.spaceId, learning);
  switch (inserted.outcome) {
    case 'node_not_found':
      return notFound(input.nodeId);
    case 'supersedes_unknown':
      return {
        ok: false,
        code: 'PLAN_LEARNING_NOT_FOUND',
        message:
          `No learning still read on plan node "${input.nodeId}" has the id ${inserted.learningIds.map((id) => `"${id}"`).join(', ')}, ` +
          'so nothing was written. `supersedes` names learnings written on this same node — plan.node.get lists them ' +
          'with the node each was written on.',
        details: { nodeId: input.nodeId, learningIds: inserted.learningIds },
      };
    case 'inserted':
      return written(ctx, {
        ok: true as const,
        learning: planNodeLearning(inserted.learning),
        superseded: supersedes,
      });
  }
}

/** The root each node sits under, a root being its own; a node not in the space is absent. */
export function findPlanRootsOf(
  ctx: PlanReadContext,
  nodeIds: readonly string[],
): Promise<Map<string, string>> {
  return findPlanRoots(
    nodeIds,
    (ids) => ctx.store.parentsOf(ctx.spaceId, ids),
    PLAN_TREE_DEPTH_LIMIT,
  );
}
