/**
 * The plan engine's refusals (Plan 322 D7): each names what was refused, why
 * nothing was written, and what the writer does next. `operations.ts` returns
 * them. They are not part of the package's surface.
 */
import {
  PLAN_NODE_PROSE_MAX_CHARS,
  PLAN_NODE_UPDATE_FIELDS,
  PLAN_TREE_DEPTH_LIMIT,
  type PlanNode,
  type PlanNodeRefusalDetails,
  type PlanNodeStatus,
  type PlanNodeUpdateInput,
} from '@aflow/schemas';
import type { PlanOpError } from './operations.js';
import type { PlanPlacementRefusal } from './store.js';

export function notFound(
  nodeId: string,
  role: 'node' | 'parent' | 'root' | 'dependency' = 'node',
): PlanOpError {
  return {
    ok: false,
    code: 'PLAN_NODE_NOT_FOUND',
    message: `No plan node "${nodeId}" in this space${role === 'node' ? '' : ` to use as the ${role}`}. The attention block lists the open tree; plan.node.list finds the rest.`,
    details: { nodeId },
  };
}

/**
 * A patch column against the node's: absent is null, a time compares as its
 * ISO string, and a card as its serialised form. Both cards come in the
 * schema's key order, so equal cards serialise alike.
 */
export function sameColumn(patched: unknown, held: unknown): boolean {
  const stored = (value: unknown) =>
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object' && value !== null
        ? JSON.stringify(value)
        : (value ?? null);
  return stored(patched) === stored(held);
}

export function refusalDetails(
  current: PlanNode,
  input: PlanNodeUpdateInput,
): Record<string, unknown> {
  const differingFields = PLAN_NODE_UPDATE_FIELDS.filter((field) => {
    const value = field === 'note' && input.note === '' ? null : input[field];
    return value !== undefined && !sameColumn(value, current[field]);
  });
  const details: PlanNodeRefusalDetails = {
    nodeId: current.nodeId,
    revision: current.revision,
    status: current.status,
    updatedAt: current.updatedAt,
    differingFields,
  };
  return details;
}

export function stale(current: PlanNode, input: PlanNodeUpdateInput): PlanOpError {
  return {
    ok: false,
    code: 'PLAN_NODE_STALE',
    message:
      `Plan node "${current.title}" is at revision ${String(current.revision)}; this update was decided against revision ` +
      `${String(input.expectedRevision)}, so nothing was written. error.details.differingFields names what this update ` +
      `would still change; read the node with plan.node.get, reconcile with it, and update against revision ` +
      `${String(current.revision)}.`,
    details: refusalDetails(current, input),
  };
}

export function openHasNoOutcome(current: PlanNode, status: PlanNodeStatus): PlanOpError {
  const stands =
    status === current.status ? `is ${status}` : `would be ${status} after this update`;
  return {
    ok: false,
    code: 'PLAN_NODE_OPEN_HAS_NO_OUTCOME',
    message:
      `Plan node "${current.title}" ${stands}, and an open node has no outcome, so nothing was written. ` +
      'Pass `outcome` in the update that sets status "done" or "dropped", or put what you found in the note.',
    details: { nodeId: current.nodeId, status },
  };
}

export function unchanged(current: PlanNode, input: PlanNodeUpdateInput): PlanOpError {
  return {
    ok: false,
    code: 'PLAN_NODE_UNCHANGED',
    message:
      `Plan node "${current.title}" already stands as this update would leave it, so nothing was written ` +
      `and it stays at revision ${String(current.revision)}. An update names at least one field whose value ` +
      'differs from the node; plan.node.get reads it as it stands.',
    details: refusalDetails(current, input),
  };
}

