/**
 * @vitest-environment jsdom
 */
/**
 * The plan page as the operator sees it (Plan 322 P3.3): a board — a tab per
 * plan with its step count, five columns in which the column is the status,
 * cards carrying labels only, Done folded by day from the plan's own counts —
 * and a side rail that reads a step on demand and holds the operator's own
 * controls (P3.2). Rendered through the screen itself, the design system's
 * primitives as plain elements and every query recorded.
 */
import { act, createContext, createElement, useContext, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PlanNode,
  PlanNodeDetailOutput,
  PlanNodeLink,
  PlanTreeNode,
  PlanTreeOutput,
} from '@aflow/schemas';

interface Mutation {
  path: (input: { nodeId: string }) => string;
  method: string;
  serialize: (input: Record<string, unknown>) => string;
  invalidate: unknown[];
}

interface Answer {
  data?: unknown;
  error?: Error | null;
}

const recorded = vi.hoisted(() => ({
  boardQueries: [] as Array<{ key: unknown[]; path: string }>,
  board: {} as { data?: unknown; isLoading?: boolean; error?: Error | null },
  refetch: vi.fn(),
  /** The rail's read of each node, by id; absent reads as still loading. */
  details: {} as Record<string, Answer>,
  detailQueries: [] as Array<{ key: unknown[]; path: string; staleTime?: number }>,
  detailRefetch: vi.fn(),
  findings: {} as Record<string, Answer>,
  runPages: {} as Record<string, Answer>,
  linkQueries: [] as Array<{ key: unknown[]; path: string }>,
  mutation: undefined as Mutation | undefined,
  /** The open write's mutation: Approve and Resume (Plan 332 D6). */
  openMutation: undefined as Mutation | undefined,
  mutateAsync: vi.fn(),
  narrow: false,
}));

vi.mock('@aflow/design-system', () => {
  const passed = (props: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(props).filter(
        ([key]) =>
          key.startsWith('data-') ||
          key.startsWith('aria-') ||
          ['role', 'title', 'onClick', 'onKeyDown', 'tabIndex', 'style'].includes(key),
      ),
    );
  const block =
    (tag: string) =>
    ({ children, ...rest }: { children?: ReactNode; [key: string]: unknown }) =>
      createElement(tag, passed(rest), children);
  const TabsContext = createContext<(id: string) => void>(() => undefined);
  return {
    Badge: ({ children, variant }: { children?: ReactNode; variant?: string }) =>
      createElement('span', { 'data-badge': variant ?? 'neutral' }, children),
    Card: block('div'),
    CardBody: block('div'),
    Column: block('div'),
    Row: block('div'),
    Heading: block('h2'),
    PageContainer: block('main'),
    Text: block('span'),
    Tabs: ({ children, onChange }: { children?: ReactNode; onChange: (id: string) => void }) =>
      createElement(TabsContext.Provider, { value: onChange }, children),
    TabList: block('div'),
    Tab: function Tab({
      id,
      children,
      count,
    }: {
      id: string;
      children?: ReactNode;
      count?: number;
    }) {
      const onChange = useContext(TabsContext);
      return createElement(
        'button',
        { type: 'button', role: 'tab', 'data-tab': id, onClick: () => onChange(id) },
        children,
        count !== undefined ? createElement('span', { 'data-count': '' }, String(count)) : null,
      );
    },
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? createElement('div', { role: 'dialog' }, children) : null,
    Button: ({
      children,
      onClick,
      disabled,
      ...rest
    }: {
      children?: ReactNode;
      onClick?: (event: { stopPropagation: () => void }) => void;
      disabled?: boolean;
      [key: string]: unknown;
    }) =>
      createElement(
        'button',
        { ...passed(rest), type: 'button', onClick, disabled, role: undefined },
        children,
      ),
    Textarea: (props: Record<string, unknown>) =>
      createElement('textarea', {
        'aria-label': props['aria-label'],
        value: props['value'],
        onChange: props['onChange'],
        disabled: props['disabled'],
      }),
    useMediaQuery: () => recorded.narrow,
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
  useApiQuery: (options: { key: unknown[]; path: string; staleTime?: number }) => {
    const [, , , kind, nodeId, sub, linkKind, cursor] = options.key as string[];
    if (kind === 'board') {
      recorded.boardQueries.push(options);
      return {
        data: undefined,
        isLoading: false,
        error: null,
        refetch: recorded.refetch,
        ...recorded.board,
      };
    }
    if (sub === 'links') {
      recorded.linkQueries.push(options);
      const answer =
        linkKind === 'finding'
          ? recorded.findings[nodeId!]
          : recorded.runPages[`${nodeId!}:${cursor ?? ''}`];
      return { data: answer?.data, error: answer?.error ?? null, refetch: vi.fn() };
    }
    recorded.detailQueries.push(options);
    const answer = recorded.details[nodeId!];
    return {
      data: answer?.data,
      error: answer?.error ?? null,
      isLoading: answer === undefined,
      refetch: recorded.detailRefetch,
    };
  },
  useApiMutation: (options: Mutation) => {
    if (options.path({ nodeId: 'probe' }).endsWith('/open')) recorded.openMutation = options;
    else recorded.mutation = options;
    return { mutateAsync: recorded.mutateAsync };
  },
}));

