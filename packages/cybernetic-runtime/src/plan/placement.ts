/**
 * Where a place write puts a node among its siblings (Plan 332 D6), decided
 * from the siblings as one transaction read them. Pure, so the store and its
 * in-memory twin decide alike.
 */
import { PLAN_NODE_POSITION_MAX } from '@aflow/schemas';

/** The gap a renumbering leaves between two siblings, so later places rarely renumber again. */
export const PLAN_PLACE_STRIDE = 1024;

export type PlanPlaceAnchor = { before: string } | { after: string };

export interface PlanSiblingPosition {
  nodeId: string;
  position: number;
}

export type PlanSiblingPlacement =
  /** The anchor is not among the node's siblings — moved away, gone, or the node itself. */
  | { outcome: 'not_sibling' }
  /** The node already stands directly there. */
  | { outcome: 'unchanged' }
  /**
   * `position` is the node's; `renumbered` the other siblings whose position
   * changes, each keeping its place relative to every other.
   */
  | { outcome: 'placed'; position: number; renumbered: Map<string, number> };

/**
 * `siblings` are every child of the node's parent, the node among them, in
 * sibling order. The node goes between the anchor and its neighbour; where no
 * integer lies between them, every sibling is renumbered at
 * `PLAN_PLACE_STRIDE` in the order the place leaves.
 */
export function placeAmongSiblings(
  siblings: readonly PlanSiblingPosition[],
  nodeId: string,
  anchor: PlanPlaceAnchor,
): PlanSiblingPlacement {
  const anchorId = 'before' in anchor ? anchor.before : anchor.after;
  const from = siblings.findIndex((s) => s.nodeId === nodeId);
  if (anchorId === nodeId || from === -1) return { outcome: 'not_sibling' };
  const others = siblings.filter((s) => s.nodeId !== nodeId);
  const anchorAt = others.findIndex((s) => s.nodeId === anchorId);
  if (anchorAt === -1) return { outcome: 'not_sibling' };
  const insertAt = 'before' in anchor ? anchorAt : anchorAt + 1;
  if (from === insertAt) return { outcome: 'unchanged' };

  const lower = others[insertAt - 1]?.position ?? -1;
  const upper = others[insertAt]?.position ?? PLAN_NODE_POSITION_MAX + 1;
  if (upper - lower >= 2) {
    const position =
      insertAt === others.length
        ? Math.min(lower + PLAN_PLACE_STRIDE, PLAN_NODE_POSITION_MAX)
        : insertAt === 0
          ? Math.max(upper - PLAN_PLACE_STRIDE, 0)
          : lower + Math.floor((upper - lower) / 2);
    return { outcome: 'placed', position, renumbered: new Map() };
  }

  const order: PlanSiblingPosition[] = [...others];
  order.splice(insertAt, 0, { nodeId, position: -1 });
  if ((order.length - 1) * PLAN_PLACE_STRIDE > PLAN_NODE_POSITION_MAX) {
    throw new Error('too many siblings to renumber within a plan position');
  }
  const renumbered = new Map<string, number>();
  let position = 0;
  order.forEach((sibling, index) => {
    const next = index * PLAN_PLACE_STRIDE;
    if (sibling.nodeId === nodeId) position = next;
    else if (sibling.position !== next) renumbered.set(sibling.nodeId, next);
  });
  return { outcome: 'placed', position, renumbered };
}
