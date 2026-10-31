/**
 * The one table of plan state labels (Plan 338 D5), the item title written
 * from it, and the walk's merge-wait flag on a summary (D1).
 */
import { describe, expect, it } from 'vitest';
import {
  PLAN_NODE_MERGE_WAIT_LINE,
  PLAN_STATE_LABELS,
  PlanNodeSummarySchema,
  planItemTitle,
  planNoteHoldsMergeWait,
} from '../../index.js';

describe('PLAN_STATE_LABELS', () => {
  it('names each state as D5’s table does', () => {
    expect(PLAN_STATE_LABELS.column).toEqual({
      needs_you: 'Pending approval',
      in_flight: 'Running',
      up_next: 'Queued',
      done: 'Done',
      dropped: 'Dropped',
    });
    expect(PLAN_STATE_LABELS.reason).toEqual({
      blocked: 'Approval',
      decide: 'Decision',
      stranded: 'Under a closed step',
    });
    expect(PLAN_STATE_LABELS).toMatchObject({
      planNeedsYou: 'Pending approval',
      pendingCountNoun: 'pending',
      pendingEmpty: 'Nothing pending',
      workbenchSection: 'Pending',
    });
  });

  it('titles an item from the table, cut to the item title’s length', () => {
    expect(planItemTitle('blocked', 'Ship it')).toBe('Pending approval · Ship it');
    expect(planItemTitle('merge_wait', 'Merge')).toBe('Pending review · Merge');
    expect(planItemTitle('blocked', 'x'.repeat(400))).toHaveLength(256);
  });
});

describe('the merge-wait flag', () => {
  it('reads the line anywhere in the note', () => {
    expect(planNoteHoldsMergeWait(`Context\n${PLAN_NODE_MERGE_WAIT_LINE}`)).toBe(true);
    expect(planNoteHoldsMergeWait('Waiting on you: approve it')).toBe(false);
    expect(planNoteHoldsMergeWait(undefined)).toBe(false);
  });

  it('is carried on a summary as true or not at all', () => {
    const summary = {
      nodeId: '00000000-0000-4000-8000-000000000001',
      parentId: null,
      kind: 'execute',
      title: 'Merge',
      status: 'active',
      revision: 2,
      position: 0,
      createdAt: '2026-10-31T10:00:00.000Z',
      updatedAt: '2026-10-31T10:00:00.000Z',
    };
    expect(PlanNodeSummarySchema.safeParse({ ...summary, mergeWait: true }).success).toBe(true);
    expect(PlanNodeSummarySchema.safeParse({ ...summary, mergeWait: false }).success).toBe(false);
    expect(PlanNodeSummarySchema.safeParse(summary).success).toBe(true);
  });
});
