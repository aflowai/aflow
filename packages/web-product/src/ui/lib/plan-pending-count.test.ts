/**
 * The sidebar's Plan count (Plan 338 D1): the open `plan_ask` and
 * `plan_decision` items, with `+` where either origin holds as many items as
 * its source lists at most, or the REST list as many as the route returns.
 * The stream's snapshot carries every open item, so its length marks nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  ACTION_CENTER_LIST_LIMIT,
  PLAN_OPEN_ASKS_LIMIT,
  PLAN_OPEN_DECISIONS_LIMIT,
} from '@aflow/schemas';
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

/** The list the REST route returned, which it may have cut at its limit. */
const REST = { whole: false };
/** The list the stream's snapshot carried, which holds every open item. */
const SNAPSHOT = { whole: true };

const other: Origin = { origin: { type: 'coach_activity' } } as unknown as Origin;
const othersOf = (n: number): Origin[] => Array.from({ length: n }, () => other);

describe('the + mark on the snapshot list', () => {
  it('is absent where the snapshot holds the route’s limit of items or more', () => {
    const items = [...asks(3), ...decisions(2), ...othersOf(ACTION_CENTER_LIST_LIMIT + 50)];
    expect(planPendingCount(items, SNAPSHOT)).toEqual({ count: 5, mayBeCut: false, label: '5' });
  });

  it('is present where a set stands at its source’s cap', () => {
    const items = [...asks(PLAN_OPEN_ASKS_LIMIT), ...othersOf(ACTION_CENTER_LIST_LIMIT)];
    expect(planPendingCount(items, SNAPSHOT).label).toBe(`${String(PLAN_OPEN_ASKS_LIMIT)}+`);
    expect(planPendingCount(decisions(PLAN_OPEN_DECISIONS_LIMIT), SNAPSHOT).label).toBe(
      `${String(PLAN_OPEN_DECISIONS_LIMIT)}+`,
    );
  });

  it('reads the REST list of the same length as possibly cut', () => {
    const items = [...asks(3), ...decisions(2), ...othersOf(ACTION_CENTER_LIST_LIMIT - 5)];
    expect(planPendingCount(items, REST).label).toBe('5+');
    expect(planPendingCount(items, SNAPSHOT).label).toBe('5');
  });
});

describe('planPendingCount', () => {
  it('reads 50+ for a space with 60 blocked nodes and no open decision', () => {
    expect(planPendingCount(listedOf(60), REST)).toEqual({
      count: 50,
      mayBeCut: true,
      label: '50+',
    });
  });

  it('reads 52+ with two open decisions added', () => {
    expect(planPendingCount([...listedOf(60), ...decisions(2)], REST).label).toBe('52+');
  });

  it('reads 50+ for exactly 50 blocked nodes, with nothing cut: the list carries no total', () => {
    expect(planPendingCount(listedOf(50), REST).label).toBe('50+');
  });

  it('reads the plain count below either cap, and + where the decisions fill theirs', () => {
    expect(planPendingCount([...asks(49), ...decisions(3)], REST).label).toBe('52');
    expect(planPendingCount(decisions(PLAN_OPEN_DECISIONS_LIMIT), REST).label).toBe('50+');
    expect(planPendingCount([], REST).label).toBe('0');
  });

  it('reads + where the REST list fills the route’s cut, below either source’s cap', () => {
    const others = othersOf(ACTION_CENTER_LIST_LIMIT - 5);
    expect(planPendingCount([...asks(3), ...decisions(2), ...others], REST)).toEqual({
      count: 5,
      mayBeCut: true,
      label: '5+',
    });
    expect(planPendingCount([...asks(3), ...decisions(1), ...others], REST).label).toBe('4');
  });

  it('reads 1 for the one item a blocked root with no steps raises', () => {
    expect(planPendingCount(asks(1), REST)).toEqual({ count: 1, mayBeCut: false, label: '1' });
  });

  it('counts plan items only, whatever their audience', () => {
    const paused: Origin = {
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
    expect(planPendingCount([paused, theirs, ...decisions(1)], REST).count).toBe(2);
  });
});
