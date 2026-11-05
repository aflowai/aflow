/**
 * @vitest-environment jsdom
 */
/**
 * A plan step's text arrives as markdown, and the Action Center renders it so
 * (Plan 338, the operator's note on P1): the item card and every row of the
 * Workbench's Pending section render a plan item's title and summary as
 * markdown, and leave another source's plain text as it is.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ActionCenterItem } from '../../hooks/use-action-center-types.js';
import type { UseActionCenterResult } from '../../hooks/use-action-center.js';

vi.mock('../cybernetic/ProposalCard.js', () => ({ ProposalCard: () => null }));
vi.mock('./OAuthConsentCard.js', () => ({ OAuthConsentCard: () => null }));
vi.mock('./WriteApprovalCard.js', () => ({ WriteApprovalCard: () => null }));
vi.mock('./BrowserHandoffCard.js', () => ({ BrowserHandoffCard: () => null }));
vi.mock('../setup-checklist.js', () => ({ SetupChecklist: () => null }));
vi.mock('../providers.js', () => ({ useSpaceFromRoute: () => ({ slug: 'space' }) }));
vi.mock('../navigation-provider.js', () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock('../user-avatar.js', () => ({ useCurrentUser: () => null }));
vi.mock('../../hooks/use-space-people.js', () => ({
  useSpacePeople: () => () => undefined,
  useSpaceRoster: () => ({ personFor: () => undefined, people: [] }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children?: unknown; href: string }) =>
    createElement('a', { href }, children as never),
}));

import { WorkbenchNeedsAttention } from '../workbench/WorkbenchNeedsAttention.js';
import { partitionLanes } from '../../hooks/use-action-center-lanes.js';

const SPACE = '00000000-0000-4000-8000-000000000338';

function item(id: string, overrides: Partial<ActionCenterItem>): ActionCenterItem {
  return {
    id,
    spaceId: SPACE,
    kind: 'human_approval',
    origin: { type: 'plan_ask', nodeId: id, revision: 1 },
    title: 't',
    summary: 's',
    requestedAt: '2026-10-31T10:00:00.000Z',
    requestedBy: { kind: 'agent', label: 'Helmsman · plan' },
    priority: 'high',
    relatesTo: [],
    allowedActions: ['approve', 'reject'],
    audience: 'anyone',
    status: 'open',
    ...overrides,
  } as ActionCenterItem;
}

const items = [
  item('plan-ask:1', {
    title: 'Pending approval · Ship **the board** with `PLAN_LANES`',
    summary: 'Waiting on you: read [the brief](https://example.com/brief).\n\n- first\n- second',
  }),
  item('plan-decision:2', {
    kind: 'human_input',
    origin: { type: 'plan_decision', nodeId: '2', revision: 1 },
    title: 'Decide: *which way*',
    allowedActions: [],
  }),
  item('plan-ask:3', { title: 'Pending review · Merge **P2**', audience: 'someone_else' }),
  item('step:4', {
    origin: {
      type: 'step',
      runId: 'r',
      stepExecutionId: 's',
      sessionId: 'x',
      pauseVersion: 0,
      operationId: 'user.interaction.approve',
    },
    title: 'Approve send_mail **now**',
    summary: 'A plain __summary__',
  }),
];

function state(): UseActionCenterResult {
  return {
    items,
    lanes: partitionLanes(items),
    counts: {} as never,
    resolveStateById: {},
    resolveErrorById: {},
    resolve: vi.fn(),
    carrierFailures: [],
  } as unknown as UseActionCenterResult;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(createElement(WorkbenchNeedsAttention, { state: state(), spaceId: SPACE })),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const text = () => container.textContent ?? '';

it('names the section Pending', () => {
  expect(text()).toContain('Pending');
  expect(text()).not.toContain('Needs attention');
});

it('renders a plan item’s title and summary on its card as markdown', () => {
  expect(container.querySelector('strong')?.textContent).toBe('the board');
  expect([...container.querySelectorAll('code')].map((c) => c.textContent)).toContain('PLAN_LANES');
  const link = container.querySelector('a[href="https://example.com/brief"]');
  expect(link?.textContent).toBe('the brief');
  expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
    'first',
    'second',
  ]);
  expect(text()).toContain('Pending approval · Ship the board with PLAN_LANES');
});

it('renders the view-only and someone-else rows’ titles as markdown too', () => {
  expect(container.querySelector('em')?.textContent).toBe('which way');
  expect(text()).toContain('Decide: which way');
  expect(text()).toContain('Pending review · Merge P2');
  expect(text()).not.toContain('*which way*');
  expect(text()).not.toContain('**P2**');
});

it('leaves another source’s plain text as written', () => {
  expect(text()).toContain('Approve send_mail **now**');
  expect(text()).toContain('A plain __summary__');
});

it('names the view-only row’s dot by its state', () => {
  expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Pending');
});
