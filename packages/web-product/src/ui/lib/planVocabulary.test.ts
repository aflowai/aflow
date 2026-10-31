/**
 * @vitest-environment jsdom
 */
/**
 * One vocabulary of states (Plan 338 D5): the board, the overview, the item
 * title and the Workbench all read `PLAN_STATE_LABELS` in `@aflow/schemas`, so
 * a label changed there changes on every surface. The table is changed here
 * before any surface module reads it.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

vi.mock('@aflow/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/schemas')>();
  const labels = actual.PLAN_STATE_LABELS as unknown as {
    column: Record<string, string>;
    reason: Record<string, string>;
    planNeedsYou: string;
    pendingCountNoun: string;
    pendingEmpty: string;
    itemTitle: Record<string, string>;
    workbenchSection: string;
  };
  labels.column['needs_you'] = 'Awaiting you';
  labels.column['in_flight'] = 'Underway';
  labels.reason['blocked'] = 'Sign-off';
  labels.planNeedsYou = 'Awaiting you';
  labels.pendingCountNoun = 'awaiting';
  labels.pendingEmpty = 'Nothing awaits';
  labels.itemTitle['blocked'] = 'Awaiting sign-off';
  labels.workbenchSection = 'Awaiting';
  return actual;
});

vi.mock('../components/workbench/WorkbenchSection.js', () => ({
  WorkbenchSection: ({ title }: { title: string }) => createElement('h3', null, title),
}));
vi.mock('../components/actionCenter/ActionCenterLane.js', () => ({
  ActionCenterItemCard: () => null,
}));
vi.mock('../components/actionCenter/CarrierFailures.js', () => ({ CarrierFailures: () => null }));
vi.mock('../components/actionCenter/AssignControl.js', () => ({ AssignControl: () => null }));
vi.mock('../hooks/use-space-people.js', () => ({ useSpacePeople: () => () => undefined }));

import { planItemTitle, type PlanRootTally } from '@aflow/schemas';
import {
  NEEDS_YOU_REASON_LABEL,
  PLAN_BOARD_COLUMNS,
  PLAN_LANES,
  PLAN_STATE_LABEL,
  planHeader,
} from './plan-board.js';
import { WorkbenchNeedsAttention } from '../components/workbench/WorkbenchNeedsAttention.js';
import type { UseActionCenterResult } from '../hooks/use-action-center.js';

it('changes the board’s columns and reasons', () => {
  expect(PLAN_BOARD_COLUMNS.find((c) => c.id === 'needs_you')).toMatchObject({
    label: 'Awaiting you',
    color: 'var(--color-warning-default)',
  });
  expect(PLAN_BOARD_COLUMNS.find((c) => c.id === 'in_flight')?.label).toBe('Underway');
  expect(NEEDS_YOU_REASON_LABEL.blocked).toBe('Sign-off');
});

it('changes the overview’s lanes, the plan’s state and its header count', () => {
  expect(PLAN_LANES.find((l) => l.id === 'needs_you')).toMatchObject({
    label: 'Awaiting you',
    empty: 'Nothing awaits',
  });
  expect(PLAN_STATE_LABEL.needs_you).toBe('Awaiting you');
  const tally = {
    state: 'needs_you',
    steps: 4,
    needsYou: 3,
    inFlight: 1,
    upNext: 0,
    done: 0,
    dropped: 0,
  } as unknown as PlanRootTally;
  expect(planHeader(tally)).toMatchObject({
    state: 'Awaiting you',
    counts: [
      { column: 'needs_you', label: '3 awaiting' },
      { column: 'in_flight', label: '1 underway' },
    ],
  });
});

it('changes the item title the server writes', () => {
  expect(planItemTitle('blocked', 'Ship it')).toBe('Awaiting sign-off · Ship it');
});

it('changes the Workbench section', () => {
  const item = {
    id: 'plan-ask:1',
    kind: 'human_approval',
    origin: { type: 'plan_ask', nodeId: '1', revision: 1 },
    title: 'Awaiting sign-off · Ship it',
    allowedActions: ['approve'],
    audience: 'anyone',
  };
  const state = {
    lanes: { connections: [], approvals: [item], inputs: [] },
    carrierFailures: [],
  } as unknown as UseActionCenterResult;
  const container = document.createElement('div');
  const root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  act(() => root.render(createElement(WorkbenchNeedsAttention, { state, spaceId: 's' })));
  expect(container.querySelector('h3')?.textContent).toBe('Awaiting');
  act(() => root.unmount());
});
