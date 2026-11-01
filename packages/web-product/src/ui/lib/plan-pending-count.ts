/**
 * The count on the sidebar's Plan entry (Plan 338 D1, answering Plan 332 §8):
 * the open Action Center items a plan raises, read from the list the bell and
 * the chat already hold. Pure, so it is tested without rendering. The rule
 * that turns the two sets into a count is the schema's, which the Helmsman's
 * attention block reads too (Plan 338 D2).
 */
import {
  ACTION_CENTER_LIST_LIMIT,
  pendingPlanStepCount,
  type PlanPendingCount,
} from '@aflow/schemas';
import type { ActionCenterItem } from '../hooks/use-action-center-types.js';

export type { PlanPendingCount };

/**
 * Open items whose origin is `plan_ask` or `plan_decision`, whatever their
 * audience. Each source lists at most its cap, so a set at its cap may have
 * cut, whichever list holds it. The REST list carries no total, so a REST list
 * as long as the route returns may have cut as well. The route's limit does
 * not cut the stream's snapshot, so its length says nothing about that cut.
 */
export function planPendingCount(
  items: ReadonlyArray<Pick<ActionCenterItem, 'origin'>>,
  list: { whole: boolean },
): PlanPendingCount {
  let asks = 0;
  let decisions = 0;
  for (const item of items) {
    if (item.origin.type === 'plan_ask') asks += 1;
    else if (item.origin.type === 'plan_decision') decisions += 1;
  }
  return pendingPlanStepCount({
    asks,
    decisions,
    listMayBeCut: !list.whole && items.length >= ACTION_CENTER_LIST_LIMIT,
  });
}
