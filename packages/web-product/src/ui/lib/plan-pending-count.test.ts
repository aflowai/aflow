/**
 * The sidebar's Plan count (Plan 338 D1): the open `plan_ask` and
 * `plan_decision` items, with `+` where either origin holds as many items as
 * its source lists at most.
 */
import { describe, expect, it } from 'vitest';
import { PLAN_OPEN_ASKS_LIMIT, PLAN_OPEN_DECISIONS_LIMIT } from '@aflow/schemas';
import type { ActionCenterItem } from '../hooks/use-action-center-types.js';
import { planPendingCount } from './plan-pending-count.js';

type Origin = Pick<ActionCenterItem, 'origin'>;

const asks = (n: number): Origin[] =>
  Array.from({ length: n }, (_, i) => ({
    origin: { type: 'plan_ask', nodeId: `a${String(i)}`, revision: 1 },
  }));
const decisions = (n: number): Origin[] =>
  Array.from({ length: n }, (_, i) => ({
    origin: { type: 'plan_decision', nodeId: `d${String(i)}`, revision: 1 },
  }));

/** What the source lists of a space with `blocked` blocked nodes: at most its cap. */
const listedOf = (blocked: number) => asks(Math.min(blocked, PLAN_OPEN_ASKS_LIMIT));

describe('planPendingCount', () => {
  it('reads 50+ for a space with 60 blocked nodes and no open decision', () => {
    expect(planPendingCount(listedOf(60))).toEqual({ count: 50, mayBeCut: true, label: '50+' });
  });

  it('reads 52+ with two open decisions added', () => {
    expect(planPendingCount([...listedOf(60), ...decisions(2)]).label).toBe('52+');
  });

  it('reads 50+ for exactly 50 blocked nodes, with nothing cut: the list carries no total', () => {
    expect(planPendingCount(listedOf(50)).label).toBe('50+');
  });

  it('reads the plain count below either cap, and + where the decisions fill theirs', () => {
    expect(planPendingCount([...asks(49), ...decisions(3)]).label).toBe('52');
    expect(planPendingCount(decisions(PLAN_OPEN_DECISIONS_LIMIT)).label).toBe('50+');
    expect(planPendingCount([]).label).toBe('0');
  });

  it('reads 1 for the one item a blocked root with no steps raises', () => {
    expect(planPendingCount(asks(1))).toEqual({ count: 1, mayBeCut: false, label: '1' });
  });

  it('counts plan items only, whatever their audience', () => {
    const other: Origin = {
      origin: {
        type: 'step',
        runId: 'r',
        stepExecutionId: 's',
        sessionId: 'x',
        pauseVersion: 0,
        operationId: 'user.interaction.approve',
      },
    } as Origin;
    const theirs = { ...asks(1)[0]!, audience: 'someone_else' };
    expect(planPendingCount([other, theirs, ...decisions(1)]).count).toBe(2);
  });
});
