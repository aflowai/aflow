/**
 * @vitest-environment jsdom
 */
/**
 * The plan page as the operator sees it (Plan 322 P3): the trees nested by
 * parent in the order the endpoint gives them, a closed node with how it
 * ended, and each node's links and runs in flight as references that open
 * what they name — rendered through the screen itself, the design system's
 * primitives as plain elements and the query recorded.
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanTreeNode, PlanTreeOutput } from '@aflow/schemas';

const recorded = vi.hoisted(() => ({
  query: undefined as unknown,
  result: {} as { data?: unknown; isLoading?: boolean; error?: Error | null },
  refetch: vi.fn(),
  mutation: undefined as
    | {
        path: (input: { nodeId: string }) => string;
        method: string;
        serialize: (input: Record<string, unknown>) => string;
        invalidate: unknown[];
      }
    | undefined,
  mutateAsync: vi.fn(),
}));

vi.mock('@aflow/design-system', () => {
  const block =
    (tag: string) =>
    ({
      children,
      title,
      role,
      ...rest
    }: {
      children?: ReactNode;
      title?: string;
      role?: string;
      [key: string]: unknown;
    }) =>
      createElement(
        tag,
        {
          ...(title !== undefined ? { title } : {}),
          ...(role !== undefined ? { role } : {}),
          ...Object.fromEntries(Object.entries(rest).filter(([key]) => key.startsWith('data-'))),
        },
        children,
      );
  return {
    Badge: block('span'),
    Card: block('div'),
    CardBody: block('div'),
    Column: block('div'),
    Heading: block('h2'),
    HelperText: block('p'),
    PageContainer: block('main'),
    Row: block('div'),
    Text: block('span'),
    Button: ({
      children,
      onClick,
      disabled,
    }: {
      children?: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
    }) => createElement('button', { type: 'button', onClick, disabled }, children),
    Textarea: (props: Record<string, unknown>) =>
      createElement('textarea', {
        'aria-label': props['aria-label'],
        value: props['value'],
        onChange: props['onChange'],
        disabled: props['disabled'],
      }),
  };
});

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) =>
    createElement('a', { href }, children),
}));

vi.mock('../components/providers.js', () => ({
  useSpaceFromRoute: () => ({ id: SPACE_ID, slug: 'work', slugFromRoute: 'work' }),
}));

vi.mock('../hooks/useApiQuery.js', () => ({
  useApiQuery: (options: unknown) => {
    recorded.query = options;
    return {
      data: undefined,
      isLoading: false,
      error: null,
      refetch: recorded.refetch,
      ...recorded.result,
    };
  },
  useApiMutation: (options: typeof recorded.mutation) => {
    recorded.mutation = options;
    return { mutateAsync: recorded.mutateAsync };
  },
}));

const SPACE_ID = '00000000-0000-4000-8000-000000000002';
const ROOT = '00000000-0000-4000-8000-0000000000a1';
const FIRST = '00000000-0000-4000-8000-0000000000a2';
const SECOND = '00000000-0000-4000-8000-0000000000a3';
const UNDER_FIRST = '00000000-0000-4000-8000-0000000000a4';
const RUN_ID = '00000000-0000-4000-8000-0000000000f1';
const ENDED_RUN_ID = '00000000-0000-4000-8000-0000000000f2';
const PR = 'https://github.com/aflowai/aflow/pull/181';

const { SpacePlanPage } = await import('./space-plan.js');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function treeNode(
  nodeId: string,
  parentId: string | null,
  title: string,
  extra: Partial<PlanTreeNode> = {},
): PlanTreeNode {
  return {
    nodeId,
    parentId,
    kind: 'execute',
    title,
    status: 'active',
    revision: 1,
    position: 0,
    updatedAt: '2026-10-05T08:00:00.000Z',
    links: [],
    linksTotal: 0,
    runs: [],
    children: [],
    ...extra,
  };
}

const PLAN: PlanTreeOutput = {
  roots: [
    treeNode(ROOT, null, 'Plan 322 · plans are platform records', {
      noteHead: 'next: P3.2 operator writes',
      children: [
        treeNode(FIRST, ROOT, 'P3.1 the plan page', {
          position: 0,
          runs: [
            {
              runId: RUN_ID,
              slug: 'commission-change',
              status: 'running',
              nodeId: FIRST,
              startedAt: '2026-10-05T09:00:00.000Z',
            },
          ],
          links: [
            {
              nodeId: FIRST,
              kind: 'run',
              ref: ENDED_RUN_ID,
              label: 'commission-change completed',
              createdAt: '2026-10-05T09:30:00.000Z',
            },
          ],
          linksTotal: 1,
          children: [treeNode(UNDER_FIRST, FIRST, 'route and its test')],
        }),
        treeNode(SECOND, ROOT, 'P2b the stream wakes itself', {
          position: 1,
          status: 'done',
          outcome: `Merged as ${PR}; both firings observed.`,
          closedAt: '2026-10-05T10:00:00.000Z',
          noteHead: 'a stale working line',
          links: [
            {
              nodeId: SECOND,
              kind: 'pull_request',
              ref: PR,
              label: `from publish-local-changes run ${ENDED_RUN_ID}`,
              createdAt: '2026-10-05T10:00:00.000Z',
            },
            { nodeId: SECOND, kind: 'finding', ref: 'F121', createdAt: '2026-10-05T09:00:00.000Z' },
          ],
          linksTotal: 5,
        }),
      ],
    }),
  ],
  runsTotal: 1,
};

let container: HTMLDivElement;
let root: Root;

async function render(result: typeof recorded.result): Promise<void> {
  recorded.result = result;
  await act(async () => {
    root.render(createElement(SpacePlanPage));
  });
}

function nodeItem(nodeId: string): Element {
  const found = container.querySelector(`li[data-plan-node="${nodeId}"]`);
  if (!found) throw new Error(`no node ${nodeId}`);
  return found;
}

function anchor(scope: Element, text: string): HTMLAnchorElement {
  const found = [...scope.querySelectorAll('a')].find((a) => a.textContent === text);
  if (!found) throw new Error(`no link reading ${text}`);
  return found;
}

beforeEach(() => {
  recorded.query = undefined;
  recorded.result = {};
  recorded.mutation = undefined;
  recorded.refetch.mockReset();
  recorded.mutateAsync.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('SpacePlanPage', () => {
  it('reads the space’s plan from its endpoint, under the space’s query key', async () => {
    await render({ data: PLAN });

    expect(recorded.query).toMatchObject({
      key: ['space', SPACE_ID, 'plan'],
      path: `/spaces/${SPACE_ID}/plan`,
    });
  });

  it('nests each node under its parent, in the order the endpoint gives them', async () => {
    await render({ data: PLAN });

    const top = container.querySelector('ul');
    const roots = [...(top?.children ?? [])].map((li) => li.getAttribute('data-plan-node'));
    expect(roots).toEqual([ROOT]);

    const rootItem = nodeItem(ROOT);
    const childList = rootItem.querySelector(':scope > ul')!;
    expect([...childList.children].map((li) => li.getAttribute('data-plan-node'))).toEqual([
      FIRST,
      SECOND,
    ]);
    const firstItem = childList.querySelector(`li[data-plan-node="${FIRST}"]`)!;
    expect(firstItem.querySelector(`:scope > ul > li[data-plan-node="${UNDER_FIRST}"]`)).not.toBe(
      null,
    );
  });

  it('shows a done node with its outcome, and an open node with its working line', async () => {
    await render({ data: PLAN });

    const done = nodeItem(SECOND);
    expect(done.getAttribute('data-status')).toBe('done');
    expect(done.textContent).toContain(`Outcome: Merged as ${PR}; both firings observed.`);
    expect(done.textContent).not.toContain('a stale working line');

    const open = nodeItem(ROOT);
    expect(open.textContent).toContain('next: P3.2 operator writes');
    expect(open.querySelector(':scope > div')?.textContent).not.toContain('Outcome:');
  });

  it('renders a node’s links as references that open what they name', async () => {
    await render({ data: PLAN });

    const done = nodeItem(SECOND);
    const pr = anchor(done, 'aflow#181');
    expect(pr.getAttribute('href')).toBe(PR);
    expect(pr.getAttribute('target')).toBe('_blank');
    expect(pr.getAttribute('rel')).toContain('noopener');
    // A finding is named by its own text and has no page to open.
    expect(done.textContent).toContain('F121');
    expect([...done.querySelectorAll('a')].some((a) => a.textContent === 'F121')).toBe(false);
    expect(done.textContent).toContain('3 older links not shown');

    const first = nodeItem(FIRST);
    expect(anchor(first, 'commission-change completed').getAttribute('href')).toBe(
      `/s/work/runs/${ENDED_RUN_ID}`,
    );
  });

  it('lists the runs in flight under the node they serve, each opening its run', async () => {
    await render({ data: PLAN });

    const first = nodeItem(FIRST);
    const runs = first.querySelector(':scope > div > ul[aria-label="Runs in flight"]')!;
    expect(runs.textContent).toContain('running');
    expect(anchor(runs, 'commission-change').getAttribute('href')).toBe(`/s/work/runs/${RUN_ID}`);
    expect(
      container.querySelector(
        `li[data-plan-node="${ROOT}"] > div > ul[aria-label="Runs in flight"]`,
      ),
    ).toBe(null);
  });

  it('says when the plan is empty', async () => {
    await render({ data: { roots: [], runsTotal: 0 } });

    expect(container.textContent).toContain('This space has no plan yet.');
    expect(container.querySelector('li')).toBe(null);
  });

  it('says what a bound left out: nodes past the walk, and runs past those placed', async () => {
    await render({
      data: { ...PLAN, runsTotal: 3, truncated: { bound: 'nodes', value: 2000 } },
    });

    expect(container.textContent).toContain('more than 2000 nodes');
    expect(container.textContent).toContain('2 more runs in flight for this plan are not shown.');
  });

  it('says the plan could not be read rather than showing an empty one', async () => {
    await render({ error: new Error('Permission denied') });

    expect(container.textContent).toContain('The plan could not be read: Permission denied');
    expect(container.textContent).not.toContain('no plan yet');
  });
});

/** The node's own controls, not those of the nodes nested under it. */
function ownControls(nodeId: string): Element {
  const found = nodeItem(nodeId).querySelector(':scope > div');
  if (!found) throw new Error(`no body for ${nodeId}`);
  return found;
}