const SPACE_ID = '00000000-0000-4000-8000-000000000002';
const R322 = '00000000-0000-4000-8000-0000000000a1';
const P3 = '00000000-0000-4000-8000-0000000000a2';
const NEXT = '00000000-0000-4000-8000-0000000000a3';
const BOARD = '00000000-0000-4000-8000-0000000000a4';
const DECISION = '00000000-0000-4000-8000-0000000000a5';
const LANDED = '00000000-0000-4000-8000-0000000000a6';
const SKETCH = '00000000-0000-4000-8000-0000000000a7';
const ARTICLE = '00000000-0000-4000-8000-0000000000a8';
const API_STEP = '00000000-0000-4000-8000-0000000000c1';
const PAGE_STEP = '00000000-0000-4000-8000-0000000000c2';
const R315 = '00000000-0000-4000-8000-0000000000b1';
const STEP_315 = '00000000-0000-4000-8000-0000000000b2';
const RUN_ID = '00000000-0000-4000-8000-0000000000f1';
const ENDED_RUN_ID = '00000000-0000-4000-8000-0000000000f2';
const PR = 'https://github.com/aflowai/aflow/pull/181';
const MERGED_PR = 'https://github.com/aflowai/aflow/pull/176';
const PLAN_315_TAB = 'Plan 315 · the loop runs itself53';

/** Local times, so the reader's day is the test's to set. */
const at = (month: number, day: number, hour = 9) =>
  new Date(2026, month - 1, day, hour).toISOString();
const NOW = new Date(2026, 9, 22, 15, 0);

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
    updatedAt: at(10, 5),
    createdAt: at(10, 5),
    goalHead: `Goal of ${title}.`,
    counts: { runs: 1, pullRequests: 0, findings: 0, documents: 0, inFlightRuns: 0 },
    rounds: 0,
    activity: 'idle',
    children: [],
    ...extra,
  };
}