export function reopenedNoteTooLong(current: PlanNode, noteLength: number): PlanOpError {
  const headLength = reopenedNote(current, null)?.length ?? 0;
  const room = PLAN_NODE_PROSE_MAX_CHARS - headLength - 1;
  const shortenOutcome = `shorten the outcome with an update while the node is still ${current.status}`;
  const remedy =
    headLength > PLAN_NODE_PROSE_MAX_CHARS
      ? `Its outcome alone passes that: ${shortenOutcome}, then reopen it.`
      : `Pass a shorter \`note\` in this update${room > 0 ? ` (at most ${String(room)} characters fit under the reopened line)` : ''}, ` +
        `or "" to keep only that line, or ${shortenOutcome} first.`;
  return {
    ok: false,
    code: 'PLAN_NODE_NOTE_TOO_LONG',
    message:
      `Reopening plan node "${current.title}" puts its outcome at the head of its note, which would then hold ` +
      `${String(noteLength)} characters; a note holds at most ${String(PLAN_NODE_PROSE_MAX_CHARS)}, so nothing was ` +
      `written. ${remedy}`,
    details: {
      nodeId: current.nodeId,
      status: current.status,
      noteLength,
      noteMaxChars: PLAN_NODE_PROSE_MAX_CHARS,
    },
  };
}

function cycle(nodeId: string, parentId: string): PlanOpError {
  return {
    ok: false,
    code: 'PLAN_NODE_CYCLE',
    message: `Plan node "${parentId}" is "${nodeId}" itself or sits under it, so it cannot be its parent. Nothing was written.`,
    details: { nodeId, parentId },
  };
}

type TooDeep = Extract<PlanPlacementRefusal, { outcome: 'too_deep' }>;

/** `nodeId` is null for a node not yet created. */
function tooDeep(nodeId: string | null, parentId: string, check: TooDeep): PlanOpError {
  const deepest = check.parentDepth + 1 + check.height;
  const placed =
    nodeId === null
      ? `a new node under it would sit at depth ${String(deepest)}`
      : `"${nodeId}" has ${String(check.height)} level${check.height === 1 ? '' : 's'} below it, so moving it there would put its deepest node at depth ${String(deepest)}`;
  return {
    ok: false,
    code: 'PLAN_NODE_TOO_DEEP',
    message:
      `Plan node "${parentId}" sits at depth ${String(check.parentDepth)} (a root is depth 0) and ${placed}; ` +
      `a plan holds nodes to depth ${String(PLAN_TREE_DEPTH_LIMIT)}. Nothing was written; choose a parent nearer the root.`,
    details: {
      ...(nodeId !== null ? { nodeId } : {}),
      parentId,
      parentDepth: check.parentDepth,
      height: check.height,
      depthLimit: PLAN_TREE_DEPTH_LIMIT,
    },
  };
}

export function placementRefusal(
  refusal: PlanPlacementRefusal,
  nodeId: string | null,
  parentId: string,
): PlanOpError {
  switch (refusal.outcome) {
    case 'cycle':
      if (nodeId === null) throw new Error('a placement check met a node not yet created');
      return cycle(nodeId, parentId);
    case 'too_deep':
      return tooDeep(nodeId, parentId, refusal);
    case 'parent_not_found':
      return notFound(parentId, 'parent');
  }
}

/** A reopened node keeps what it claimed, as the head of its note, not as its outcome. */
export function reopenedNote(
  current: PlanNode,
  note: string | null | undefined,
): string | null | undefined {
  if (current.outcome === undefined) return note;
  const kept = `Reopened; it was ${current.status}: ${current.outcome}`;
  const rest = note === undefined ? (current.note ?? null) : note;
  return rest === null ? kept : `${kept}\n${rest}`;
}

export function operatorNoteTooLong(
  current: PlanNode,
  noteLength: number,
  act: 'Approving' | 'Sending back',
): PlanOpError {
  return {
    ok: false,
    code: 'PLAN_NODE_NOTE_TOO_LONG',
    message:
      `${act} plan node "${current.title}" with this note puts it above its note, which would then hold ` +
      `${String(noteLength)} characters. A note holds at most ${String(PLAN_NODE_PROSE_MAX_CHARS)}, so nothing was ` +
      'written. Shorten what you wrote, or shorten the node’s note first.',
    details: {
      nodeId: current.nodeId,
      status: current.status,
      noteLength,
      noteMaxChars: PLAN_NODE_PROSE_MAX_CHARS,
    },
  };
}