function button(scope: Element, text: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!found) throw new Error(`no button reading ${text}`);
  return found;
}

async function click(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.click();
  });
}

async function type(scope: Element, text: string): Promise<void> {
  const field = scope.querySelector('textarea');
  if (!field) throw new Error('no text field');
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('SpacePlanPage — the operator’s writes', () => {
  it('offers an open node done or dropped, a node with open steps under it as a branch, and a closed node nothing', async () => {
    await render({ data: PLAN });

    expect(
      [...ownControls(UNDER_FIRST).querySelectorAll('button')].map((b) => b.textContent),
    ).toEqual(['Mark done', 'Drop']);
    expect(button(ownControls(FIRST), 'Drop branch')).toBeTruthy();
    expect(ownControls(SECOND).querySelectorAll('button')).toHaveLength(0);
  });

  it('marks a node done with how its criteria were met, against the revision the page read', async () => {
    recorded.mutateAsync.mockResolvedValue({ node: {} });
    await render({ data: PLAN });

    await click(button(ownControls(UNDER_FIRST), 'Mark done'));
    const confirm = button(ownControls(UNDER_FIRST), 'Mark done');
    expect(confirm.disabled).toBe(true);
    await type(ownControls(UNDER_FIRST), '  The route and its test landed.  ');
    expect(confirm.disabled).toBe(false);
    await click(confirm);

    expect(recorded.mutateAsync).toHaveBeenCalledWith({
      nodeId: UNDER_FIRST,
      expectedRevision: 1,
      status: 'done',
      outcome: 'The route and its test landed.',
    });
    // The form closes once written; the tree re-reads through the invalidated query.
    expect(ownControls(UNDER_FIRST).querySelector('textarea')).toBe(null);
  });

  it('writes through the plan route: PATCH on the node, the body without its id, the plan re-read', async () => {
    await render({ data: PLAN });

    const mutation = recorded.mutation!;
    expect(mutation.method).toBe('PATCH');
    expect(mutation.path({ nodeId: FIRST })).toBe(`/spaces/${SPACE_ID}/plan/nodes/${FIRST}`);
    expect(
      JSON.parse(mutation.serialize({ nodeId: FIRST, expectedRevision: 2, status: 'dropped' })),
    ).toEqual({ expectedRevision: 2, status: 'dropped' });
    expect(mutation.invalidate).toEqual([['space', SPACE_ID, 'plan']]);
  });

  it('drops a branch with no reason needed, saying the steps under it go with it', async () => {
    recorded.mutateAsync.mockResolvedValue({ node: {} });
    await render({ data: PLAN });

    await click(button(ownControls(FIRST), 'Drop branch'));
    expect(ownControls(FIRST).textContent).toContain(
      'The open steps under it leave the plan with it.',
    );
    await click(button(ownControls(FIRST), 'Drop branch'));

    expect(recorded.mutateAsync).toHaveBeenCalledWith({
      nodeId: FIRST,
      expectedRevision: 1,
      status: 'dropped',
    });
  });

  it('shows a refusal in place, and on a stale revision reads the plan again', async () => {
    recorded.mutateAsync.mockRejectedValue(
      Object.assign(new Error('This step changed since the plan was read: it is at revision 2.'), {
        status: 409,
      }),
    );
    await render({ data: PLAN });

    await click(button(ownControls(UNDER_FIRST), 'Drop'));
    await click(button(ownControls(UNDER_FIRST), 'Drop'));

    expect(ownControls(UNDER_FIRST).querySelector('[role="alert"]')?.textContent).toContain(
      'it is at revision 2',
    );
    expect(recorded.refetch).toHaveBeenCalledTimes(1);
  });

  it('does not re-read the plan for a refusal that is not about the revision', async () => {
    recorded.mutateAsync.mockRejectedValue(
      Object.assign(new Error('Permission denied'), { status: 403 }),
    );
    await render({ data: PLAN });

    await click(button(ownControls(UNDER_FIRST), 'Drop'));
    await click(button(ownControls(UNDER_FIRST), 'Drop'));

    expect(ownControls(UNDER_FIRST).textContent).toContain('Permission denied');
    expect(recorded.refetch).not.toHaveBeenCalled();
  });

  it('asks a decision for the operator’s choice, and records it as the outcome', async () => {
    const DECISION = '00000000-0000-4000-8000-0000000000a5';
    const ORPHAN = '00000000-0000-4000-8000-0000000000a6';
    recorded.mutateAsync.mockResolvedValue({ node: {} });
    await render({
      data: {
        roots: [
          treeNode(DECISION, null, 'Where the decide answer is recorded', {
            kind: 'decide',
            revision: 3,
          }),
          treeNode(SECOND, null, 'A dropped branch', {
            status: 'dropped',
            position: 1,
            children: [treeNode(ORPHAN, SECOND, 'A choice left behind', { kind: 'decide' })],
          }),
        ],
        runsTotal: 0,
      },
    });

    expect(ownControls(DECISION).textContent).toContain('Waiting on your decision');
    expect(ownControls(ORPHAN).textContent).not.toContain('Waiting on your decision');

    await click(button(ownControls(DECISION), 'Decide'));
    expect(ownControls(DECISION).querySelector('textarea')?.getAttribute('aria-label')).toContain(
      'Your decision',
    );
    await type(ownControls(DECISION), 'In the node’s outcome.');
    await click(button(ownControls(DECISION), 'Record decision'));

    expect(recorded.mutateAsync).toHaveBeenCalledWith({
      nodeId: DECISION,
      expectedRevision: 3,
      status: 'done',
      outcome: 'In the node’s outcome.',
    });
  });
});
