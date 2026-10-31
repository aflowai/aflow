/**
 * The count on the sidebar's Plan entry (Plan 338 D1, answering Plan 332 §8):
 * the open Action Center items a plan raises, read from the list the bell and
 * the chat already hold. Pure, so it is tested without rendering.
 */
import { PLAN_OPEN_ASKS_LIMIT, PLAN_OPEN_DECISIONS_LIMIT } from '@aflow/schemas';
import type { ActionCenterItem } from '../hooks/use-action-center-types.js';

export interface PlanPendingCount {
  /** Open items whose origin is `plan_ask` or `plan_decision`, whatever their audience. */
  count: number;
  /**
   * Whether either origin holds as many items as its source lists at most. The
   * list carries no total, so the client cannot tell a full list from a cut
   * one: this says the list may have cut, not that it has.
   */
  mayBeCut: boolean;
  /** The count as the entry shows it: "3", or "50+" where the list may have cut. */
  label: string;
}

export function planPendingCount(
  items: ReadonlyArray<Pick<ActionCenterItem, 'origin'>>,
): PlanPendingCount {
  let asks = 0;
  let decisions = 0;
  for (const item of items) {
    if (item.origin.type === 'plan_ask') asks += 1;
    else if (item.origin.type === 'plan_decision') decisions += 1;
  }
  const count = asks + decisions;
  const mayBeCut = asks >= PLAN_OPEN_ASKS_LIMIT || decisions >= PLAN_OPEN_DECISIONS_LIMIT;
  return { count, mayBeCut, label: mayBeCut ? `${String(count)}+` : String(count) };
}
