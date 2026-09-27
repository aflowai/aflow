/**
 * Slot accounting: what counts as occupying one of a run's parallel slots, and
 * which ready tasks the free slots buy.
 */
import { describe, expect, it } from 'vitest';
import {
  countHeldSlots,
  holdsConcurrencySlot,
  selectTasksForFreeSlots,
  RESERVED_TASK_STATUS,
} from '../ledger/concurrencySlots.js';

const READY = ['task-a', 'task-b', 'task-c', 'task-d'];

describe('selectTasksForFreeSlots', () => {
  it('takes as many ready tasks as there are free slots', () => {
    expect(selectTasksForFreeSlots({ limit: 4, activeCount: 1, readyTaskIds: READY })).toEqual({
      freeSlots: 3,
      selected: ['task-a', 'task-b', 'task-c'],
      deferred: ['task-d'],
    });
  });

  it('selects nothing once the limit is already exhausted', () => {
    expect(selectTasksForFreeSlots({ limit: 4, activeCount: 4, readyTaskIds: READY })).toEqual({
      freeSlots: 0,
      selected: [],
      deferred: READY,
    });
  });

  it('selects nothing when more is active than the limit allows', () => {
    // A limit lowered between runs, or a re-armed row the reservation never
    // granted: the arithmetic must not hand back negative slots.
    expect(selectTasksForFreeSlots({ limit: 2, activeCount: 5, readyTaskIds: READY })).toEqual({
      freeSlots: 0,
      selected: [],
      deferred: READY,
    });
  });

  it('takes the whole ready list when the limit is wider than it', () => {
    expect(selectTasksForFreeSlots({ limit: 20, activeCount: 0, readyTaskIds: READY })).toEqual({
      freeSlots: 20,
      selected: READY,
      deferred: [],
    });
  });

  it('defers nothing and selects nothing for an empty ready list', () => {
    expect(selectTasksForFreeSlots({ limit: 4, activeCount: 0, readyTaskIds: [] })).toEqual({
      freeSlots: 4,
      selected: [],
      deferred: [],
    });
  });

  it('preserves the caller dispatch order', () => {
    const reversed = [...READY].reverse();
    expect(
      selectTasksForFreeSlots({ limit: 2, activeCount: 0, readyTaskIds: reversed }).selected,
    ).toEqual(['task-d', 'task-c']);
  });
});

describe('countHeldSlots', () => {
  it('counts a task waiting between poll cycles', () => {
    // The poll gate advances `poll_cycle` on a row that stays `running`, so the
    // waiting task is indistinguishable from an executing one — and must be: a
    // slot released at the cycle boundary turns one submission into as many
    // live jobs as the poll budget allows.
    expect(countHeldSlots([{ status: 'running' }])).toBe(1);
  });

  it('counts a reserved-but-undispatched row', () => {
    expect(countHeldSlots([{ status: RESERVED_TASK_STATUS }])).toBe(1);
  });

  it('does not count terminal rows', () => {
    expect(
      countHeldSlots([
        { status: 'succeeded' },
        { status: 'failed' },
        { status: 'skipped' },
        { status: 'blocked' },
        { status: 'cancelled' },
      ]),
    ).toBe(0);
  });

  it('does not count a row parked for human input', () => {
    // The run itself is paused behind it; holding the slot would leave nothing
    // to free it on resume.
    expect(holdsConcurrencySlot('paused')).toBe(false);
  });

  it('does not count a row armed for re-run but never dispatched', () => {
    expect(holdsConcurrencySlot('pending')).toBe(false);
  });

  it('counts a mixed run against the limit', () => {
    const rows = [
      { status: 'succeeded' },
      { status: 'running' },
      { status: 'scheduled' },
      { status: 'running' },
      { status: 'skipped' },
    ];
    expect(countHeldSlots(rows)).toBe(3);
    expect(
      selectTasksForFreeSlots({ limit: 4, activeCount: countHeldSlots(rows), readyTaskIds: READY }),
    ).toEqual({ freeSlots: 1, selected: ['task-a'], deferred: ['task-b', 'task-c', 'task-d'] });
  });
});
