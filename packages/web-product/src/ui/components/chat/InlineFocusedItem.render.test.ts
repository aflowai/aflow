/**
 * @vitest-environment jsdom
 */
/**
 * A focus on an item other than a proposal shows that item in the chat: its
 * kind, its title, its state and where it is acted on. The focus tells the
 * agent the operator sees the item inline, so no id the focus accepts may
 * leave the bubble empty.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => ({
  result: { data: undefined, error: null, isError: false } as {
    data: unknown;
    error: { status: number } | null;
    isError: boolean;
  },
  paths: [] as string[],
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: unknown }) =>
    createElement('a', { href }, children as never),
}));
vi.mock('../providers.js', () => ({
  useApi: () => ({
    apiUrl: 'http://api',
    headers: () => ({}),
    authFetch: () => Promise.resolve(new Response()),
    blockedSession: null,
  }),
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpace: { id: 'space-1', slug: 'main' } }),
}));
vi.mock('../../hooks/useApiQuery.js', () => ({
  useApiQuery: (opts: { path: string }) => {
    query.paths.push(opts.path);
    return { ...query.result, refetch: () => Promise.resolve() };
  },
}));
vi.mock('../../hooks/action-center-broker.js', () => ({
  acquire: () => undefined,
  release: () => undefined,
  subscribeItemsUpdate: () => () => undefined,
  subscribeResolve: () => () => undefined,
}));

const { InlineFocusedItem } = await import('./InlineFocusedItem.js');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  query.result = { data: undefined, error: null, isError: false };
  query.paths = [];
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function render(props: Parameters<typeof InlineFocusedItem>[0]): void {
  act(() => {
    root.render(createElement(InlineFocusedItem, props));
  });
}

describe('InlineFocusedItem', () => {
  it('shows a plan step by its live title and state, with the link to its place on the plan', () => {
    query.result = {
      data: { id: 'plan-ask:node-1', title: 'Pending approval: Ship the release', status: 'open' },
      error: null,
      isError: false,
    };
    render({ itemId: 'plan-ask:node-1', reason: 'This blocks the release.' });

    expect(query.paths).toContain('/spaces/space-1/action-center/plan-ask%3Anode-1');
    expect(container.textContent).toContain('Plan step');
    expect(container.textContent).toContain('Pending approval: Ship the release');
    expect(container.textContent).toContain('Pending');
    expect(container.textContent).toContain('This blocks the release.');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/s/main/plan?node=node-1');
  });

  it('shows the listed title and says the item is no longer pending where its source has dropped it', () => {
    query.result = { data: undefined, error: { status: 404 }, isError: true };
    render({
      itemId: 'workflow-task:run-1:task-1',
      listed: { kind: 'run_gate', title: 'Review the draft' },
    });

    expect(container.textContent).toContain('Run task');
    expect(container.textContent).toContain('Review the draft');
    expect(container.textContent).toContain('No longer pending');
    expect(container.textContent).toContain('Act on it under Pending in the Workbench.');
  });

  it.each([
    ['plan-decision:node-2', 'Plan decision'],
    ['workflow-task:run-1:task-1', 'Run task'],
    ['workflow-write-approval:run-1:2', 'Write approval'],
    ['workflow-oauth-consent:run-1', 'Connection'],
    ['step:exec-1', 'Paused step'],
    ['gate:exec-1', 'Gate'],
    ['settings:egress-req-1', 'Settings request'],
  ])('names %s, its kind and its state', (itemId, kind) => {
    query.result = {
      data: { id: itemId, title: `Title of ${itemId}`, status: 'resolved' },
      error: null,
      isError: false,
    };
    render({ itemId });

    expect(container.textContent).toContain(kind);
    expect(container.textContent).toContain(`Title of ${itemId}`);
    expect(container.textContent).toContain('Resolved');
  });
});