const PLAN: PlanTreeOutput = {
  roots: [
    treeNode(R322, null, 'Plan 322 · plans are platform records', {
      activity: 'in_flight',
      progress: { done: 0, total: 2 },
      children: [
        treeNode(P3, R322, 'P3 — Seen by the operator', {
          activity: 'in_flight',
          progress: { done: 1, total: 4 },
          children: [
            treeNode(NEXT, P3, 'P3.4 live exit', { status: 'waiting' }),
            treeNode(BOARD, P3, 'P3.3 the board', {
              activity: 'in_flight',
              counts: { runs: 8, pullRequests: 1, findings: 2, documents: 0, inFlightRuns: 1 },
              rounds: 2,
              pullRequest: { url: PR, merged: false },
              progress: { done: 2, total: 2 },
              children: [
                treeNode(API_STEP, BOARD, 'API', { status: 'done', closedAt: at(9, 20) }),
                treeNode(PAGE_STEP, BOARD, 'Page', { status: 'done', closedAt: at(9, 20) }),
              ],
            }),
            treeNode(DECISION, P3, 'Where the decide answer is recorded', {
              kind: 'decide',
              revision: 3,
            }),
            treeNode(LANDED, P3, 'P3.2 operator writes', {
              status: 'done',
              closedAt: at(10, 22),
              pullRequest: { url: MERGED_PR, merged: true, mergeSha: '93ce25659c0c' },
            }),
            treeNode(SKETCH, P3, 'P3.0 a sketch', { status: 'dropped', closedAt: at(10, 6) }),
          ],
        }),
        treeNode(ARTICLE, R322, 'Write the help article', {
          counts: { runs: 0, pullRequests: 0, findings: 0, documents: 0, inFlightRuns: 0 },
        }),
      ],
    }),
    treeNode(R315, null, 'Plan 315 · the loop runs itself', {
      position: 1,
      status: 'done',
      closedAt: at(10, 22),
      children: [
        treeNode(STEP_315, R315, 'F116 crash restarts', { status: 'done', closedAt: at(10, 22) }),
      ],
    }),
  ],
  tallies: [
    {
      rootId: R322,
      steps: 10,
      done: 3,
      active: 3,
      decide: 1,
      dropped: 1,
      doneByDay: [
        { day: '2026-10-22', count: 1 },
        { day: '2026-09-20', count: 2 },
      ],
    },
    {
      rootId: R315,
      steps: 53,
      done: 53,
      active: 0,
      decide: 0,
      dropped: 0,
      doneByDay: [
        { day: '2026-10-22', count: 1 },
        { day: '2026-10-21', count: 2 },
        { day: '2026-10-20', count: 30 },
        { day: '2026-10-05', count: 20 },
      ],
    },
  ],
};

/** The board with one step's status changed. */
function withStatus(nodeId: string, status: PlanTreeNode['status']): PlanTreeOutput {
  const restatus = (node: PlanTreeNode): PlanTreeNode => ({
    ...node,
    ...(node.nodeId === nodeId ? { status } : {}),
    children: node.children.map(restatus),
  });
  return { ...PLAN, roots: PLAN.roots.map(restatus) };
}

/** A node as the rail reads it in full. */
function fullNode(nodeId: string, title: string, extra: Partial<PlanNode> = {}): PlanNode {
  return {
    nodeId,
    spaceId: SPACE_ID,
    parentId: P3,
    kind: 'execute',
    title,
    goal: `The whole goal of ${title}.`,
    criteria: `Criteria of ${title}.`,
    status: 'active',
    revision: 1,
    position: 0,
    createdAt: at(10, 5),
    updatedAt: at(10, 5),
    ...extra,
  };
}

function detail(node: PlanNode, extra: Partial<PlanNodeDetailOutput> = {}): Answer {
  const data: PlanNodeDetailOutput = {
    node,
    children: [],
    childrenTotal: 0,
    links: [],
    linksTotal: 0,
    runs: [],
    runsTotal: 0,
    ...extra,
  };
  return { data };
}

function runLink(ref: string, label: string, createdAt: string): PlanNodeLink {
  return { nodeId: BOARD, kind: 'run', ref, label, createdAt };
}

let container: HTMLDivElement;
let root: Root;

async function render(board: typeof recorded.board = { data: PLAN }): Promise<void> {
  recorded.board = board;
  await act(async () => {
    root.render(createElement(SpacePlanPage));
  });
}

function column(id: string): Element {
  const found = container.querySelector(`[data-plan-column="${id}"]`);
  if (!found) throw new Error(`no column ${id}`);
  return found;
}

function cardIds(scope: Element): string[] {
  return [...scope.querySelectorAll('[data-plan-card]')].map(
    (c) => c.getAttribute('data-plan-card') ?? '',
  );
}

