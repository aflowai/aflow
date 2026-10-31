/**
 * @vitest-environment jsdom
 */
/**
 * The sidebar's Plan count (Plan 338 D1) beside the bell: both read
 * `useActionCenter`, so with the bell mounted the count adds no HTTP read, and
 * a rebuild the broker pushes moves the bell's actionable count and the Plan
 * count together. Rendered through the real hook, the network and the broker
 * replaced.
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ActionCenterItem } from '../../hooks/use-action-center-types.js';

const SPACE = '00000000-0000-4000-8000-000000000338';

const net = vi.hoisted(() => ({
  calls: [] as string[],
  items: [] as unknown[],
  snapshot: undefined as ((items: unknown[]) => void) | undefined,
}));

vi.mock('../providers.js', () => ({
  useApi: () => ({
    apiUrl: '',
    headers: () => ({}),
    blockedSession: null,
    authFetch: (input: string) => {
      net.calls.push(String(input));
      const body = JSON.stringify({ items: net.items });
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve(body),
      });
    },
  }),
}));

vi.mock('../../hooks/action-center-broker.js', () => ({
  acquire: vi.fn(),
  release: vi.fn(),
  resume: vi.fn(),
  subscribeSnapshot: (_spaceId: string, listener: (items: unknown[]) => void) => {
    net.snapshot = listener;
    return () => undefined;
  },
  subscribeItemsUpdate: () => () => undefined,
  subscribeResolve: () => () => undefined,
  subscribeStreamError: () => () => undefined,
  subscribeStatus: () => () => undefined,
  getStatusSnapshot: () => 'connected',
}));

vi.mock('../cybernetic-provider.js', () => ({ useOptionalCybernetic: () => null }));
vi.mock('../../hooks/use-active-surface.js', () => ({
  useActiveSurface: () => ({ snapshot: null }),
}));

vi.mock('@aflow/design-system', () => ({
  useToast: () => ({ toast: vi.fn() }),
  IndicatorButton: ({ count, label }: { count: number; label: string }) =>
    createElement('button', { 'data-bell': String(count), 'aria-label': label }),
  Badge: ({ children, ...rest }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement('span', rest, children),
}));

import { ActionIndicator } from '../actionCenter/ActionIndicator.js';
import { PlanNavCount, usePlanPendingCount } from './PlanNavCount.js';

function item(id: string, origin: ActionCenterItem['origin']): ActionCenterItem {
  return {
    id,
    spaceId: SPACE,
    kind: origin.type === 'plan_decision' ? 'human_input' : 'human_approval',
    origin,
    title: `Pending approval · **${id}**`,
    summary: 'Waiting on you: approve it.',
    requestedAt: '2026-10-31T10:00:00.000Z',
    requestedBy: { kind: 'agent', label: 'Helmsman · plan' },
    priority: 'high',
    relatesTo: [],
    allowedActions: ['approve', 'reject'],
    audience: 'anyone',
    status: 'open',
  } as ActionCenterItem;
}

const ask = (i: number) =>
  item(`plan-ask:${String(i)}`, { type: 'plan_ask', nodeId: String(i), revision: 1 });
const decision = (i: number) =>
  item(`plan-decision:${String(i)}`, {
    type: 'plan_decision',
    nodeId: `d${String(i)}`,
    revision: 1,
  });

function NavHost() {
  return createElement(PlanNavCount, { pending: usePlanPendingCount(SPACE) });
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

function render(...children: ReactNode[]) {
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ...children));
  });
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

const bell = () => container.querySelector('[data-bell]')?.getAttribute('data-bell');
const planCount = () => container.querySelector('[data-plan-nav-count]')?.textContent ?? null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  net.calls = [];
  net.items = [];
  net.snapshot = undefined;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

it('adds no HTTP read beside the bell, and reads 52+ for 50 asks and two decisions', async () => {
  net.items = [...Array.from({ length: 50 }, (_, i) => ask(i)), decision(0), decision(1)];
  render(createElement(ActionIndicator, { key: 'bell', spaceId: SPACE, onClick: () => undefined }));
  await settle();
  expect(net.calls).toEqual([`/spaces/${SPACE}/action-center`]);

  render(
    createElement(ActionIndicator, { key: 'bell', spaceId: SPACE, onClick: () => undefined }),
    createElement(NavHost, { key: 'nav' }),
  );
  await settle();
  expect(net.calls).toHaveLength(1);
  expect(planCount()).toBe('52+ pending');
  // The count is digits and the state's word: no step's markdown reaches the sidebar.
  expect(container.querySelector('[data-plan-nav-count]')?.innerHTML).not.toContain('**');
});

it('rises by one on the rebuild that lists a newly blocked step, with the bell', async () => {
  net.items = [ask(1), ask(2)];
  render(
    createElement(ActionIndicator, { key: 'bell', spaceId: SPACE, onClick: () => undefined }),
    createElement(NavHost, { key: 'nav' }),
  );
  await settle();
  expect([bell(), planCount()]).toEqual(['2', '2 pending']);

  act(() => net.snapshot?.([ask(1), ask(2), ask(3)]));
  await settle();
  expect([bell(), planCount()]).toEqual(['3', '3 pending']);
  expect(net.calls).toHaveLength(1);
});

it('shows nothing where no plan item is open', async () => {
  net.items = [];
  render(createElement(NavHost, { key: 'nav' }));
  await settle();
  expect(planCount()).toBeNull();
});