function card(nodeId: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-plan-card="${nodeId}"]`);
  if (!found) throw new Error(`no card ${nodeId}`);
  return found;
}

function rail(): Element {
  const found = container.querySelector('[data-plan-rail]');
  if (!found) throw new Error('no rail');
  return found;
}

function filter(name: string): Element {
  const found = container.querySelector(`[data-plan-filter="${name}"]`);
  if (!found) throw new Error(`no filter ${name}`);
  return found;
}

function button(scope: Element, text: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!found) throw new Error(`no button reading ${text}`);
  return found;
}

async function click(target: HTMLElement): Promise<void> {
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

function lastBoardQuery() {
  const query = recorded.boardQueries.at(-1);
  if (!query) throw new Error('no board query');
  return { query, url: new URL(query.path, 'http://x') };
}

function folds(): string[][] {
  return [...column('done').querySelectorAll('[data-plan-done-group] > button')].map((b) => [
    b.textContent ?? '',
    b.getAttribute('aria-expanded') ?? '',
  ]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  recorded.boardQueries = [];
  recorded.board = {};
  recorded.refetch.mockReset();
  recorded.details = {
    [BOARD]: detail(fullNode(BOARD, 'P3.3 the board')),
    [NEXT]: detail(fullNode(NEXT, 'P3.4 live exit', { status: 'waiting' })),
  };
  recorded.detailQueries = [];
  recorded.detailRefetch.mockReset();
  recorded.findings = {};
  recorded.runPages = {};
  recorded.linkQueries = [];
  recorded.mutation = undefined;
  recorded.openMutation = undefined;
  recorded.mutateAsync.mockReset();
  recorded.narrow = false;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

describe('SpacePlanPage — the board', () => {
  it('reads the board under the space’s plan key, done steps from today, in the reader’s time zone', async () => {
    await render();

    const { query, url } = lastBoardQuery();
    expect(query.key.slice(0, 4)).toEqual(['space', SPACE_ID, 'plan', 'board']);
    expect(url.pathname).toBe(`/spaces/${SPACE_ID}/plan`);
    expect(url.searchParams.get('closedSince')).toBe(new Date(2026, 9, 22).toISOString());
    expect(url.searchParams.get('tz')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('shows a tab per plan with its step count, and the selected plan’s title and tallies', async () => {
    await render();

    const tabs = [...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(['Plan 322 · plans are platform records10', PLAN_315_TAB]);
    expect(container.querySelector(`[data-plan-tally="${R322}"]`)?.textContent).toBe(
      '3 done3 active1 decide1 dropped',
    );

    await click(button(container, PLAN_315_TAB));
    expect(container.querySelector(`[data-plan-tally="${R315}"]`)?.textContent).toBe(
      '53 done0 active0 decide0 dropped',
    );
  });

  it('places each step in the column of its status, a dash in an empty one', async () => {
    await render();

    expect(cardIds(column('next'))).toEqual([NEXT]);
    expect(cardIds(column('progress'))).toEqual([P3, BOARD, ARTICLE]);
    expect(cardIds(column('decide'))).toEqual([DECISION]);
    expect(cardIds(column('dropped'))).toEqual([SKETCH]);
    expect(column('next').querySelector('[data-plan-column-header]')?.textContent).toBe('Up next1');

    await click(button(filter('Activity'), 'In flight'));
    expect(cardIds(column('next'))).toEqual([]);
    expect(column('next').textContent).toContain('–');
  });

  it('carries labels only on a card: phase, runs in flight, pull request, rounds, subtasks', async () => {
    await render();

    const board = card(BOARD);
    const badges = [...board.querySelectorAll('[data-badge]')].map((b) => [
      b.getAttribute('data-badge'),
      b.textContent,
    ]);
    expect(badges).toEqual([
      ['neutral', 'P3'],
      ['running', 'Running 1'],
      ['info', '#181'],
      ['neutral', 'Rounds 2'],
    ]);
    expect(board.querySelector('[data-plan-progress]')?.textContent).toBe('2/2');
    expect(board.textContent).not.toContain('Goal of');

    expect(card(ARTICLE).querySelector('[data-badge]')).toBe(null);
    for (const id of [P3, NEXT, BOARD, ARTICLE]) {
      expect(card(id).textContent).not.toContain('Operator');
    }
    expect(card(LANDED).querySelector('[data-badge="success"]')?.textContent).toBe('#176');
    expect(card(SKETCH).querySelector('span')?.style.textDecoration).toBe('line-through');
    expect(card(DECISION).style.borderLeft).toContain('var(--color-warning-default)');
    expect(button(card(DECISION), 'Decide')).toBeTruthy();
  });

  it('folds Done by day from the plan’s counts, only the first fold open', async () => {
    await render();
    await click(button(container, PLAN_315_TAB));

    expect(folds()).toEqual([
      ['Today · 1', 'true'],
      ['Yesterday · 2', 'false'],
      ['Oct 5 – 20 · 50', 'false'],
    ]);
    // Every one of the 53 is a fold away; only today's is a card.
    expect(cardIds(column('done'))).toEqual([STEP_315]);
    expect(column('done').querySelector('[data-plan-column-header]')?.textContent).toBe('Done53');
  });

  it('reads an earlier fold’s steps when it is opened, from the first day it covers', async () => {
    await render();
    await click(button(container, PLAN_315_TAB));

    await click(button(column('done'), 'Oct 5 – 20 · 50'));

    expect(lastBoardQuery().url.searchParams.get('closedSince')).toBe(
      new Date(2026, 9, 5).toISOString(),
    );
    expect(folds()[2]).toEqual(['Oct 5 – 20 · 50', 'true']);
  });

  it('opens the first fold, and reads its steps, where nothing closed today', async () => {
    const quiet: PlanTreeOutput = {
      ...PLAN,
      tallies: PLAN.tallies.map((t) =>
        t.rootId === R322 ? { ...t, doneByDay: [{ day: '2026-09-20', count: 2 }] } : t,
      ),
    };
    await render({ data: quiet });

    expect(lastBoardQuery().url.searchParams.get('closedSince')).toBe(
      new Date(2026, 8, 20).toISOString(),
    );
    expect(folds()).toEqual([['Sep 20 · 2', 'true']]);
    expect(cardIds(column('done'))).toEqual([API_STEP, PAGE_STEP]);
  });

  it('narrows the Done column to the window chosen', async () => {
    await render();
    await click(button(container, PLAN_315_TAB));

    await click(button(filter('Done'), 'Today'));

    expect(folds().map(([label]) => label)).toEqual(['Today · 1']);
  });

  it('filters by phase and by activity', async () => {
    await render();

    await click(button(filter('Phase'), 'P3'));
    expect(cardIds(column('progress'))).toEqual([P3, BOARD]);

    await click(button(filter('Phase'), 'All'));
    await click(button(filter('Activity'), 'In flight'));
    expect(cardIds(column('progress'))).toEqual([P3, BOARD]);
    expect(cardIds(column('decide'))).toEqual([]);

    await click(button(filter('Activity'), 'Idle'));
    expect(cardIds(column('progress'))).toEqual([ARTICLE]);
    expect(cardIds(column('decide'))).toEqual([DECISION]);
  });

  it('explains In flight and Idle where the filter is, and which idle steps wait on the reader', async () => {
    await render();

    const help = container.querySelector('[data-plan-activity-help]');
    expect(help?.contains(filter('Activity'))).toBe(true);
    const text = help?.textContent ?? '';
    expect(text).toContain('In flight — a run is working on the step or one under it');
    expect(text).toContain('Idle — no run is on it now');
    expect(text).toContain(
      'Only the idle steps under Needs you — decisions and blocked steps — wait on you.',
    );
    expect(text).not.toContain('Neither asks anything of you');
  });

  it('says when the space has no plan, and when the plan could not be read', async () => {
    await render({ data: { roots: [], tallies: [] } });
    expect(container.textContent).toContain('No plan yet');

    root.unmount();
    root = createRoot(container);
    await render({ error: new Error('Permission denied') });
    expect(container.textContent).toContain('The plan could not be read: Permission denied');
  });

  it('stacks the columns below 900px and opens the rail as a dialog', async () => {
    recorded.narrow = true;
    await render();

    expect(container.querySelector('[data-plan-board]')?.getAttribute('data-layout')).toBe(
      'stacked',
    );
    await click(card(BOARD));
    expect(container.querySelector('[role="dialog"] [data-plan-rail]')).not.toBe(null);
  });
});

describe('SpacePlanPage — the rail', () => {
  it('reads the step on demand when its card is opened, and shows its text there', async () => {
    recorded.details[BOARD] = detail(fullNode(BOARD, 'P3.3 the board'), {
      links: [
        runLink(ENDED_RUN_ID, 'review-local-changes completed', at(10, 21, 14)),
        runLink('00000000-0000-4000-8000-0000000000f3', 'commission-change failed', at(10, 21)),
      ],
      linksTotal: 8,
      runs: [
        {
          runId: RUN_ID,
          slug: 'commission-change',
          status: 'running',
          nodeId: BOARD,
          startedAt: at(10, 22, 10),
        },
      ],
      runsTotal: 1,
    });
    recorded.findings[BOARD] = detail(fullNode(BOARD, 'P3.3 the board'), {
      links: [{ nodeId: BOARD, kind: 'finding', ref: 'F121', createdAt: at(10, 21) }],
      linksTotal: 1,
    });
    await render();
    expect(recorded.detailQueries).toHaveLength(0);

    await click(card(BOARD));

    expect(recorded.detailQueries.at(-1)).toMatchObject({
      key: ['space', SPACE_ID, 'plan', 'node', BOARD],
      path: `/spaces/${SPACE_ID}/plan/nodes/${BOARD}?linkKind=run&limit=5`,
      staleTime: 0,
    });
    expect(recorded.linkQueries.map((q) => q.path)).toContain(
      `/spaces/${SPACE_ID}/plan/nodes/${BOARD}?linkKind=finding&limit=50`,
    );
    const shown = rail();
    expect(shown.textContent).toContain('The whole goal of P3.3 the board.');
    expect(shown.textContent).toContain('Done whenCriteria of P3.3 the board.');
    expect(shown.textContent).toContain('Rounds 2');
    expect(
      shown.querySelector('[data-plan-rail-section="Carried forward"]')?.textContent,
    ).toContain('F121');
    const runs = shown.querySelector('[data-plan-rail-section="Runs"]')!;
    expect(
      [...runs.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['Commission', `/s/work/runs/${RUN_ID}`],
      ['Review', `/s/work/runs/${ENDED_RUN_ID}`],
      ['Commission', '/s/work/runs/00000000-0000-4000-8000-0000000000f3'],
    ]);
    expect(runs.textContent).toContain('failed');
    expect(button(runs, 'All runs · 8')).toBeTruthy();
  });

  it('pages every run of the step under All runs', async () => {
    recorded.details[BOARD] = detail(fullNode(BOARD, 'P3.3 the board'), {
      links: [runLink(ENDED_RUN_ID, 'commission-change completed', at(10, 21))],
      linksTotal: 3,
    });
    recorded.runPages[`${BOARD}:`] = detail(fullNode(BOARD, 'P3.3 the board'), {
      links: [
        runLink(ENDED_RUN_ID, 'commission-change completed', at(10, 21)),
        runLink(
          '00000000-0000-4000-8000-0000000000f4',
          'publish-local-changes completed',
          at(10, 20),
        ),
      ],
      linksTotal: 3,
      nextCursor: 'page-2',
    });
    recorded.runPages[`${BOARD}:page-2`] = detail(fullNode(BOARD, 'P3.3 the board'), {
      links: [
        runLink(
          '00000000-0000-4000-8000-0000000000f5',
          'review-local-changes completed',
          at(10, 19),
        ),
      ],
      linksTotal: 3,
    });
    await render();
    await click(card(BOARD));

    await click(button(rail(), 'All runs · 3'));
    await click(button(rail(), 'More'));

    expect(recorded.linkQueries.map((q) => q.path)).toContain(
      `/spaces/${SPACE_ID}/plan/nodes/${BOARD}?linkKind=run&limit=50&cursor=page-2`,
    );
    const all = rail().querySelector('[data-plan-all-runs]')!;
    expect([...all.querySelectorAll('a')].map((a) => a.textContent)).toEqual([
      'Commission',
      'Publish',
      'Review',
    ]);
    expect([...all.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('More');
  });

  it('shows a closed step’s outcome boxed, its merge and when it closed, and no controls', async () => {
    recorded.details[LANDED] = detail(
      fullNode(LANDED, 'P3.2 operator writes', {
        status: 'done',
        outcome: 'Merged as #176; the controls work.',
        closedAt: at(10, 22),
      }),
    );
    await render();

    await click(card(LANDED));

    const shown = rail();
    expect(shown.querySelector('[data-plan-outcome]')?.textContent).toBe(
      'Merged as #176; the controls work.',
    );
    expect(shown.textContent).toContain('93ce256');
    expect(shown.textContent).toContain('Closed ');
    expect([...shown.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Close']);
  });

  it('collapses Dropped to a strip while the rail is open', async () => {
    await render();
    expect(column('dropped').getAttribute('data-collapsed')).toBe(null);

    await click(card(BOARD));
    expect(column('dropped').getAttribute('data-collapsed')).toBe('true');

    await click(button(rail(), 'Close'));
    expect(container.querySelector('[data-plan-rail]')).toBe(null);
    expect(cardIds(column('dropped'))).toEqual([SKETCH]);
  });
});

describe('SpacePlanPage — the operator’s writes from the rail', () => {
  it('opens a decision from its card’s Decide, and records the choice as its outcome', async () => {
    recorded.mutateAsync.mockResolvedValue({ node: {} });
    recorded.details[DECISION] = detail(
      fullNode(DECISION, 'Where the decide answer is recorded', {
        kind: 'decide',
        revision: 3,
        goal: 'In the node’s outcome, or as a link to the item?',
        criteria: 'One is chosen and stated in the decision record.',
      }),
    );
    await render();

    await click(button(card(DECISION), 'Decide'));

    const shown = rail();
    expect(shown.getAttribute('data-plan-rail')).toBe(DECISION);
    expect(shown.textContent).toContain(
      'Decided whenOne is chosen and stated in the decision record.',
    );
    expect(shown.querySelector('textarea')?.getAttribute('aria-label')).toContain('Your decision');
    await type(shown, 'In the node’s outcome.');
    await click(button(rail(), 'Record decision'));

    expect(recorded.mutateAsync).toHaveBeenCalledWith({
      nodeId: DECISION,
      expectedRevision: 3,
      status: 'done',
      outcome: 'In the node’s outcome.',
    });
  });

  it('marks a step done with how its criteria were met, against the revision the rail read', async () => {
    recorded.mutateAsync.mockResolvedValue({ node: {} });
    recorded.details[BOARD] = detail(fullNode(BOARD, 'P3.3 the board', { revision: 5 }));
    await render();
    await click(card(BOARD));

    await click(button(rail(), 'Mark done'));
    expect(rail().textContent).toContain('This step changed since the plan was read');
    expect(button(rail(), 'Mark done').disabled).toBe(true);
    await type(rail(), '  The board renders.  ');
    expect(button(rail(), 'Mark done').disabled).toBe(false);
    await click(button(rail(), 'Mark done'));

    expect(recorded.mutateAsync).toHaveBeenCalledWith({
      nodeId: BOARD,
      expectedRevision: 5,
      status: 'done',
      outcome: 'The board renders.',
    });
    expect(rail().querySelector('textarea')).toBe(null);
  });

  it('writes through the plan route: PATCH on the node, the body without its id, the plan re-read', async () => {
    await render();

    const mutation = recorded.mutation!;
    expect(mutation.method).toBe('PATCH');
    expect(mutation.path({ nodeId: BOARD })).toBe(`/spaces/${SPACE_ID}/plan/nodes/${BOARD}`);
    expect(
      JSON.parse(mutation.serialize({ nodeId: BOARD, expectedRevision: 2, status: 'dropped' })),
    ).toEqual({ expectedRevision: 2, status: 'dropped' });
    expect(mutation.invalidate).toEqual([['space', SPACE_ID, 'plan']]);
  });

  it('drops a branch with no reason needed, saying the open steps under it go with it', async () => {
    recorded.mutateAsync.mockResolvedValue({ node: {} });
    recorded.details[P3] = detail(fullNode(P3, 'P3 — Seen by the operator'));
    await render();
    await click(card(P3));

    await click(button(rail(), 'Drop branch'));
    expect(rail().textContent).toContain('The open steps under it leave the plan with it.');
    await click(button(rail(), 'Drop branch'));

    expect(recorded.mutateAsync).toHaveBeenCalledWith({
      nodeId: P3,
      expectedRevision: 1,
      status: 'dropped',
    });
  });

  it('shows a refusal in place, reads the step again, and on a stale revision the board too', async () => {
    recorded.mutateAsync.mockRejectedValue(
      Object.assign(new Error('This step changed since the plan was read: it is at revision 2.'), {
        status: 409,
      }),
    );
    await render();
    await click(card(NEXT));

    await click(button(rail(), 'Drop'));
    await click(button(rail(), 'Drop'));

    expect(rail().querySelector('[role="alert"]')?.textContent).toContain('it is at revision 2');
    expect(recorded.detailRefetch).toHaveBeenCalledTimes(1);
    expect(recorded.refetch).toHaveBeenCalledTimes(1);
  });

  it('does not re-read the board for a refusal that is not about the revision', async () => {
    recorded.mutateAsync.mockRejectedValue(
      Object.assign(new Error('Permission denied'), { status: 403 }),
    );
    await render();
    await click(card(NEXT));

    await click(button(rail(), 'Drop'));
    await click(button(rail(), 'Drop'));

    expect(rail().textContent).toContain('Permission denied');
    expect(recorded.refetch).not.toHaveBeenCalled();
  });

  it('approves a blocked step through the open write, the operator’s reason its note’s first line', async () => {
    recorded.mutateAsync.mockResolvedValue({ node: {} });
    recorded.details[ARTICLE] = detail(
      fullNode(ARTICLE, 'Write the help article', {
        parentId: R322,
        status: 'blocked',
        revision: 4,
        note: 'Proposed from the merged plan document; awaits the operator’s approval.',
      }),
    );
    await render({ data: withStatus(ARTICLE, 'blocked') });
    await click(card(ARTICLE));

    await click(button(rail(), 'Approve'));
    await type(rail(), '  Go ahead.  ');
    await click(button(rail(), 'Approve'));

    expect(recorded.mutateAsync).toHaveBeenCalledWith({
      nodeId: ARTICLE,
      expectedRevision: 4,
      why: 'Go ahead.',
    });
    const open = recorded.openMutation!;
    expect(open.method).toBe('PATCH');
    expect(open.path({ nodeId: ARTICLE })).toBe(`/spaces/${SPACE_ID}/plan/nodes/${ARTICLE}/open`);
    expect(
      JSON.parse(open.serialize({ nodeId: ARTICLE, expectedRevision: 4, why: 'Go ahead.' })),
    ).toEqual({ expectedRevision: 4, why: 'Go ahead.' });
    expect(open.invalidate).toEqual([['space', SPACE_ID, 'plan']]);
  });

  it('calls it Resume on a step the stream stopped, and offers neither on an open one', async () => {
    recorded.details[ARTICLE] = detail(
      fullNode(ARTICLE, 'Write the help article', {
        parentId: R322,
        status: 'blocked',
        note: 'Blocked: 3 rounds ended without a pull request.',
      }),
    );
    await render({ data: withStatus(ARTICLE, 'blocked') });
    await click(card(ARTICLE));
    expect(button(rail(), 'Resume')).toBeTruthy();

    await click(card(BOARD));
    expect([...rail().querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
      'Approve',
    );
  });

  it('holds the write until the step is read, and offers none on a step the read finds closed', async () => {
    delete recorded.details[NEXT];
    await render();
    await click(card(NEXT));

    await click(button(rail(), 'Drop'));
    expect(rail().textContent).toContain('Reading the step…');
    expect(button(rail(), 'Drop').disabled).toBe(true);

    await click(button(rail(), 'Cancel'));
    recorded.details[NEXT] = detail(
      fullNode(NEXT, 'P3.4 live exit', { status: 'done', revision: 2, outcome: 'Done elsewhere.' }),
    );
    await render();
    expect(container.querySelector('[data-plan-close]')).toBe(null);
    expect(rail().querySelector('[data-plan-outcome]')?.textContent).toBe('Done elsewhere.');
    expect(recorded.mutateAsync).not.toHaveBeenCalled();
  });
});
