/**
 * @vitest-environment jsdom
 */
/**
 * The plan page as the operator sees it (Plan 322 P3.3, Plan 332 P1–P4): the
 * overview it lands on — Needs you, In flight and Up next across every plan,
 * Approve on a blocked row, a row opening the rail over it — and the
 * plans as a list with each one's state, Finished and Closed below the open
 * ones, Move up and Move down on open plans and Close plan on finished ones;
 * the chosen plan's board — its header, five columns saying what the loop is
 * doing with each step, Next on the walk's step, cards carrying labels only,
 * Done folded by day from the plan's own counts, no Activity filter and no
 * Done window — and a side rail that reads a step on demand and holds the
 * operator's own controls (P3.2); where the operator is, in the URL. Rendered through the screen itself, the design system's
 * primitives as plain elements and every query recorded.
 */
import {
  act,
  createContext,
  createElement,
  useContext,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLAN_NODE_APPROVED_HEAD,
  PLAN_NODE_OPEN_WHY_MAX_CHARS,
  PlanNodeOpenSchema,
  planNodeOperatorLine,
} from '@aflow/schemas';
import type {
  PlanLaneItem,
  PlanNode,
  PlanNodeCard,
  PlanNodeDetailOutput,
  PlanOverviewLanes,
  PlanNodeLink,
  PlanRootTally,
  PlanTreeNode,
} from '@aflow/schemas';

/** The space's plans as the fixtures hold them: each root's tree and its tally, which the reads are cut from. */
interface SpaceFixture {
  roots: PlanTreeNode[];
  tallies: PlanRootTally[];
  truncated?: { bound: 'limit' | 'depth' | 'nodes'; value: number };
  /** The rows counted short, by root, and the bound each names. */
  rowTruncated?: Record<string, { bound: 'depth' | 'nodes'; value: number }>;
  /** The bound that cut the list of plans short. */
  listTruncated?: { bound: 'nodes'; value: number };
  /** The overview's lanes; empty where absent. */
  lanes?: PlanOverviewLanes;
}

interface Answer {
  data?: unknown;
  error?: Error | null;
  /** False for a detail cached from an earlier opening, before the rail's own read answers. */
  fetchedAfterMount?: boolean;
}

/** The page's URL as the router holds it, and every push. */
const nav = vi.hoisted(() => ({
  search: '',
  pushed: [] as string[],
  listeners: new Set<() => void>(),
}));

const recorded = vi.hoisted(() => ({
  boardQueries: [] as Array<{ key: unknown[]; path: string }>,
  rowQueries: [] as Array<{ key: unknown[]; path: string }>,
  rowsRefetch: vi.fn(),
  board: {} as { data?: unknown; isLoading?: boolean; error?: Error | null },
  refetch: vi.fn(),
  /** The rail's read of each node, by id; absent reads as still loading. */
  details: {} as Record<string, Answer>,
  detailQueries: [] as Array<{ key: unknown[]; path: string; staleTime?: number }>,
  detailRefetch: vi.fn(),
  findings: {} as Record<string, Answer>,
  /** The conversations linked on each node, by id. */
  conversations: {} as Record<string, Answer>,
  /** The newest plan document linked on each node, by id. */
  documents: {} as Record<string, Answer>,
  runPages: {} as Record<string, Answer>,
  linkQueries: [] as Array<{ key: unknown[]; path: string }>,
  /** Every write the page holds, in the order it declared them. */
  mutations: [] as Array<{
    path: (input: { nodeId: string }) => string;
    method: string;
    serialize: (input: Record<string, unknown>) => string;
    invalidate: unknown[];
  }>,
  /** Each write sent: the route it went to and the body it carried. */
  sent: [] as Array<{ path: string; body: unknown }>,
  mutateAsync: vi.fn(),
  narrow: false,
  /** The space each render subscribed the page's live refresh for. */
  liveRefresh: [] as Array<string | null>,
  /** How many times a CollapsibleSide has mounted. */
  sideMounts: 0,
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
    IconButton: ({
      icon,
      onClick,
      disabled,
      ...rest
    }: {
      icon?: ReactNode;
      onClick?: (event: { stopPropagation: () => void }) => void;
      disabled?: boolean;
      [key: string]: unknown;
    }) => createElement('button', { ...passed(rest), type: 'button', onClick, disabled }, icon),
    Icon: () => null,
    Tooltip: ({ children }: { children?: ReactNode }) => children,
    // Its badge, its fold and its mount as attributes, so a remount, which
    // drops the width dragged, shows as a new mount.
    CollapsibleSide: function CollapsibleSide({
      children,
      label,
      badge,
      collapsed,
      onCollapsedChange,
    }: {
      children?: ReactNode;
      label: string;
      badge?: number;
      collapsed?: boolean;
      onCollapsedChange?: (collapsed: boolean) => void;
    }) {
      const [mount] = useState(() => ++recorded.sideMounts);
      const [internal, setInternal] = useState(false);
      const folded = collapsed ?? internal;
      return createElement(
        'div',
        {
          'data-side': label,
          'data-side-badge': badge,
          'data-side-folded': String(folded),
          'data-side-mount': mount,
        },
        createElement(
          'button',
          {
            type: 'button',
            'data-side-fold': label,
            onClick: () => {
              onCollapsedChange?.(!folded);
              if (collapsed === undefined) setInternal(!folded);
            },
          },
          folded ? `Expand ${label}` : `Collapse ${label}`,
        ),
        folded ? null : children,
      );
    },
    // Marked, so a test reads which content grows and shrinks rather than snaps.
    AnimatedHeight: ({ children, style }: { children?: ReactNode; style?: CSSProperties }) =>
      createElement('div', { 'data-animated-height': '', style }, children),
    Panel: block('div'),
    ScrollArea: block('div'),
    Input: (props: Record<string, unknown>) => createElement('input', props),
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

vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    nav.listeners.add(listener);
    return () => {
      nav.listeners.delete(listener);
    };
  };
  const router = {
    push: (href: string) => {
      nav.pushed.push(href);
      const at = href.indexOf('?');
      nav.search = at < 0 ? '' : href.slice(at + 1);
      for (const listener of nav.listeners) listener();
    },
  };
  return {
    useRouter: () => router,
    usePathname: () => '/s/work/plan',
    useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => nav.search)),
  };
});

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) =>
    createElement('a', { href }, children),
}));

// The orbs pick their asset by theme, and read it to seek its animation.
vi.mock('../providers/theme.js', () => ({
  useTheme: () => ({ theme: 'light', resolvedTheme: 'light', setTheme: () => undefined }),
}));
vi.stubGlobal(
  'fetch',
  vi.fn(() => Promise.resolve({ ok: false, text: () => Promise.resolve('') })),
);

vi.mock('../components/providers.js', () => ({
  useSpaceFromRoute: () => ({ id: SPACE_ID, slug: 'work', slugFromRoute: 'work' }),
}));

vi.mock('../hooks/use-plan-live-refresh.js', () => ({
  spacePlanKey: (spaceId: string) => ['space', spaceId, 'plan'],
  usePlanLiveRefresh: (spaceId: string | null) => {
    recorded.liveRefresh.push(spaceId);
  },
}));

vi.mock('../hooks/useApiQuery.js', () => ({
  useApiQuery: (options: {
    key: unknown[];
    path: string;
    staleTime?: number;
    enabled?: boolean;
  }) => {
    // A disabled query reads nothing.
    if (options.enabled === false) {
      return { data: undefined, error: null, isFetchedAfterMount: false, refetch: vi.fn() };
    }
    const [, , , kind, nodeId, sub, linkKind, cursor] = options.key as string[];
    const space = recorded.board.data as SpaceFixture | undefined;
    if (kind === 'rows') {
      recorded.rowQueries.push(options);
      return {
        data: space !== undefined ? cached(space, 'rows', () => rowsOf(space)) : undefined,
        isLoading: recorded.board.isLoading ?? false,
        error: recorded.board.error ?? null,
        refetch: recorded.rowsRefetch,
      };
    }
    if (kind === 'board') {
      recorded.boardQueries.push(options);
      // The board of the root the key names, cut from the space's fixture.
      const rootId = nodeId;
      const tree = space?.roots.find((r) => r.nodeId === rootId);
      const tally = space?.tallies.find((t) => t.rootId === rootId);
      return {
        data:
          space !== undefined && tree !== undefined && tally !== undefined
            ? cached(space, `board:${rootId!}`, () => ({
                root: tree,
                tally,
                ...(space.truncated !== undefined ? { truncated: space.truncated } : {}),
              }))
            : undefined,
        isLoading: false,
        error: null,
        refetch: recorded.refetch,
      };
    }
    if (sub === 'links') {
      recorded.linkQueries.push(options);
      const answer =
        linkKind === 'finding'
          ? recorded.findings[nodeId!]
          : linkKind === 'conversation'
            ? recorded.conversations[nodeId!]
            : linkKind === 'document'
              ? recorded.documents[nodeId!]
              : recorded.runPages[`${nodeId!}:${cursor ?? ''}`];
      return { data: answer?.data, error: answer?.error ?? null, refetch: vi.fn() };
    }
    recorded.detailQueries.push(options);
    const answer = recorded.details[nodeId!];
    return {
      data: answer?.data,
      error: answer?.error ?? null,
      isLoading: answer === undefined,
      isFetchedAfterMount: answer !== undefined && answer.fetchedAfterMount !== false,
      refetch: recorded.detailRefetch,
    };
  },
  useApiMutation: (options: (typeof recorded.mutations)[number]) => {
    recorded.mutations.push(options);
    return {
      mutateAsync: (input: { nodeId: string } & Record<string, unknown>) => {
        recorded.sent.push({
          path: options.path(input),
          body: JSON.parse(options.serialize(input)) as unknown,
        });
        return recorded.mutateAsync(input) as Promise<unknown>;
      },
    };
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

/**
 * One answer per fixture and read, as a query cache holds it: the same object
 * on every render until the fixture changes, as the page's effects expect.
 */
const answers = new WeakMap<SpaceFixture, Map<string, unknown>>();
function cached<T>(space: SpaceFixture, read: string, build: () => T): T {
  const held = answers.get(space) ?? new Map<string, unknown>();
  answers.set(space, held);
  if (!held.has(read)) held.set(read, build());
  return held.get(read) as T;
}

/** The rows `GET …/plan` answers for a space: each root with its tally's state and, open, its counts. */
function rowsOf(space: SpaceFixture) {
  return {
    roots: space.roots.map((tree) => {
      const tally = space.tallies.find((t) => t.rootId === tree.nodeId)!;
      return {
        nodeId: tree.nodeId,
        title: tree.title,
        status: tree.status,
        position: tree.position,
        revision: tree.revision,
        state: tally.state,
        // A closed plan is closed by rule: its steps are not counted.
        ...(tally.state !== 'closed'
          ? {
              counts: {
                steps: tally.steps,
                needsYou: tally.needsYou,
                inFlight: tally.inFlight,
                upNext: tally.upNext,
                done: tally.done,
                dropped: tally.dropped,
              },
            }
          : {}),
        ...(space.rowTruncated?.[tree.nodeId] !== undefined
          ? { truncated: space.rowTruncated[tree.nodeId] }
          : {}),
        lastWrittenAt: tree.updatedAt,
      };
    }),
    lanes: space.lanes ?? NO_LANES,
    ...(space.listTruncated !== undefined ? { truncated: space.listTruncated } : {}),
  };
}

const NO_LANES: PlanOverviewLanes = {
  needsYou: { items: [], total: 0 },
  inFlight: { items: [], total: 0 },
  upNext: { items: [], total: 0 },
};

const PLAN: SpaceFixture = {
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
      state: 'needs_you',
      steps: 10,
      needsYou: 1,
      inFlight: 3,
      upNext: 2,
      done: 3,
      dropped: 1,
      doneByDay: [
        { day: '2026-10-22', count: 1 },
        { day: '2026-09-20', count: 2 },
      ],
      nextNodeId: NEXT,
    },
    {
      rootId: R315,
      state: 'closed',
      steps: 53,
      needsYou: 0,
      inFlight: 0,
      upNext: 0,
      done: 53,
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
function withStatus(nodeId: string, status: PlanTreeNode['status']): SpaceFixture {
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
    activity: 'idle',
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

function listRow(rootId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-plan-row="${rootId}"]`);
}

/** Chooses a plan from the list, unfolding Closed where it sits there. */
async function choosePlan(rootId: string): Promise<void> {
  if (listRow(rootId) === null) {
    const closed = container.querySelector('[data-plan-list-section="closed"] > button');
    if (closed instanceof HTMLElement) await click(closed);
  }
  const row = listRow(rootId);
  if (!row) throw new Error(`no plan row ${rootId}`);
  await click(row.querySelector('button')!);
}

function rowIds(section: 'open' | 'finished' | 'closed'): string[] {
  const scope = container.querySelector(`[data-plan-list-section="${section}"]`);
  return [...(scope?.querySelectorAll('[data-plan-row]') ?? [])].map(
    (r) => r.getAttribute('data-plan-row') ?? '',
  );
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

/** A button as it is named: its label where it is an icon, else its text. */
function buttonName(b: Element): string {
  return b.getAttribute('aria-label') ?? b.textContent ?? '';
}

function button(scope: Element, text: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((b) => buttonName(b) === text);
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

/** The write the page declared whose route ends in `suffix` after the node's id. */
function mutationFor(suffix: '' | '/open' | '/place') {
  return recorded.mutations.find(
    (m) => m.path({ nodeId: BOARD }) === `/spaces/${SPACE_ID}/plan/nodes/${BOARD}${suffix}`,
  );
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
  recorded.rowQueries = [];
  recorded.rowsRefetch.mockReset();
  recorded.board = {};
  // The board of Plan 322; the overview, where the page lands, is tested on its own.
  nav.search = `plan=${R322}`;
  nav.pushed = [];
  recorded.refetch.mockReset();
  recorded.details = {
    [BOARD]: detail(fullNode(BOARD, 'P3.3 the board')),
    [NEXT]: detail(fullNode(NEXT, 'P3.4 live exit', { status: 'waiting' })),
  };
  recorded.detailQueries = [];
  recorded.detailRefetch.mockReset();
  recorded.detailRefetch.mockResolvedValue({ data: undefined });
  recorded.liveRefresh = [];
  recorded.findings = {};
  recorded.conversations = {};
  recorded.documents = {};
  recorded.runPages = {};
  recorded.linkQueries = [];
  recorded.mutations = [];
  recorded.sent = [];
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
  it('reads the rows and the first open plan’s board under the space’s plan key, done steps from today, in the reader’s time zone', async () => {
    await render();

    expect(recorded.rowQueries.at(-1)).toMatchObject({
      key: ['space', SPACE_ID, 'plan', 'rows'],
      path: `/spaces/${SPACE_ID}/plan`,
    });
    const { query, url } = lastBoardQuery();
    expect(query.key.slice(0, 5)).toEqual(['space', SPACE_ID, 'plan', 'board', R322]);
    expect(url.pathname).toBe(`/spaces/${SPACE_ID}/plan/roots/${R322}`);
    expect(url.searchParams.get('closedSince')).toBe(new Date(2026, 9, 22).toISOString());
    expect(url.searchParams.get('tz')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('keeps itself live on the space’s events, for the space it shows', async () => {
    await render();
    expect(recorded.liveRefresh.length).toBeGreaterThan(0);
    expect(new Set(recorded.liveRefresh)).toEqual(new Set([SPACE_ID]));
  });

  it('shows no tab rail, and the chosen plan’s title and header with its state', async () => {
    await render();

    expect(container.querySelector('[role="tab"]')).toBe(null);
    expect(container.querySelector(`[data-plan-tally="${R322}"]`)?.textContent).toBe(
      'Pending approval4 of 10 closed1 pending3 running2 queued3 done1 dropped',
    );

    await choosePlan(R315);
    expect(container.querySelector(`[data-plan-tally="${R315}"]`)?.textContent).toBe(
      'Closed53 of 53 closed53 done',
    );
  });

  it('places each step in the column of what the loop is doing with it, Needs you first', async () => {
    await render();

    const order = [...container.querySelectorAll('[data-plan-column]')].map((c) =>
      c.getAttribute('data-plan-column'),
    );
    expect(order).toEqual(['needs_you', 'in_flight', 'up_next', 'done', 'dropped']);
    expect(cardIds(column('needs_you'))).toEqual([DECISION]);
    expect(cardIds(column('in_flight'))).toEqual([P3, NEXT, BOARD]);
    expect(cardIds(column('up_next'))).toEqual([ARTICLE]);
    expect(cardIds(column('dropped'))).toEqual([SKETCH]);
    expect(column('up_next').querySelector('[data-plan-column-header]')?.textContent).toBe(
      'Queued1',
    );
  });

  it('marks Next on the step the tally names, and says what holds a waiting step', async () => {
    await render();

    expect(
      [...container.querySelectorAll('[data-plan-next]')].map((c) =>
        c.getAttribute('data-plan-card'),
      ),
    ).toEqual([NEXT]);
    expect(card(NEXT).textContent).toContain('Next');
    expect(card(NEXT).querySelector('[data-plan-waiting]')?.textContent).toBe(
      'Its run ended; the loop advances it when it returns',
    );
    expect(card(ARTICLE).textContent).not.toContain('Next');
  });

  it('shows why a step needs the reader, a step under a closed one included', async () => {
    const STRANDED = '00000000-0000-4000-8000-0000000000b3';
    const stranded: SpaceFixture = {
      ...PLAN,
      roots: PLAN.roots.map((r) =>
        r.nodeId === R315
          ? {
              ...r,
              children: [
                ...r.children,
                treeNode(STRANDED, R315, 'P6.a left open', { position: 1 }),
              ],
            }
          : r,
      ),
    };
    await render({ data: stranded });
    expect(card(DECISION).getAttribute('data-reason')).toBe('decide');
    expect(card(DECISION).textContent).toContain('Decision');

    await choosePlan(R315);
    expect(cardIds(column('needs_you'))).toEqual([STRANDED]);
    expect(card(STRANDED).getAttribute('data-reason')).toBe('stranded');
    expect(card(STRANDED).textContent).toContain('Under a closed step');
  });

  it('renders no Activity filter, no explanation of it and no Done window', async () => {
    await render();
    await choosePlan(R315);

    expect(container.querySelector('[data-plan-filter="Activity"]')).toBe(null);
    expect(container.querySelector('[data-plan-filter="Done"]')).toBe(null);
    expect(container.querySelector('[data-plan-activity-help]')).toBe(null);
    expect(container.textContent).not.toContain('7 days');
    expect(container.textContent).not.toContain('Idle');
  });

  it('carries labels only on a card, each saying what it counts: phase, runs in flight, pull request, rounds, subtasks', async () => {
    await render();

    const board = card(BOARD);
    const badges = [...board.querySelectorAll('[data-badge]')].map((b) => [
      b.getAttribute('data-badge'),
      b.textContent,
    ]);
    expect(badges).toEqual([
      ['running', '1 run in flight'],
      ['info', 'PR #181 · open'],
    ]);
    expect(board.querySelector('[data-plan-card-phase]')?.textContent).toBe('P3');
    expect(board.querySelector('[data-plan-card-rounds]')?.textContent).toBe('2 review rounds');
    expect(board.querySelector('[data-plan-progress]')?.textContent).toBe('2/2 subtasks');
    expect(board.textContent).not.toContain('Goal of');

    expect(card(ARTICLE).querySelector('[data-badge]')).toBe(null);
    for (const id of [P3, NEXT, BOARD, ARTICLE]) {
      expect(card(id).textContent).not.toContain('Operator');
    }
    expect(card(LANDED).querySelector('[data-badge="success"]')?.textContent).toBe(
      'PR #176 · merged',
    );
    expect(
      card(SKETCH).querySelector<HTMLElement>('[data-plan-card-title]')?.style.textDecoration,
    ).toBe('line-through');
    expect(card(DECISION).style.backgroundColor).toBe('var(--color-status-paused-bg)');
    expect(button(card(DECISION), 'Decide')).toBeTruthy();
  });

  it('folds Done by day from the plan’s counts, only the first fold open', async () => {
    await render();
    await choosePlan(R315);

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
    await choosePlan(R315);

    await click(button(column('done'), 'Oct 5 – 20 · 50'));

    expect(lastBoardQuery().url.searchParams.get('closedSince')).toBe(
      new Date(2026, 9, 5).toISOString(),
    );
    expect(folds()[2]).toEqual(['Oct 5 – 20 · 50', 'true']);
  });

  it('opens the first fold, and reads its steps, where nothing closed today', async () => {
    const quiet: SpaceFixture = {
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

  it('filters by phase only where the plan has two or more phases', async () => {
    await render();
    expect(container.querySelector('[data-plan-filter="Phase"]')).toBe(null);

    const ARTICLE_DRAFT = '00000000-0000-4000-8000-0000000000a9';
    const twoPhases: SpaceFixture = {
      ...PLAN,
      roots: PLAN.roots.map((r) =>
        r.nodeId === R322
          ? {
              ...r,
              children: r.children.map((c) =>
                c.nodeId === ARTICLE
                  ? { ...c, children: [treeNode(ARTICLE_DRAFT, ARTICLE, 'Draft it')] }
                  : c,
              ),
            }
          : r,
      ),
    };
    await render({ data: twoPhases });

    await click(button(filter('Phase'), 'P3'));
    expect(cardIds(column('in_flight'))).toEqual([P3, NEXT, BOARD]);
    expect(cardIds(column('up_next'))).toEqual([]);

    await click(button(filter('Phase'), 'Write the hel…'));
    expect(cardIds(column('up_next'))).toEqual([ARTICLE, ARTICLE_DRAFT]);
    expect(cardIds(column('needs_you'))).toEqual([]);
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
      activity: 'in_flight',
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
    expect(shown.textContent).toContain('2 review rounds');
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

  it('shows the note’s first line under Now above the goal, and the whole note folded under Working note', async () => {
    const withNote: SpaceFixture = {
      ...PLAN,
      roots: PLAN.roots.map((r) => ({
        ...r,
        children: r.children.map((c) =>
          c.nodeId === ARTICLE ? { ...c, noteHead: 'Proposed: write it after P3 lands.' } : c,
        ),
      })),
    };
    recorded.details[ARTICLE] = detail(
      fullNode(ARTICLE, 'Write the help article', {
        parentId: R322,
        note: 'Proposed: write it after P3 lands.\nThe board is still moving.',
      }),
    );
    await render({ data: withNote });

    await click(card(ARTICLE));

    const sections = [...rail().querySelectorAll('[data-plan-rail-section]')].map((s) =>
      s.getAttribute('data-plan-rail-section'),
    );
    expect(sections.slice(0, 2)).toEqual(['Now', 'Goal']);
    expect(rail().querySelector('[data-plan-rail-section="Now"]')?.textContent).toBe(
      'NowProposed: write it after P3 lands.',
    );
    const note = rail().querySelector('[data-plan-rail-section="Working note"]')!;
    expect(note.querySelector('[data-plan-note]')).toBe(null);

    await click(button(note, 'Show note'));
    expect(note.querySelector('[data-plan-note]')?.textContent).toBe(
      'Proposed: write it after P3 lands.\nThe board is still moving.',
    );
  });

  it('carries the step’s reason and Next on the rail', async () => {
    await render();

    await click(card(NEXT));
    expect(
      [...rail().querySelectorAll('[data-badge]')].map((b) => b.textContent).slice(0, 2),
    ).toEqual(['Running', 'Next for the loop']);

    await click(card(DECISION));
    expect(
      [...rail().querySelectorAll('[data-badge]')].map((b) => b.textContent).slice(0, 2),
    ).toEqual(['Pending', 'Decision']);
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

  it('shows a closed step’s outcome boxed, its merge and when it closed, and only Reopen', async () => {
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
    expect([...shown.querySelectorAll('button')].map(buttonName)).toEqual(['Close', 'Reopen']);
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

  it('shows carrier recovery pointers while accepting the committed close', async () => {
    const carrierFailure = `Carrier failed for closed node ${BOARD}. Read its linked findings: publish failed`;
    recorded.mutateAsync.mockResolvedValue({ node: {}, carrierFailure });
    recorded.details[BOARD] = detail(fullNode(BOARD, 'P3.3 the board', { revision: 5 }));
    await render();
    await click(card(BOARD));
    await click(button(rail(), 'Mark done'));
    await type(rail(), 'The board renders.');
    await click(button(rail(), 'Mark done'));
    expect(rail().querySelector('textarea')).toBe(null);
    expect(document.body.textContent).toContain(carrierFailure);
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

    const mutation = mutationFor('')!;
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

  it('keeps the revision an open form showed when the plan is read again under it', async () => {
    recorded.mutateAsync.mockResolvedValue({ node: {} });
    await render();
    await click(card(BOARD));
    await click(button(rail(), 'Mark done'));
    await type(rail(), 'The board renders.');

    // A write elsewhere: the page reads a new tree and the rail a new node.
    recorded.details[BOARD] = detail(
      fullNode(BOARD, 'P3.3 the board', { revision: 2, note: 'Proposed: live.' }),
    );
    const moved = structuredClone(PLAN);
    const board = moved.roots[0]!.children[0]!.children.find((n) => n.nodeId === BOARD)!;
    board.revision = 2;
    await render({ data: moved });

    expect(rail().querySelector('textarea')?.value).toBe('The board renders.');
    expect(rail().querySelector('[data-plan-close-moved]')).not.toBe(null);
    await click(button(rail(), 'Mark done'));

    expect(recorded.mutateAsync).toHaveBeenCalledWith({
      nodeId: BOARD,
      expectedRevision: 1,
      status: 'done',
      outcome: 'The board renders.',
    });
  });

  it('pins a reopened card to the rail’s fresh read, not the detail cached from its last opening', async () => {
    recorded.mutateAsync.mockResolvedValue({ node: {} });
    await render();
    await click(card(BOARD));
    await click(button(rail(), 'Close'));

    // Reopened: the cache still holds revision 1 while the rail reads the step again.
    recorded.details[BOARD] = {
      ...detail(fullNode(BOARD, 'P3.3 the board')),
      fetchedAfterMount: false,
    };
    await click(card(BOARD));
    await click(button(rail(), 'Mark done'));
    expect(rail().textContent).toContain('Reading the step…');
    expect(button(rail(), 'Mark done').disabled).toBe(true);

    recorded.details[BOARD] = detail(fullNode(BOARD, 'P3.3 the board', { revision: 3 }));
    await render();
    await type(rail(), 'The board renders.');
    await click(button(rail(), 'Mark done'));

    expect(recorded.mutateAsync).toHaveBeenCalledTimes(1);
    expect(recorded.mutateAsync).toHaveBeenCalledWith({
      nodeId: BOARD,
      expectedRevision: 3,
      status: 'done',
      outcome: 'The board renders.',
    });
  });

  it('decides a retry after a refusal against the step as the refusal read it', async () => {
    recorded.mutateAsync.mockRejectedValueOnce(
      Object.assign(new Error('This step changed since the plan was read.'), { status: 409 }),
    );
    recorded.mutateAsync.mockResolvedValueOnce({ node: {} });
    const now = fullNode(NEXT, 'P3.4 live exit', { status: 'waiting', revision: 4 });
    recorded.detailRefetch.mockImplementation(() => {
      recorded.details[NEXT] = detail(now);
      return Promise.resolve({ data: { node: now } });
    });
    await render();
    await click(card(NEXT));

    await click(button(rail(), 'Drop'));
    await click(button(rail(), 'Drop'));
    await render();
    await click(button(rail(), 'Drop'));

    expect(
      recorded.mutateAsync.mock.calls.map(
        ([r]) => (r as { expectedRevision: number }).expectedRevision,
      ),
    ).toEqual([1, 4]);
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

    await type(rail(), '  Go ahead.  ');
    await click(button(rail(), 'Approve'));

    expect(recorded.mutateAsync).toHaveBeenCalledWith({
      nodeId: ARTICLE,
      expectedRevision: 4,
      why: 'Go ahead.',
    });
    const open = mutationFor('/open')!;
    expect(open.method).toBe('PATCH');
    expect(open.path({ nodeId: ARTICLE })).toBe(`/spaces/${SPACE_ID}/plan/nodes/${ARTICLE}/open`);
    expect(
      JSON.parse(open.serialize({ nodeId: ARTICLE, expectedRevision: 4, why: 'Go ahead.' })),
    ).toEqual({ expectedRevision: 4, why: 'Go ahead.' });
    expect(open.invalidate).toEqual([['space', SPACE_ID, 'plan']]);
  });

  it('sends an optional spend ceiling when resuming a stopped step', async () => {
    recorded.mutateAsync.mockResolvedValue({ node: {} });
    recorded.details[ARTICLE] = detail(
      fullNode(ARTICLE, 'Write the help article', {
        parentId: R322,
        status: 'blocked',
        revision: 4,
        note: 'Blocked: spend ceiling reached.',
      }),
    );
    await render({ data: withStatus(ARTICLE, 'blocked') });
    await click(card(ARTICLE));
    const field = rail().querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        field,
        '12500',
      );
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button(rail(), 'Approve'));
    expect(recorded.mutateAsync).toHaveBeenCalledWith({
      nodeId: ARTICLE,
      expectedRevision: 4,
      spendCents: 12500,
    });
    expect(
      JSON.parse(
        mutationFor('/open')!.serialize({
          nodeId: ARTICLE,
          expectedRevision: 4,
          spendCents: 12500,
        }),
      ),
    ).toEqual({ expectedRevision: 4, spendCents: 12500 });
  });

  it('names the failing reason field when validation refuses an open with blank spend', async () => {
    recorded.details[ARTICLE] = detail(
      fullNode(ARTICLE, 'Write the help article', {
        parentId: R322,
        status: 'blocked',
        revision: 4,
      }),
    );
    await render({ data: withStatus(ARTICLE, 'blocked') });
    await click(card(ARTICLE));
    const failure = PlanNodeOpenSchema.safeParse({ expectedRevision: 4, why: '' });
    const parse = vi.spyOn(PlanNodeOpenSchema, 'safeParse').mockReturnValueOnce(failure);
    try {
      await click(button(rail(), 'Approve'));
      expect(rail().querySelector('[role="alert"]')?.textContent).toContain('Instructions:');
      expect(rail().querySelector('[role="alert"]')?.textContent).not.toContain('spend');
      expect(recorded.mutateAsync).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
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
    expect(button(rail(), 'Approve')).toBeTruthy();

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

// Plan 332 P2: a plan with a blocked step, Up next steps among open and
// closed siblings, a done step with an open one stranded under it, and a
// phase whose only step has no sibling to move past.
const R331 = '00000000-0000-4000-8000-0000000000d1';
const BLOCKED = '00000000-0000-4000-8000-0000000000d2';
const UP_A = '00000000-0000-4000-8000-0000000000d3';
const CLOSED = '00000000-0000-4000-8000-0000000000d4';
const STRANDED = '00000000-0000-4000-8000-0000000000d5';
const UP_B = '00000000-0000-4000-8000-0000000000d6';
const UP_C = '00000000-0000-4000-8000-0000000000d7';
const PHASE = '00000000-0000-4000-8000-0000000000d8';
const LONE = '00000000-0000-4000-8000-0000000000d9';

const P2_PLAN: SpaceFixture = {
  roots: [
    treeNode(R331, null, 'Plan 331 · the always-on Helmsman', {
      children: [
        treeNode(BLOCKED, R331, 'P1 — the loop takes the next node', {
          status: 'blocked',
          revision: 3,
          noteHead: 'Proposed from the merged plan document',
        }),
        treeNode(UP_A, R331, 'P2 — asking', { position: 1 }),
        treeNode(CLOSED, R331, 'P3 — proposing', {
          position: 2,
          status: 'done',
          revision: 5,
          closedAt: at(10, 22),
          children: [treeNode(STRANDED, CLOSED, 'P3.a — carried findings')],
        }),
        treeNode(UP_B, R331, 'P4 — the thread', { position: 3 }),
        treeNode(UP_C, R331, 'P5 — the pause', { position: 4 }),
        treeNode(PHASE, R331, 'P6 — non-code roots', {
          position: 5,
          children: [treeNode(LONE, PHASE, 'P6.a — the first non-code root')],
        }),
      ],
    }),
  ],
  tallies: [
    {
      rootId: R331,
      state: 'needs_you',
      steps: 9,
      needsYou: 2,
      inFlight: 0,
      upNext: 5,
      done: 1,
      dropped: 0,
      doneByDay: [{ day: '2026-10-22', count: 1 }],
      nextNodeId: UP_A,
    },
  ],
};

function openForm(): Element {
  const found = container.querySelector('[data-plan-open-form]');
  if (!found) throw new Error('no open form');
  return found;
}

function buttonTexts(scope: Element): string[] {
  return [...scope.querySelectorAll('button')].map(buttonName);
}

describe('SpacePlanPage — approve, reopen and order (Plan 332 P2)', () => {
  beforeEach(() => {
    nav.search = `plan=${R331}`;
    recorded.mutateAsync.mockResolvedValue({ node: {} });
    recorded.details[BLOCKED] = detail(
      fullNode(BLOCKED, 'P1 — the loop takes the next node', {
        parentId: R331,
        status: 'blocked',
        revision: 3,
      }),
    );
    recorded.details[CLOSED] = detail(
      fullNode(CLOSED, 'P3 — proposing', {
        parentId: R331,
        status: 'done',
        outcome: 'Merged.',
        revision: 5,
        closedAt: at(10, 22),
      }),
    );
    recorded.details[STRANDED] = detail(
      fullNode(STRANDED, 'P3.a — carried findings', { parentId: CLOSED }),
    );
  });

  it('shows carrier recovery pointers after approving a live check', async () => {
    const carrierFailure = 'Carrier failed after live-check approval. Read its linked findings.';
    recorded.mutateAsync.mockResolvedValue({ node: {}, carrierFailure });
    await render({ data: P2_PLAN });
    await click(card(BLOCKED));
    await click(button(rail(), 'Approve'));
    await click(button(openForm(), 'Approve'));
    expect(document.body.textContent).toContain(carrierFailure);
  });

  it('offers Approve on a blocked step beside its close controls, and none on a decision', async () => {
    await render({ data: P2_PLAN });
    await click(card(BLOCKED));
    expect(buttonTexts(rail())).toEqual(['Close', 'Approve', 'Revise', 'Mark done', 'Drop']);

    nav.search = `plan=${R322}`;
    await render({ data: PLAN });
    await click(card(DECISION));
    expect(buttonTexts(rail())).not.toContain('Approve');
  });

  it('approves against the revision the rail read, with the reason, and re-reads the board on success', async () => {
    await render({ data: P2_PLAN });
    await click(card(BLOCKED));

    await type(openForm(), 'go ahead after Plan 330');
    await click(button(openForm(), 'Approve'));

    expect(recorded.sent).toEqual([
      {
        path: `/spaces/${SPACE_ID}/plan/nodes/${BLOCKED}/open`,
        body: { expectedRevision: 3, why: 'go ahead after Plan 330' },
      },
    ]);
    const write = mutationFor('/open')!;
    expect(write.method).toBe('PATCH');
    expect(write.invalidate).toEqual([['space', SPACE_ID, 'plan']]);
    // The approve form stays open on a blocked step, emptied once its write lands.
    expect(openForm().querySelector('textarea')?.value).toBe('');
  });

  it('shows the instructions field on a blocked step before any click (Plan 337 P4)', async () => {
    await render({ data: P2_PLAN });
    await click(card(BLOCKED));

    const field = openForm().querySelector('textarea');
    expect(field?.getAttribute('aria-label')).toBe('Instructions for the work (optional)');
    expect(openForm().textContent).toContain('its brief opens with these words');
    expect(buttonTexts(openForm())).toEqual(['Approve', 'Revise']);
  });

  it('sends the words back with Revise, the step left blocked, and asks for words first', async () => {
    await render({ data: P2_PLAN });
    await click(card(BLOCKED));
    expect(button(openForm(), 'Revise').disabled).toBe(true);

    await type(openForm(), '  Split it: the schema first.  ');
    await click(button(openForm(), 'Revise'));

    expect(recorded.sent).toEqual([
      {
        path: `/spaces/${SPACE_ID}/plan/nodes/${BLOCKED}/revise`,
        body: { expectedRevision: 3, why: 'Split it: the schema first.' },
      },
    ]);
    const write = recorded.mutations.find((m) => m.path({ nodeId: BLOCKED }).endsWith('/revise'))!;
    expect(write.method).toBe('PATCH');
    expect(write.invalidate).toEqual([['space', SPACE_ID, 'plan']]);
  });

  it('pins the step as its Revise left it, and says so when the Helmsman’s rewrite moves it', async () => {
    const revised = fullNode(BLOCKED, 'P1 — the loop takes the next node', {
      parentId: R331,
      status: 'blocked',
      revision: 4,
    });
    recorded.detailRefetch.mockImplementation(() => {
      recorded.details[BLOCKED] = detail(revised);
      return Promise.resolve({ data: { node: revised } });
    });
    await render({ data: P2_PLAN });
    await click(card(BLOCKED));
    await type(openForm(), 'Split it: the schema first.');
    await click(button(openForm(), 'Revise'));

    // The form's own write moved the step to 4: that is no move to report.
    await render({ data: P2_PLAN });
    expect(openForm().querySelector('[data-plan-open-moved]')).toBe(null);

    // The Helmsman's rewrite moves it to 5 while the form holds no edit.
    recorded.details[BLOCKED] = detail({ ...revised, revision: 5 });
    await render({ data: P2_PLAN });
    expect(openForm().querySelector('[data-plan-open-moved]')).not.toBe(null);

    await click(button(openForm(), 'Approve'));
    expect(recorded.sent.map((s) => s.body)).toEqual([
      { expectedRevision: 3, why: 'Split it: the schema first.' },
      { expectedRevision: 4 },
    ]);
  });

  it('links the step to the space chat with its title and id, and lists the conversations that wrote it', async () => {
    recorded.conversations[BLOCKED] = {
      data: {
        ...detail(fullNode(BLOCKED, 'P1 — the loop takes the next node')).data,
        links: [
          {
            nodeId: BLOCKED,
            kind: 'session',
            ref: 'c0000000-0000-4000-8000-000000000337',
            label: 'conversation',
            createdAt: at(10, 23),
          },
        ],
        linksTotal: 1,
      },
    };
    await render({ data: P2_PLAN });
    await click(card(BLOCKED));

    const discuss = rail().querySelector(`[data-plan-rail-section="Discuss"] a`);
    const href = discuss?.getAttribute('href') ?? '';
    expect(href.startsWith('/s/work/chat?draft=')).toBe(true);
    const draft = new URLSearchParams(href.slice(href.indexOf('?'))).get('draft') ?? '';
    expect(draft).toContain('"P1 — the loop takes the next node"');
    expect(draft).toContain(BLOCKED);
    expect(recorded.linkQueries.map((q) => q.path)).toContainEqual(
      `/spaces/${SPACE_ID}/plan/nodes/${BLOCKED}?linkKind=session&linkLabel=conversation&limit=5`,
    );
    expect(
      [...rail().querySelectorAll('[data-plan-rail-section="Discuss"] li a')].map((a) =>
        a.getAttribute('href'),
      ),
    ).toEqual(['/s/work/chat?session=c0000000-0000-4000-8000-000000000337']);
  });

  it('holds an open form to the revision it opened on when the live read moves past it', async () => {
    await render({ data: P2_PLAN });
    await click(card(BLOCKED));

    recorded.details[BLOCKED] = detail(
      fullNode(BLOCKED, 'P1 — the loop takes the next node', {
        parentId: R331,
        status: 'blocked',
        revision: 4,
      }),
    );
    await render({ data: P2_PLAN });
    expect(openForm().querySelector('[data-plan-open-moved]')).not.toBe(null);

    await click(button(openForm(), 'Approve'));
    expect(recorded.sent[0]?.body).toEqual({ expectedRevision: 3 });
  });

  it('refuses to send a reason past the note ceiling', async () => {
    await render({ data: P2_PLAN });
    await click(card(BLOCKED));
    await type(openForm(), 'x'.repeat(64001));

    expect(button(openForm(), 'Approve').disabled).toBe(true);
  });

  it('offers Reopen on a closed step and sends no reason where none is given', async () => {
    await render({ data: P2_PLAN });
    await click(card(CLOSED));
    expect(buttonTexts(rail())).toEqual(['Close', 'Reopen']);

    await click(button(rail(), 'Reopen'));
    await click(button(openForm(), 'Reopen'));

    expect(recorded.sent).toEqual([
      { path: `/spaces/${SPACE_ID}/plan/nodes/${CLOSED}/open`, body: { expectedRevision: 5 } },
    ]);
  });

  it('offers Reopen of the closed step above a stranded one, never Approve of the step itself', async () => {
    await render({ data: P2_PLAN });
    await click(card(STRANDED));
    expect(buttonTexts(rail())).toEqual(['Close', 'Reopen P3', 'Mark done', 'Drop']);
    expect(recorded.detailQueries.at(-1)).toMatchObject({
      key: ['space', SPACE_ID, 'plan', 'node', CLOSED, 'head'],
      staleTime: 0,
    });

    await click(button(rail(), 'Reopen P3'));
    await type(openForm(), 'P3.a still has to land');
    await click(button(openForm(), 'Reopen P3'));

    expect(recorded.sent).toEqual([
      {
        path: `/spaces/${SPACE_ID}/plan/nodes/${CLOSED}/open`,
        body: { expectedRevision: 5, why: 'P3.a still has to land' },
      },
    ]);
  });

  it('offers Move up and Move down on Up next cards only where an open sibling lies that way', async () => {
    await render({ data: P2_PLAN });

    expect(cardIds(column('up_next'))).toEqual([UP_A, UP_B, UP_C, PHASE, LONE]);
    expect(buttonTexts(card(UP_A))).toEqual(['Move up', 'Move down']);
    expect(buttonTexts(card(PHASE))).toEqual(['Move up']);
    expect(buttonTexts(card(LONE))).toEqual([]);
    expect(buttonTexts(card(BLOCKED))).toEqual([]);
  });

  it('sends the nearest open sibling, past a closed one, and does not open the rail', async () => {
    await render({ data: P2_PLAN });

    await click(button(card(UP_A), 'Move down'));
    await click(button(card(UP_B), 'Move up'));

    expect(recorded.sent).toEqual([
      {
        path: `/spaces/${SPACE_ID}/plan/nodes/${UP_A}/place`,
        body: { expectedRevision: 1, after: UP_B },
      },
      {
        path: `/spaces/${SPACE_ID}/plan/nodes/${UP_B}/place`,
        body: { expectedRevision: 1, before: UP_A },
      },
    ]);
    expect(mutationFor('/place')?.invalidate).toEqual([['space', SPACE_ID, 'plan']]);
    expect(container.querySelector('[data-plan-rail]')).toBe(null);
  });

  it('moves a card from the keyboard: Enter on a focused Move up places it and opens no rail', async () => {
    await render({ data: P2_PLAN });

    const moveUp = button(card(UP_B), 'Move up');
    await act(async () => {
      moveUp.focus();
      const pressed = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });
      // A browser activates a focused button on Enter unless a handler cancels the key.
      if (moveUp.dispatchEvent(pressed)) moveUp.click();
    });

    expect(recorded.sent).toEqual([
      {
        path: `/spaces/${SPACE_ID}/plan/nodes/${UP_B}/place`,
        body: { expectedRevision: 1, before: UP_A },
      },
    ]);
    expect(container.querySelector('[data-plan-rail]')).toBe(null);
  });

  it('says why a move was refused on its card, and re-reads the board when a sibling moved', async () => {
    recorded.mutateAsync.mockRejectedValue(
      Object.assign(new Error('The step this was placed against is not beside it any more.'), {
        status: 409,
      }),
    );
    await render({ data: P2_PLAN });

    await click(button(card(UP_C), 'Move up'));

    expect(card(UP_C).querySelector('[role="alert"]')?.textContent).toContain(
      'not beside it any more',
    );
    expect(recorded.refetch).toHaveBeenCalled();
  });
});

// Plan 332 P3: a space whose plans stand in every state.
const L_NEEDS = '00000000-0000-4000-8000-0000000001a1';
const L_FLIGHT = '00000000-0000-4000-8000-0000000001a2';
const L_QUEUED = '00000000-0000-4000-8000-0000000001a3';
const L_FINISHED = '00000000-0000-4000-8000-0000000001a4';
const L_CLOSED = '00000000-0000-4000-8000-0000000001a5';
const L_EMPTY = '00000000-0000-4000-8000-0000000001a6';
const L_STEP = '00000000-0000-4000-8000-0000000001b1';

function tally(rootId: string, extra: Partial<PlanRootTally>): PlanRootTally {
  return {
    rootId,
    state: 'empty',
    steps: 0,
    needsYou: 0,
    inFlight: 0,
    upNext: 0,
    done: 0,
    dropped: 0,
    doneByDay: [],
    ...extra,
  };
}

const LIST: SpaceFixture = {
  roots: [
    treeNode(L_NEEDS, null, 'Plan 331 · the always-on Helmsman', {
      revision: 2,
      children: [treeNode(L_STEP, L_NEEDS, 'P1 — the loop takes the next node')],
    }),
    treeNode(L_FLIGHT, null, 'Plan 332 · the plan page', { position: 1, revision: 3 }),
    treeNode(L_QUEUED, null, 'Plan 329 · planning', { position: 2, revision: 4 }),
    treeNode(L_FINISHED, null, 'Plan 324 · capabilities', { position: 3, revision: 7 }),
    treeNode(L_CLOSED, null, 'Plan 315 · the loop runs itself', {
      position: 4,
      status: 'done',
      closedAt: at(10, 20),
    }),
    treeNode(L_EMPTY, null, 'Plan 328 · not started', { position: 5, revision: 5 }),
  ],
  tallies: [
    tally(L_NEEDS, {
      state: 'needs_you',
      steps: 4,
      needsYou: 3,
      inFlight: 1,
      done: 1,
      doneByDay: [{ day: '2026-10-22', count: 1 }],
    }),
    tally(L_FLIGHT, { state: 'in_flight', steps: 3, inFlight: 1, upNext: 1, done: 1 }),
    tally(L_QUEUED, { state: 'queued', steps: 2, upNext: 2 }),
    tally(L_FINISHED, { state: 'finished', steps: 5, done: 4, dropped: 1 }),
    tally(L_CLOSED, { state: 'closed', steps: 53, done: 53 }),
    tally(L_EMPTY, { state: 'empty' }),
  ],
};

/** The browser moving to `search`, as back and forward do. */
async function goTo(search: string): Promise<void> {
  await act(async () => {
    nav.search = search;
    for (const listener of nav.listeners) listener();
  });
}

function boardShown(): string | null {
  return container.querySelector('[data-plan-board]')?.getAttribute('data-plan-board') ?? null;
}

describe('SpacePlanPage — the plan list (Plan 332 P3)', () => {
  it('lists open plans in position order with state, progress and non-zero counts, then Finished, then Closed folded', async () => {
    await render({ data: LIST });

    expect(rowIds('open')).toEqual([L_NEEDS, L_FLIGHT, L_QUEUED, L_EMPTY]);
    expect(rowIds('finished')).toEqual([L_FINISHED]);
    expect(rowIds('closed')).toEqual([]);

    // One reading per row: the plan, where it stands, and what needs the reader.
    const needs = listRow(L_NEEDS)!;
    expect(needs.querySelector('[data-plan-row-title]')?.textContent).toBe(
      'Plan 331 · the always-on Helmsman',
    );
    expect(needs.querySelector('[data-plan-row-state]')?.textContent).toBe('Pending approval');
    expect(needs.querySelector('[data-plan-row-progress]')?.textContent).toBe('1/4');
    expect(needs.querySelector('[data-plan-row-in-flight]')?.textContent).toBe('1 running');
    expect(needs.querySelector('[data-plan-row-needs-you]')?.textContent).toBe('3 pending');
    const flight = listRow(L_FLIGHT)!;
    expect(flight.querySelector('[data-plan-row-state]')?.textContent).toBe('1 running');
    expect(flight.querySelector('[data-plan-row-in-flight]')).toBe(null);
    expect(flight.querySelector('[data-plan-row-needs-you]')).toBe(null);
    expect(listRow(L_QUEUED)!.querySelector('[data-plan-row-state]')?.textContent).toBe('Queued');
    expect(listRow(L_QUEUED)!.querySelector('[data-badge]')).toBe(null);
    expect(listRow(L_FINISHED)?.textContent).toContain('5/5');
    expect(listRow(L_EMPTY)?.textContent).toContain('No steps');

    const finished = container.querySelector('[data-plan-list-section="finished"]')!;
    expect(finished.textContent).toContain('Finished · 1');
    expect(buttonTexts(listRow(L_FINISHED)!)).toContain('Close plan');
    expect(buttonTexts(listRow(L_NEEDS)!)).not.toContain('Close plan');

    const closed = container.querySelector('[data-plan-list-section="closed"] > button')!;
    expect(closed.textContent).toBe('Closed · 1');
    expect(closed.getAttribute('aria-expanded')).toBe('false');
    await click(closed as HTMLElement);
    expect(rowIds('closed')).toEqual([L_CLOSED]);
    expect(listRow(L_CLOSED)?.textContent).toContain('Closed');
    expect(listRow(L_CLOSED)?.querySelector('[data-plan-row-progress]')).toBe(null);
    expect(container.querySelector('[data-plan-row-truncated]')).toBe(null);
    expect(container.querySelector('[data-plan-list-truncated]')).toBe(null);
  });

  it('marks every row counted short on the row itself, and offers no Close plan on one', async () => {
    await render({
      data: {
        ...LIST,
        rowTruncated: {
          [L_FLIGHT]: { bound: 'nodes', value: 2000 },
          [L_FINISHED]: { bound: 'depth', value: 64 },
        },
      },
    });

    const marked = [...container.querySelectorAll('[data-plan-row-truncated]')].map((m) => [
      m.closest('[data-plan-row]')?.getAttribute('data-plan-row'),
      m.textContent,
    ]);
    expect(marked).toEqual([
      [L_FLIGHT, 'Counted short: the list counts 2000 steps across its plans'],
      [L_FINISHED, 'Counted short: steps deeper than 64 levels left out'],
    ]);
    // Its uncounted steps may be open: it stays among the open plans, with no Close plan.
    expect(rowIds('open')).toEqual([L_NEEDS, L_FLIGHT, L_QUEUED, L_FINISHED, L_EMPTY]);
    expect(rowIds('finished')).toEqual([]);
    expect(buttonTexts(listRow(L_FINISHED)!)).not.toContain('Close plan');
    expect(container.querySelector('[data-plan-list-truncated]')).toBe(null);
  });

  it('says when the list of plans itself was cut short', async () => {
    await render({ data: { ...LIST, listTruncated: { bound: 'nodes', value: 2000 } } });

    expect(container.querySelector('[data-plan-list-truncated]')?.textContent).toBe(
      'First 2000 plans',
    );
  });

  it('holds the list in the shell’s Plans pane and the rail in its Step pane, beside the board', async () => {
    await render();

    const list = container.querySelector<HTMLElement>('[data-plan-list]')!;
    expect(list.getAttribute('data-layout')).toBe('column');
    expect(list.closest('[data-side="Plans"]')).not.toBe(null);
    expect(list.querySelector('[data-plan-board]')).toBe(null);
    expect(container.querySelector('[data-side="Step"]')).toBe(null);

    await click(card(BOARD));
    expect(rail().closest('[data-side="Step"]')).not.toBe(null);
  });

  it('badges the Plans pane with the steps that need the operator, summed across the plans', async () => {
    const twoNeedYou: SpaceFixture = {
      ...LIST,
      tallies: LIST.tallies.map((t) => (t.rootId === L_FLIGHT ? { ...t, needsYou: 2 } : t)),
    };
    await render({ data: twoNeedYou });

    const plans = container.querySelector('[data-side="Plans"]')!;
    expect(plans.getAttribute('data-side-badge')).toBe('5');

    await click(container.querySelector<HTMLElement>('[data-side-fold="Plans"]')!);
    expect(plans.getAttribute('data-side-folded')).toBe('true');
    expect(plans.getAttribute('data-side-badge')).toBe('5');
  });

  it('unfolds the Step pane when another step is opened, without mounting it again', async () => {
    await render();
    await click(card(BOARD));

    const step = () => container.querySelector('[data-side="Step"]')!;
    const mount = step().getAttribute('data-side-mount');
    await click(container.querySelector<HTMLElement>('[data-side-fold="Step"]')!);
    expect(step().getAttribute('data-side-folded')).toBe('true');

    await click(card(NEXT));
    expect(step().getAttribute('data-side-folded')).toBe('false');
    // One mount throughout, so the width the operator dragged stays.
    expect(step().getAttribute('data-side-mount')).toBe(mount);
    expect(rail().closest('[data-side="Step"]')).not.toBe(null);
  });

  it('is a disclosure above the content below 900px, closed again once a plan is chosen', async () => {
    recorded.narrow = true;
    nav.search = `plan=${L_NEEDS}`;
    await render({ data: LIST });

    const list = container.querySelector('[data-plan-list]')!;
    expect(list.getAttribute('data-layout')).toBe('disclosure');
    expect(
      list.compareDocumentPosition(container.querySelector('[data-plan-board]')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const toggle = list.querySelector('button')!;
    expect(toggle.textContent).toBe('Plans · 6 — Plan 331 · the always-on Helmsman');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(listRow(L_NEEDS)).toBe(null);

    await click(toggle);
    expect(rowIds('open')).toEqual([L_NEEDS, L_FLIGHT, L_QUEUED, L_EMPTY]);

    await choosePlan(L_FLIGHT);
    expect(listRow(L_NEEDS)).toBe(null);
    expect(boardShown()).toBe(L_FLIGHT);
    expect(container.querySelector('[data-plan-list] button')?.textContent).toBe(
      'Plans · 6 — Plan 332 · the plan page',
    );
  });

  it('renders a list of 50 plans with the selected row scrolled into view', async () => {
    const roots = Array.from({ length: 50 }, (_, i) =>
      treeNode(
        `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        null,
        `Plan ${String(i)}`,
        { position: i },
      ),
    );
    const fifty: SpaceFixture = {
      roots,
      tallies: roots.map((r) => tally(r.nodeId, { state: 'queued', steps: 1, upNext: 1 })),
    };
    const scrolled: Element[] = [];
    const scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this);
    });
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    try {
      nav.search = `plan=${roots[44]!.nodeId}`;
      await render({ data: fifty });

      expect(rowIds('open')).toHaveLength(50);
      expect(listRow(roots[44]!.nodeId)?.getAttribute('aria-current')).toBe('true');
      expect(scrolled.at(-1)).toBe(listRow(roots[44]!.nodeId));
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });

      await choosePlan(roots[3]!.nodeId);
      expect(scrolled.at(-1)).toBe(listRow(roots[3]!.nodeId));
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('unfolds Closed when the plan chosen is closed, so its row is in view', async () => {
    nav.search = `plan=${L_CLOSED}`;
    await render({ data: LIST });

    expect(rowIds('closed')).toEqual([L_CLOSED]);
    expect(listRow(L_CLOSED)?.getAttribute('aria-current')).toBe('true');
    expect(boardShown()).toBe(L_CLOSED);
  });
});

describe('SpacePlanPage — where the operator is, in the URL (Plan 332 D8)', () => {
  it('shows the overview where the URL names no plan, the list beside it, and writes nothing to the URL', async () => {
    nav.search = '';
    await render({ data: LIST });

    expect(boardShown()).toBe(null);
    expect(container.querySelector('[data-plan-overview]')).not.toBe(null);
    expect(recorded.boardQueries).toEqual([]);
    expect(rowIds('open')).toEqual([L_NEEDS, L_FLIGHT, L_QUEUED, L_EMPTY]);
    expect(container.querySelector('[data-plan-row][aria-current]')).toBe(null);
    expect(container.querySelector('[data-plan-list-overview]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(nav.pushed).toEqual([]);
  });

  it('shows the plan the URL names, and the overview for one the space does not hold', async () => {
    nav.search = `plan=${L_QUEUED}`;
    await render({ data: LIST });
    expect(boardShown()).toBe(L_QUEUED);
    expect(lastBoardQuery().url.pathname).toBe(`/spaces/${SPACE_ID}/plan/roots/${L_QUEUED}`);

    await goTo('plan=00000000-0000-4000-8000-0000000009ff');
    expect(boardShown()).toBe(null);
    expect(container.querySelector('[data-plan-overview]')).not.toBe(null);
  });

  it('puts the plan chosen in the URL, and back lands on the overview before it', async () => {
    nav.search = '';
    await render({ data: LIST });

    await choosePlan(L_FLIGHT);
    expect(nav.pushed).toEqual([`/s/work/plan?plan=${L_FLIGHT}`]);
    expect(boardShown()).toBe(L_FLIGHT);

    await goTo('');
    expect(boardShown()).toBe(null);
    expect(container.querySelector('[data-plan-overview]')).not.toBe(null);

    await choosePlan(L_QUEUED);
    await click(container.querySelector<HTMLElement>('[data-plan-list-overview]')!);
    expect(nav.pushed.at(-1)).toBe('/s/work/plan');
    expect(boardShown()).toBe(null);
  });

  it('puts the step opened in the URL beside its plan, and takes it out when the rail closes', async () => {
    await render();

    await click(card(BOARD));
    expect(nav.pushed.at(-1)).toBe(`/s/work/plan?plan=${R322}&node=${BOARD}`);
    expect(rail().getAttribute('data-plan-rail')).toBe(BOARD);

    await click(button(rail(), 'Close'));
    expect(nav.pushed.at(-1)).toBe(`/s/work/plan?plan=${R322}`);
    expect(container.querySelector('[data-plan-rail]')).toBe(null);
  });

  it('reopens the same board and rail on reload of a URL with plan and node', async () => {
    nav.search = `plan=${R315}&node=${STEP_315}`;
    recorded.details[STEP_315] = detail(
      fullNode(STEP_315, 'F116 crash restarts', { parentId: R315, status: 'done' }),
    );
    await render();

    expect(boardShown()).toBe(R315);
    expect(rail().getAttribute('data-plan-rail')).toBe(STEP_315);
    expect(recorded.detailQueries.at(-1)?.key).toEqual([
      'space',
      SPACE_ID,
      'plan',
      'node',
      STEP_315,
    ]);
    expect(nav.pushed).toEqual([]);

    // Back from the rail closes it over the same board.
    await goTo(`plan=${R315}`);
    expect(boardShown()).toBe(R315);
    expect(container.querySelector('[data-plan-rail]')).toBe(null);
  });

  it('closes the rail when another plan is chosen', async () => {
    nav.search = `plan=${R322}&node=${BOARD}`;
    await render();
    expect(rail().getAttribute('data-plan-rail')).toBe(BOARD);

    await choosePlan(R315);
    expect(nav.pushed.at(-1)).toBe(`/s/work/plan?plan=${R315}`);
    expect(container.querySelector('[data-plan-rail]')).toBe(null);
  });
});

describe('SpacePlanPage — ordering and closing plans from the list (Plan 332 P3)', () => {
  beforeEach(() => {
    recorded.mutateAsync.mockResolvedValue({ node: {} });
  });

  it('offers Move up and Move down on open rows only where an open plan lies that way', async () => {
    await render({ data: LIST });

    const moves = (rootId: string) =>
      buttonTexts(listRow(rootId)!).filter((t) => t.startsWith('Move'));
    expect(moves(L_NEEDS)).toEqual(['Move down']);
    expect(moves(L_FLIGHT)).toEqual(['Move up', 'Move down']);
    expect(moves(L_EMPTY)).toEqual(['Move up']);
    expect(moves(L_FINISHED)).toEqual([]);
  });

  it('shows Move up and Move down where the row is pointed at, focused or selected, and the orb gives way to them', async () => {
    nav.search = `plan=${L_QUEUED}`;
    await render({ data: LIST });

    const controls = (rootId: string) =>
      listRow(rootId)!.querySelector<HTMLElement>(`[data-plan-move="${rootId}"]`)!;
    const orb = (rootId: string) =>
      listRow(rootId)!.querySelector<HTMLElement>('[data-plan-orb][data-state]')!;
    const hover = async (target: HTMLElement, type: 'mouseover' | 'mouseout') => {
      await act(async () => {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: null }));
      });
    };

    // At rest: the orb shows, the controls are quiet.
    expect(controls(L_FLIGHT).style.opacity).toBe('0');
    expect(orb(L_FLIGHT).style.opacity).toBe('1');
    // The selected row shows its controls in the orb's place.
    expect(controls(L_QUEUED).style.opacity).toBe('1');
    expect(orb(L_QUEUED).style.opacity).toBe('0');

    await hover(listRow(L_FLIGHT)!, 'mouseover');
    expect(controls(L_FLIGHT).style.opacity).toBe('1');
    expect(orb(L_FLIGHT).style.opacity).toBe('0');
    await hover(listRow(L_FLIGHT)!, 'mouseout');
    expect(controls(L_FLIGHT).style.opacity).toBe('0');
    expect(orb(L_FLIGHT).style.opacity).toBe('1');

    await act(async () => {
      listRow(L_EMPTY)!.querySelector('button')!.focus();
    });
    expect(controls(L_EMPTY).style.opacity).toBe('1');
    expect(orb(L_EMPTY).style.opacity).toBe('0');

    // A row with no move has no controls: its orb never gives way.
    await hover(listRow(L_FINISHED)!, 'mouseover');
    expect(listRow(L_FINISHED)!.querySelector('[data-plan-move]')).toBe(null);
    expect(orb(L_FINISHED).style.opacity).toBe('1');
  });

  it('keeps the controls shown while a move is pending, though the row is no longer pointed at', async () => {
    recorded.mutateAsync.mockReturnValue(new Promise(() => undefined));
    await render({ data: LIST });

    const controls = listRow(L_FLIGHT)!.querySelector<HTMLElement>(
      `[data-plan-move="${L_FLIGHT}"]`,
    )!;
    expect(controls.style.opacity).toBe('0');

    await click(button(listRow(L_FLIGHT)!, 'Move up'));
    expect(controls.getAttribute('data-pending')).toBe('true');
    expect(controls.style.opacity).toBe('1');
  });

  it('tints a row, the Overview item and the Closed disclosure while pointed at, and not the selected row', async () => {
    nav.search = `plan=${L_QUEUED}`;
    await render({ data: LIST });

    const hover = async (target: HTMLElement, type: 'mouseover' | 'mouseout') => {
      await act(async () => {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: null }));
      });
    };
    const tinted = (target: HTMLElement) =>
      (target.getAttribute('style') ?? '').includes('var(--color-surface-2)') &&
      !(target.getAttribute('style') ?? '').includes('var(--color-surface-3');
    const overview = container.querySelector<HTMLElement>('[data-plan-list-overview]')!;
    const closed = container.querySelector<HTMLElement>(
      '[data-plan-list-section="closed"] > button',
    )!;

    for (const target of [listRow(L_FLIGHT)!, overview, closed]) {
      expect(tinted(target)).toBe(false);
      await hover(target, 'mouseover');
      expect(tinted(target)).toBe(true);
      await hover(target, 'mouseout');
      expect(tinted(target)).toBe(false);
    }

    await hover(listRow(L_QUEUED)!, 'mouseover');
    expect(listRow(L_QUEUED)!.getAttribute('style')).toContain('var(--color-surface-3');
  });

  it('places a plan before or after the open row beside it, against the revision the rows read', async () => {
    await render({ data: LIST });

    await click(button(listRow(L_FLIGHT)!, 'Move up'));
    await click(button(listRow(L_QUEUED)!, 'Move down'));

    expect(recorded.sent).toEqual([
      {
        path: `/spaces/${SPACE_ID}/plan/nodes/${L_FLIGHT}/place`,
        body: { expectedRevision: 3, before: L_NEEDS },
      },
      {
        path: `/spaces/${SPACE_ID}/plan/nodes/${L_QUEUED}/place`,
        body: { expectedRevision: 4, after: L_EMPTY },
      },
    ]);
    expect(mutationFor('/place')?.invalidate).toEqual([['space', SPACE_ID, 'plan']]);
    // A move is not a choice of plan.
    expect(nav.pushed).toEqual([]);
  });

  it('lists the plans in their new order once the rows are read again after a move', async () => {
    await render({ data: LIST });
    await click(button(listRow(L_FLIGHT)!, 'Move up'));

    const [needs, flight, ...rest] = LIST.roots;
    const moved: SpaceFixture = {
      ...LIST,
      roots: [{ ...flight!, position: 0, revision: 4 }, { ...needs!, position: 1 }, ...rest],
    };
    await render({ data: moved });

    expect(rowIds('open')).toEqual([L_FLIGHT, L_NEEDS, L_QUEUED, L_EMPTY]);
    expect(buttonTexts(listRow(L_FLIGHT)!).filter((t) => t.startsWith('Move'))).toEqual([
      'Move down',
    ]);
  });

  it('says why a move was refused on its row, and reads the rows again when a plan moved', async () => {
    recorded.mutateAsync.mockRejectedValue(
      Object.assign(new Error('The step this was placed against is not beside it any more.'), {
        status: 409,
      }),
    );
    await render({ data: LIST });

    await click(button(listRow(L_QUEUED)!, 'Move up'));

    expect(listRow(L_QUEUED)?.querySelector('[role="alert"]')?.textContent).toContain(
      'not beside it any more',
    );
    expect(recorded.rowsRefetch).toHaveBeenCalled();
  });

  it('closes a finished plan with the close write on its root, pinned to the revision its fresh read showed, and lists it under Closed', async () => {
    recorded.details[L_FINISHED] = detail(
      fullNode(L_FINISHED, 'Plan 324 · capabilities', {
        parentId: null,
        revision: 7,
        criteria: 'Every phase landed.',
      }),
    );
    await render({ data: LIST });

    await click(button(listRow(L_FINISHED)!, 'Close plan'));
    expect(recorded.detailQueries.at(-1)).toMatchObject({
      key: ['space', SPACE_ID, 'plan', 'node', L_FINISHED, 'head'],
      path: `/spaces/${SPACE_ID}/plan/nodes/${L_FINISHED}?limit=1`,
      staleTime: 0,
    });
    const form = listRow(L_FINISHED)!.querySelector('[data-plan-close-root]')!;
    expect(form.textContent).toContain('Done when: Every phase landed.');
    expect(button(form, 'Close plan').disabled).toBe(true);
    await type(form, 'Every phase merged.');
    await click(button(form, 'Close plan'));

    expect(recorded.sent).toEqual([
      {
        path: `/spaces/${SPACE_ID}/plan/nodes/${L_FINISHED}`,
        body: { expectedRevision: 7, status: 'done', outcome: 'Every phase merged.' },
      },
    ]);
    expect(mutationFor('')?.invalidate).toEqual([['space', SPACE_ID, 'plan']]);
    expect(listRow(L_FINISHED)?.querySelector('[data-plan-close-root]')).toBe(null);

    // The rows read again: the root is done, so the plan is closed.
    const closed: SpaceFixture = {
      roots: LIST.roots.map((r) =>
        r.nodeId === L_FINISHED ? { ...r, status: 'done', revision: 8 } : r,
      ),
      tallies: LIST.tallies.map((t) => (t.rootId === L_FINISHED ? { ...t, state: 'closed' } : t)),
    };
    await render({ data: closed });

    expect(rowIds('finished')).toEqual([]);
    expect(container.querySelector('[data-plan-list-section="finished"]')?.textContent).toContain(
      'Finished · 0',
    );
    await click(
      container.querySelector<HTMLElement>('[data-plan-list-section="closed"] > button')!,
    );
    expect(rowIds('closed')).toEqual([L_FINISHED, L_CLOSED]);
  });

  it('keeps Close plan pinned to the root as first read, and reads it again after a refusal', async () => {
    recorded.details[L_FINISHED] = detail(
      fullNode(L_FINISHED, 'Plan 324 · capabilities', { parentId: null, revision: 7 }),
    );
    recorded.mutateAsync.mockRejectedValue(
      Object.assign(new Error('This step changed since the plan was read: it is at revision 8.'), {
        status: 409,
      }),
    );
    await render({ data: LIST });
    await click(button(listRow(L_FINISHED)!, 'Close plan'));
    await type(listRow(L_FINISHED)!, 'Every phase merged.');

    recorded.details[L_FINISHED] = detail(
      fullNode(L_FINISHED, 'Plan 324 · capabilities', { parentId: null, revision: 8 }),
    );
    await render({ data: LIST });
    expect(listRow(L_FINISHED)?.querySelector('[data-plan-close-moved]')).not.toBe(null);
    await click(
      button(listRow(L_FINISHED)!.querySelector('[data-plan-close-root]')!, 'Close plan'),
    );

    expect(recorded.sent[0]?.body).toMatchObject({ expectedRevision: 7 });
    expect(listRow(L_FINISHED)?.querySelector('[role="alert"]')?.textContent).toContain(
      'it is at revision 8',
    );
    expect(recorded.detailRefetch).toHaveBeenCalled();
    expect(recorded.rowsRefetch).toHaveBeenCalled();
  });

  it('offers Close plan in a finished plan’s header, and none on a plan with open steps', async () => {
    nav.search = `plan=${L_NEEDS}`;
    await render({ data: LIST });
    const header = () => container.querySelector(`[data-plan-tally]`)!.parentElement!;
    expect(buttonTexts(header())).not.toContain('Close plan');

    await choosePlan(L_FINISHED);
    expect(header().textContent).toContain('Finished');
    expect(buttonTexts(header())).toContain('Close plan');
  });

  it('offers no Close plan in the header of a finished plan whose board was read short, and says why', async () => {
    await render({ data: { ...LIST, truncated: { bound: 'nodes', value: 2000 } } });
    await choosePlan(L_FINISHED);
    const header = container.querySelector(`[data-plan-tally]`)!.parentElement!;

    expect(header.textContent).toContain('Finished');
    expect(buttonTexts(header)).not.toContain('Close plan');
    expect(header.querySelector('[data-plan-close-withheld]')?.textContent).toBe(
      'Counted short: the first 2000 steps, so no Close plan',
    );
  });
});

// Plan 332 P4: the overview, where the page lands.
const LANE_STOP = '00000000-0000-4000-8000-0000000002a1';
const LANE_STRANDED = '00000000-0000-4000-8000-0000000002a2';
const LANE_CLOSED_ABOVE = '00000000-0000-4000-8000-0000000002a3';
const LANE_GONE = '00000000-0000-4000-8000-0000000002a4';

function laneItem(nodeId: string, title: string, extra: Partial<PlanLaneItem> = {}): PlanLaneItem {
  return {
    nodeId,
    title,
    kind: 'execute',
    status: 'active',
    revision: 1,
    updatedAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
    rootId: R322,
    rootTitle: 'Plan 322 · plans are platform records',
    ...extra,
  };
}

const OVERVIEW: SpaceFixture = {
  ...PLAN,
  lanes: {
    needsYou: {
      items: [
        laneItem(LANE_STOP, 'P4 — one view across plans', {
          status: 'blocked',
          revision: 4,
          reason: 'blocked',
          phaseTitle: 'P3 — Seen by the operator',
          noteHead: 'Proposed from the merged plan document; awaits the operator’s approval',
        }),
        laneItem(DECISION, 'Where the decide answer is recorded', {
          kind: 'decide',
          revision: 3,
          reason: 'decide',
        }),
        laneItem(LANE_STRANDED, 'P6.a — the folder preview', {
          status: 'blocked',
          reason: 'stranded',
          closedAncestor: { nodeId: LANE_CLOSED_ABOVE, title: 'P6 — the folder' },
        }),
      ],
      total: 57,
    },
    inFlight: {
      items: [
        laneItem(BOARD, 'P3.3 the board', {
          pullRequest: { url: PR, merged: false },
          runs: [
            {
              runId: RUN_ID,
              slug: 'commission-change',
              status: 'running',
              nodeId: BOARD,
              startedAt: at(10, 22, 14),
            },
          ],
          runsTotal: 1,
        }),
      ],
      total: 1,
    },
    upNext: { items: [laneItem(ARTICLE, 'Write the help article')], total: 1 },
  },
};

function lane(id: string): Element {
  const found = container.querySelector(`[data-plan-lane="${id}"]`);
  if (!found) throw new Error(`no lane ${id}`);
  return found;
}

function laneRow(nodeId: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-plan-lane-row="${nodeId}"]`);
  if (!found) throw new Error(`no lane row ${nodeId}`);
  return found;
}

function laneRowIds(id: string): string[] {
  return [...lane(id).querySelectorAll('[data-plan-lane-row]')].map(
    (r) => r.getAttribute('data-plan-lane-row') ?? '',
  );
}

describe('SpacePlanPage — the overview across plans (Plan 332 P4)', () => {
  beforeEach(() => {
    nav.search = '';
    recorded.mutateAsync.mockResolvedValue({ node: {} });
  });

  it('lands on the three lanes, Needs you first, each step tagged with its plan', async () => {
    await render({ data: OVERVIEW });

    expect(
      [...container.querySelectorAll('[data-plan-lane]')].map((l) =>
        l.getAttribute('data-plan-lane'),
      ),
    ).toEqual(['needs_you', 'in_flight', 'up_next']);
    expect(laneRowIds('needs_you')).toEqual([LANE_STOP, DECISION, LANE_STRANDED]);
    expect(laneRowIds('in_flight')).toEqual([BOARD]);
    expect(laneRowIds('up_next')).toEqual([ARTICLE]);
    expect(lane('needs_you').textContent).toContain('Pending · 57');

    const stop = laneRow(LANE_STOP);
    expect(stop.querySelector('[data-plan-lane-plan]')?.textContent).toBe('Plan 322');
    expect([...stop.querySelectorAll('[data-badge]')].map((b) => b.textContent)).toEqual([
      'Approval',
    ]);
    expect(stop.querySelector('[data-plan-lane-phase]')?.textContent).toBe('P3');
    expect(stop.querySelector('[data-plan-lane-note]')?.textContent).toBe(
      'Proposed from the merged plan document; awaits the operator’s approval',
    );
    expect(stop.querySelector('[data-plan-lane-age]')?.textContent).toBe('3h');
    expect(laneRow(LANE_STRANDED).textContent).toContain('Under a closed step');
    expect(buttonTexts(laneRow(DECISION))).toContain('Decide');

    const running = laneRow(BOARD);
    expect(running.querySelector(`[data-plan-lane-run="${RUN_ID}"]`)?.textContent).toContain(
      'Commission',
    );
    expect(running.querySelector(`a[href="/s/work/runs/${RUN_ID}"]`)).not.toBe(null);
    expect(running.textContent).toContain('PR #181 · open');

    // Up next is the loop's next step per plan, with no reorder: that is the board's.
    expect(laneRow(ARTICLE).textContent).toContain('Next for the loop');
    expect(buttonTexts(lane('up_next'))).not.toContain('Move up');
    expect(buttonTexts(lane('up_next'))).not.toContain('Move down');
    expect(boardShown()).toBe(null);
  });

  it('says where a lane row’s step stands by its surface, and tints it over that while pointed at', async () => {
    await render({ data: OVERVIEW });

    expect(laneRow(LANE_STOP).style.backgroundColor).toBe('var(--color-status-paused-bg)');
    expect(laneRow(ARTICLE).style.backgroundColor).toBe('var(--color-surface-2)');
    const row = laneRow(BOARD);
    expect(row.style.backgroundColor).toBe('var(--color-status-running-bg)');
    expect(row.classList.contains('ds-card--running')).toBe(true);
    expect(row.style.backgroundImage).toBe('none');
    await act(async () => {
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
    });
    expect(row.style.backgroundColor).toBe('var(--color-status-running-bg)');
    expect(row.style.backgroundImage).toContain('var(--color-surface-2)');
    await act(async () => {
      row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
    });
    expect(row.style.backgroundImage).toBe('none');
  });

  it('says how many more a lane holds than it lists', async () => {
    await render({ data: OVERVIEW });

    expect(lane('needs_you').querySelector('[data-plan-lane-more]')?.textContent).toBe(
      'and 54 more',
    );
    expect(lane('in_flight').querySelector('[data-plan-lane-more]')).toBe(null);
  });

  it('says when the lanes’ read reached a bound, and a lane cut short reads as at least what it holds', async () => {
    await render({
      data: {
        ...OVERVIEW,
        lanes: {
          needsYou: { items: [], total: 0 },
          inFlight: { items: [], total: 0 },
          upNext: { items: [], total: 0 },
          truncated: { bound: 'nodes', value: 2000 },
        },
      },
    });

    expect(container.querySelector('[data-plan-lanes-truncated]')?.textContent).toBe(
      'The lanes read the first 2000 steps across plans, closed ones included; some may be missing',
    );
    // A lane cut short never reads as complete: neither its count nor its emptiness.
    expect(lane('needs_you').textContent).toContain('Pending · 0+');
    expect(lane('needs_you').textContent).toContain('None among the steps read');
    expect(lane('needs_you').textContent).not.toContain('Nothing pending');
  });

  it('says what an empty lane means where the read reached no bound', async () => {
    await render({
      data: {
        ...OVERVIEW,
        lanes: {
          needsYou: { items: [], total: 0 },
          inFlight: { items: [], total: 0 },
          upNext: { items: [], total: 0 },
        },
      },
    });

    expect(container.querySelector('[data-plan-lanes-truncated]')).toBe(null);
    expect(lane('needs_you').textContent).toContain('Pending · 0');
    expect(lane('needs_you').textContent).not.toContain('0+');
    expect(lane('needs_you').textContent).toContain('Nothing pending');
  });

  it('approves a blocked step from its row through the open write, against the lanes’ revision, without opening its plan', async () => {
    await render({ data: OVERVIEW });

    await click(button(laneRow(LANE_STOP), 'Approve'));

    expect(recorded.sent).toEqual([
      { path: `/spaces/${SPACE_ID}/plan/nodes/${LANE_STOP}/open`, body: { expectedRevision: 4 } },
    ]);
    expect(mutationFor('/open')?.invalidate).toEqual([['space', SPACE_ID, 'plan']]);
    expect(nav.pushed).toEqual([]);
    expect(boardShown()).toBe(null);
    // Approve is the blocked row's alone: not a decision's, not a stranded step's.
    expect(buttonTexts(laneRow(DECISION))).not.toContain('Approve');
    expect(buttonTexts(laneRow(LANE_STRANDED))).not.toContain('Approve');
  });

  it('says a refused approve on its row and reads the overview again when the step moved', async () => {
    recorded.mutateAsync.mockRejectedValue(
      Object.assign(new Error('This step changed since the plan was read: it is at revision 5.'), {
        status: 409,
      }),
    );
    await render({ data: OVERVIEW });

    await click(button(laneRow(LANE_STOP), 'Approve'));

    expect(laneRow(LANE_STOP).querySelector('[role="alert"]')?.textContent).toContain(
      'it is at revision 5',
    );
    expect(recorded.rowsRefetch).toHaveBeenCalledTimes(1);
    expect(recorded.refetch).not.toHaveBeenCalled();
  });

  it('opens the shared rail over the overview from a row, puts the step in the URL alone, and takes it out on Close', async () => {
    recorded.details[LANE_STOP] = detail(
      fullNode(LANE_STOP, 'P4 — one view across plans', { status: 'blocked', revision: 4 }),
    );
    await render({ data: OVERVIEW });

    await click(laneRow(LANE_STOP).querySelector('button')!);

    expect(nav.pushed.at(-1)).toBe(`/s/work/plan?node=${LANE_STOP}`);
    expect(rail().getAttribute('data-plan-rail')).toBe(LANE_STOP);
    expect(laneRow(LANE_STOP).getAttribute('aria-current')).toBe('true');
    expect(container.querySelector('[data-plan-overview]')).not.toBe(null);
    expect([...rail().querySelectorAll('[data-badge]')].map((b) => b.textContent)).toEqual([
      'Pending',
      'Approval',
    ]);
    expect(rail().querySelector('[data-plan-rail-phase]')?.textContent).toBe('P3');
    expect(buttonTexts(rail())).toEqual(['Close', 'Approve', 'Revise', 'Mark done', 'Drop']);

    await click(button(rail(), 'Close'));
    expect(nav.pushed.at(-1)).toBe('/s/work/plan');
    expect(container.querySelector('[data-plan-rail]')).toBe(null);
  });

  it('opens the rail with the decide form from a decision’s Decide', async () => {
    recorded.details[DECISION] = detail(
      fullNode(DECISION, 'Where the decide answer is recorded', { kind: 'decide', revision: 3 }),
    );
    await render({ data: OVERVIEW });

    await click(button(laneRow(DECISION), 'Decide'));

    expect(nav.pushed.at(-1)).toBe(`/s/work/plan?node=${DECISION}`);
    expect(rail().querySelector('[data-plan-close="done"]')).not.toBe(null);
  });

  it('offers Reopen of the closed step above a stranded row in its rail', async () => {
    recorded.details[LANE_STRANDED] = detail(
      fullNode(LANE_STRANDED, 'P6.a — the folder preview', { status: 'blocked' }),
    );
    nav.search = `node=${LANE_STRANDED}`;
    await render({ data: OVERVIEW });

    expect(buttonTexts(rail())).toContain('Reopen P6');
    expect(buttonTexts(rail())).not.toContain('Approve');
  });

  it('reopens the rail over the overview on reload of a URL with a step and no plan', async () => {
    nav.search = `node=${BOARD}`;
    await render({ data: OVERVIEW });

    expect(boardShown()).toBe(null);
    expect(container.querySelector('[data-plan-overview]')).not.toBe(null);
    expect(rail().getAttribute('data-plan-rail')).toBe(BOARD);
    expect(rail().textContent).toContain('Running');
    expect(nav.pushed).toEqual([]);
  });

  it('reads a step no lane holds on its own, and opens the rail over the overview with it', async () => {
    recorded.details[LANE_GONE] = detail(
      fullNode(LANE_GONE, 'A step that landed', {
        status: 'done',
        outcome: 'Merged.',
        closedAt: at(10, 21),
      }),
    );
    nav.search = `node=${LANE_GONE}`;
    await render({ data: OVERVIEW });

    expect(rail().getAttribute('data-plan-rail')).toBe(LANE_GONE);
    expect(rail().textContent).toContain('A step that landed');
    expect([...rail().querySelectorAll('[data-badge]')].map((b) => b.textContent)).toEqual([
      'Done',
    ]);
    expect(buttonTexts(rail())).toContain('Reopen');
    expect(
      recorded.detailQueries.some(
        (q) => q.key.join('/') === `space/${SPACE_ID}/plan/node/${LANE_GONE}`,
      ),
    ).toBe(true);
  });

  it('opens the rail as a dialog over the overview below 900px', async () => {
    recorded.narrow = true;
    nav.search = `node=${ARTICLE}`;
    await render({ data: OVERVIEW });

    expect(container.querySelector('[role="dialog"] [data-plan-rail]')).not.toBe(null);
    expect(rail().textContent).toContain('Next');
  });
});

/**
 * The kind of the state orb that stands first in `scope`. The words beside it
 * name the state, so the orb is hidden from assistive technology.
 */
function orbKind(scope: Element): string | null {
  const orb = scope.querySelector('[data-plan-orb]');
  if (!orb) return null;
  expect(orb.querySelector('[role="img"]')).toBe(null);
  expect(orb.querySelector('[aria-hidden="true"]')).not.toBe(null);
  return orb.getAttribute('data-plan-orb');
}

/** A part of the rail by its role and name. */
function railGroup(name: string): Element {
  const found = [...rail().querySelectorAll('[role="group"]')].find(
    (g) => g.getAttribute('aria-label') === name,
  );
  if (!found) throw new Error(`no rail group ${name}`);
  return found;
}

/** Whether `content` sits in a body that grows and shrinks rather than snaps, inside `scope`. */
function animatedWithin(scope: Element, content: Element | null): boolean {
  const body = content?.closest('[data-animated-height]');
  return body !== null && body !== undefined && scope.contains(body);
}

describe('SpacePlanPage — state as orbs, and motion (Plan 332 P7)', () => {
  it('reads each plan row’s state by its orb and its words', async () => {
    await render({ data: LIST });

    const read = (rootId: string) => [
      orbKind(listRow(rootId)!),
      listRow(rootId)!.querySelector('[data-plan-row-state]')?.textContent,
    ];
    expect(read(L_NEEDS)).toEqual(['paused', 'Pending approval']);
    expect(read(L_FLIGHT)).toEqual(['running', '1 running']);
    expect(read(L_QUEUED)).toEqual(['idle', 'Queued']);
    expect(read(L_EMPTY)).toEqual(['inert', 'No steps']);
    expect(read(L_FINISHED)).toEqual(['completed', 'Finished']);

    await click(
      container.querySelector<HTMLElement>('[data-plan-list-section="closed"] > button')!,
    );
    expect(read(L_CLOSED)).toEqual(['inert', 'Closed']);
  });

  it('reads the plan’s header state by its orb and its words', async () => {
    await render();

    const header = container.querySelector(`[data-plan-tally="${R322}"]`)!;
    expect(orbKind(header)).toBe('paused');
    expect(header.querySelector('[data-badge]')?.textContent).toBe('Pending approval');

    await choosePlan(R315);
    const closed = container.querySelector(`[data-plan-tally="${R315}"]`)!;
    expect(orbKind(closed)).toBe('inert');
    expect(closed.querySelector('[data-badge]')?.textContent).toBe('Closed');
  });

  it('reads each card’s state by its orb and the words its card and column say', async () => {
    await render();

    const read = (nodeId: string) => {
      const shown = card(nodeId);
      const heading = shown
        .closest('[data-plan-column]')!
        .querySelector('[data-plan-column-header]');
      return [orbKind(shown), heading?.getAttribute('data-plan-column-header')];
    };
    expect(read(DECISION)).toEqual(['paused', 'Pending']);
    expect(card(DECISION).textContent).toContain('Decision');
    // A run on the step itself, and one on a step under it, both read running.
    expect(read(BOARD)).toEqual(['running', 'Running']);
    expect(card(BOARD).textContent).toContain('1 run in flight');
    expect(read(P3)).toEqual(['running', 'Running']);
    // A waiting step whose run ended is In flight, and nothing moves it until the loop returns.
    expect(read(NEXT)).toEqual(['idle', 'Running']);
    expect(card(NEXT).querySelector('[data-plan-waiting]')?.textContent).toBe(
      'Its run ended; the loop advances it when it returns',
    );
    expect(read(ARTICLE)).toEqual(['idle', 'Queued']);
    expect(read(LANDED)).toEqual(['completed', 'Done']);
    expect(read(SKETCH)).toEqual(['inert', 'Dropped']);
    expect(container.querySelector('[data-plan-orb="failed"]')).toBe(null);
  });

  it('reads the rail’s state by its orb and its words', async () => {
    await render();

    await click(card(DECISION));
    expect(orbKind(rail())).toBe('paused');
    expect(rail().querySelector('[data-badge]')?.textContent).toBe('Pending');

    await click(card(LANDED));
    expect(orbKind(rail())).toBe('completed');
    expect(rail().querySelector('[data-badge]')?.textContent).toBe('Done');

    await click(card(ARTICLE));
    expect(orbKind(rail())).toBe('idle');
    expect(rail().querySelector('[data-badge]')?.textContent).toBe('Queued');
  });

  it('reads each lane row’s state by its orb and its words, and a run as the run surface writes it', async () => {
    nav.search = '';
    await render({ data: OVERVIEW });

    expect(orbKind(laneRow(LANE_STOP))).toBe('paused');
    expect(laneRow(LANE_STOP).querySelector('[data-badge]')?.textContent).toBe('Approval');
    expect(orbKind(laneRow(LANE_STRANDED))).toBe('paused');
    expect(laneRow(LANE_STRANDED).textContent).toContain('Under a closed step');
    expect(orbKind(laneRow(ARTICLE))).toBe('idle');
    expect(laneRow(ARTICLE).textContent).toContain('Next for the loop');

    const running = laneRow(BOARD);
    expect(orbKind(running)).toBe('running');
    const run = running.querySelector(`[data-plan-lane-run="${RUN_ID}"] [data-plan-run]`)!;
    // The step's orb says a run is on it, so the run carries no orb of its own.
    expect(run.querySelector('.workflow-run-surface__orb')).toBe(null);
    expect(run.textContent).toBe('Commissionexecuting60m 00s');
    expect(run.querySelector('[data-plan-run-elapsed]')?.textContent).toBe('60m 00s');
  });

  it('reads a rail opened from an In flight lane row as idle until the step’s read says a run is on it', async () => {
    delete recorded.details[BOARD];
    nav.search = '';
    await render({ data: OVERVIEW });

    await click(laneRow(BOARD).querySelector('button')!);
    expect(rail().getAttribute('data-plan-rail')).toBe(BOARD);
    expect(orbKind(rail())).toBe('idle');

    recorded.details[BOARD] = detail(fullNode(BOARD, 'P3.3 the board'), {
      activity: 'in_flight',
    });
    await render({ data: OVERVIEW });
    expect(orbKind(rail())).toBe('running');
  });

  it('writes a run in flight on the rail as the run surface writes its rows', async () => {
    recorded.details[BOARD] = detail(fullNode(BOARD, 'P3.3 the board'), {
      runs: [
        {
          runId: RUN_ID,
          slug: 'commission-change',
          status: 'paused',
          nodeId: BOARD,
          startedAt: at(10, 22, 10),
        },
      ],
      runsTotal: 1,
      activity: 'in_flight',
    });
    await render();

    await click(card(BOARD));
    expect(orbKind(rail())).toBe('running');
    const run = railGroup('Runs').querySelector(`[data-plan-run="${RUN_ID}"]`)!;
    // The step's orb says a run is on it, so the run carries no orb of its own.
    expect(run.querySelector('.workflow-run-surface__orb')).toBe(null);
    // A paused run says it is paused, and no time runs on it.
    expect(run.textContent).toBe('Commissionpaused');
  });

  it('grows and shrinks the rail’s sections and the step’s note rather than snapping them', async () => {
    recorded.details[ARTICLE] = detail(
      fullNode(ARTICLE, 'Write the help article', {
        parentId: R322,
        note: 'Proposed: write it after P3 lands.\nThe board is still moving.',
      }),
    );
    await render();

    await click(card(ARTICLE));
    for (const name of ['Goal', 'Done when', 'Working note', 'Discuss']) {
      // Everything under the section's label is the body that grows and shrinks.
      const group = railGroup(name);
      const body = [...group.children].find((c) => c.hasAttribute('data-animated-height'));
      expect(body?.textContent, name).toBe(group.textContent?.slice(name.length));
      expect(body?.textContent, name).not.toBe('');
    }

    const note = railGroup('Working note');
    await click(button(note, 'Show note'));
    expect(animatedWithin(note, note.querySelector('[data-plan-note]'))).toBe(true);
  });

  it('grows and shrinks a lane row’s detail, a Done fold and the list’s Finished and Closed sections', async () => {
    nav.search = '';
    await render({ data: OVERVIEW });
    const row = laneRow(LANE_STOP);
    expect(animatedWithin(row, row.querySelector('[data-plan-lane-note]'))).toBe(true);

    root.unmount();
    root = createRoot(container);
    await render({ data: LIST });
    const finished = container.querySelector('[data-plan-list-section="finished"]')!;
    expect(animatedWithin(finished, finished.querySelector('[aria-label="Finished plans"]'))).toBe(
      true,
    );
    const closed = container.querySelector('[data-plan-list-section="closed"]')!;
    expect(closed.querySelector('[data-animated-height]')).not.toBe(null);
    await click(button(closed, 'Closed · 1'));
    expect(animatedWithin(closed, closed.querySelector('[aria-label="Closed plans"]'))).toBe(true);

    root.unmount();
    root = createRoot(container);
    nav.search = `plan=${R322}`;
    await render();
    await choosePlan(R315);
    const today = column('done').querySelector('[data-plan-done-group="today"]')!;
    expect(animatedWithin(today, today.querySelector('[data-plan-card]'))).toBe(true);
    // The fold widens by the selected card's ring and pads its cards by it, so its clip spares the ring.
    const fold = today.querySelector<HTMLElement>('[data-animated-height]')!;
    expect(fold.style.marginInline).toBe('-2px');
    expect(fold.querySelector<HTMLElement>('[data-plan-card]')!.parentElement!.style.padding).toBe(
      '2px',
    );
  });
});

describe('SpacePlanPage — the decision card on the rail (Plan 337 P2)', () => {
  const CARD: PlanNodeCard = {
    change: { today: 'The rail shows prose.', after: 'The rail shows the card.' },
    why: ['The operator reads all of the prose to find the decision.'],
    affects: ['The plan rail.', 'The help article.'],
    risks: [
      { risk: 'Items grow long.', mitigation: 'The guidance asks for short items.' },
      { risk: 'The card drifts from the document.' },
    ],
    questions: [
      { question: 'Is the card optional?', recommended: 'Yes, on every node.' },
      { question: 'Does Approve accept every recommendation?', recommended: 'Yes.' },
    ],
    notDoing: [],
  };
  const DOC_URL =
    'https://github.com/aflowai/aflow/blob/93ce25659c0c/docs/plans/337-plans-the-operator-can-decide-from.md';

  function sections(): string[] {
    return [...rail().querySelectorAll('[data-plan-rail-section]')].map(
      (s) => s.getAttribute('data-plan-rail-section') ?? '',
    );
  }

  function railGroup(label: string): Element {
    const found = rail().querySelector(`[data-plan-rail-section="${label}"]`);
    if (!found) throw new Error(`no rail section ${label}`);
    return found;
  }

  async function answer(index: number, text: string): Promise<void> {
    const field = openForm().querySelector<HTMLInputElement>(
      `input[aria-label="Answer to question ${String(index + 1)}"]`,
    );
    if (!field) throw new Error(`no answer field ${String(index + 1)}`);
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(field, text);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function blockedCarded(): void {
    recorded.mutateAsync.mockResolvedValue({ node: {} });
    recorded.details[ARTICLE] = detail(
      fullNode(ARTICLE, 'Write the help article', {
        parentId: R322,
        status: 'blocked',
        revision: 4,
        note: 'Proposed: write it after P3 lands.',
        card: CARD,
      }),
    );
  }

  it('renders a carded step’s sections in the card’s order, its criteria as Done when, and folds its goal', async () => {
    recorded.details[BOARD] = detail(
      fullNode(BOARD, 'P3.3 the board', { card: CARD, note: 'Working on the rail.' }),
    );
    await render();
    await click(card(BOARD));

    expect(sections().slice(0, 9)).toEqual([
      'What changes',
      'Why',
      'What it affects',
      'Risks',
      'Open questions',
      'Not done on purpose',
      'Done when',
      'Goal',
      'Working note',
    ]);
    const change = railGroup('What changes');
    expect(change.querySelector('[data-plan-card-change="today"]')?.textContent).toBe(
      'Today: The rail shows prose.',
    );
    expect(change.querySelector('[data-plan-card-change="after"]')?.textContent).toBe(
      'After: The rail shows the card.',
    );
    expect(
      [...railGroup('What it affects').querySelectorAll('li')].map((li) => li.textContent),
    ).toEqual(['The plan rail.', 'The help article.']);
    const risks = [...railGroup('Risks').querySelectorAll('[data-plan-card-risk]')];
    expect(risks.map((r) => r.querySelector('[data-plan-card-mitigation]')?.textContent)).toEqual([
      'Mitigation: The guidance asks for short items.',
      undefined,
    ]);
    expect(
      [...railGroup('Open questions').querySelectorAll('[data-plan-card-recommended]')].map(
        (r) => r.textContent,
      ),
    ).toEqual(['Recommended: Yes, on every node.', 'Recommended: Yes.']);
    expect(railGroup('Not done on purpose').textContent).toBe('Not done on purposeNone.');
    // Done when is the node's criteria, read from the node: the card holds no copy.
    expect(railGroup('Done when').textContent).toBe('Done whenCriteria of P3.3 the board.');

    const goal = railGroup('Goal');
    expect(goal.textContent).not.toContain('The whole goal of P3.3 the board.');
    await click(button(goal, 'Show goal'));
    expect(goal.querySelector('[data-plan-goal]')?.textContent).toBe(
      'The whole goal of P3.3 the board.',
    );
  });

  it('renders a step with no card as today: Goal, Done when and Working note', async () => {
    recorded.details[BOARD] = detail(
      fullNode(BOARD, 'P3.3 the board', { note: 'Working on the rail.' }),
    );
    await render();
    await click(card(BOARD));

    expect(sections().slice(0, 3)).toEqual(['Goal', 'Done when', 'Working note']);
    expect(sections()).not.toContain('What changes');
    expect(railGroup('Goal').textContent).toBe('GoalThe whole goal of P3.3 the board.');
    expect(rail().querySelector('[data-plan-document]')).toBe(null);
  });

  it('Approve with no answers sends one open write whose why lists each question with its recommended answer', async () => {
    blockedCarded();
    await render({ data: withStatus(ARTICLE, 'blocked') });
    await click(card(ARTICLE));

    expect(
      [...openForm().querySelectorAll('input[aria-label^="Answer to question"]')].map((f) =>
        f.getAttribute('placeholder'),
      ),
    ).toEqual(['Recommended: Yes, on every node.', 'Recommended: Yes.']);
    await click(button(openForm(), 'Approve'));

    expect(recorded.sent).toEqual([
      {
        path: `/spaces/${SPACE_ID}/plan/nodes/${ARTICLE}/open`,
        body: {
          expectedRevision: 4,
          why: 'Is the card optional? Answer: Yes, on every node.\nDoes Approve accept every recommendation? Answer: Yes.',
        },
      },
    ]);
  });

  it('Approve with an answer to the second question writes a note headed Approved: with it and the recommended answer to the first', async () => {
    blockedCarded();
    await render({ data: withStatus(ARTICLE, 'blocked') });
    await click(card(ARTICLE));

    await answer(1, '  No: a risk the operator names stays open.  ');
    await type(openForm(), 'Keep the article short.');
    await click(button(openForm(), 'Approve'));

    expect(recorded.sent).toHaveLength(1);
    const why = (recorded.sent[0]!.body as { why: string }).why;
    expect(why).toBe(
      'Is the card optional? Answer: Yes, on every node.\n' +
        'Does Approve accept every recommendation? Answer: No: a risk the operator names stays open.\n' +
        'Keep the article short.',
    );
    // The engine heads the note with the why as one line (`openPlanNode`).
    const note = `${planNodeOperatorLine(PLAN_NODE_APPROVED_HEAD, why)}\nProposed: write it after P3 lands.`;
    const first = note.split('\n', 1)[0]!;
    expect(first.startsWith('Approved: ')).toBe(true);
    expect(first).toContain('No: a risk the operator names stays open.');
    expect(first).toContain('Is the card optional? Answer: Yes, on every node.');
    expect(first).not.toContain('Answer: Yes.');
  });

  it('drops an answer whose question a refused Approve shows rewritten, so it never goes out under another question', async () => {
    blockedCarded();
    const rewritten = fullNode(ARTICLE, 'Write the help article', {
      parentId: R322,
      status: 'blocked',
      revision: 5,
      card: {
        ...CARD,
        questions: [
          CARD.questions[0]!,
          { question: 'Does the lane row record answers?', recommended: 'No.' },
        ],
      },
    });
    recorded.mutateAsync.mockRejectedValueOnce(
      Object.assign(new Error('This step changed since the plan was read: it is at revision 5.'), {
        status: 409,
      }),
    );
    recorded.detailRefetch.mockImplementation(() => {
      recorded.details[ARTICLE] = detail(rewritten);
      return Promise.resolve({ data: recorded.details[ARTICLE]!.data });
    });
    await render({ data: withStatus(ARTICLE, 'blocked') });
    await click(card(ARTICLE));

    await answer(0, 'Only on decision nodes.');
    await answer(1, 'No: the operator answers each one.');
    await click(button(openForm(), 'Approve'));
    expect(rail().querySelector('[role="alert"]')?.textContent).toContain('revision 5');

    const second = openForm().querySelector<HTMLInputElement>(
      'input[aria-label="Answer to question 2"]',
    );
    expect(second?.value).toBe('');
    expect(second?.getAttribute('placeholder')).toBe('Recommended: No.');
    recorded.mutateAsync.mockResolvedValue({ node: {} });
    await click(button(openForm(), 'Approve'));
    expect(recorded.sent.at(-1)).toEqual({
      path: `/spaces/${SPACE_ID}/plan/nodes/${ARTICLE}/open`,
      body: {
        expectedRevision: 5,
        why: 'Is the card optional? Answer: Only on decision nodes.\nDoes the lane row record answers? Answer: No.',
      },
    });
  });

  it('says on a carded step that the brief opens with the answers, then the instructions', async () => {
    blockedCarded();
    await render({ data: withStatus(ARTICLE, 'blocked') });
    await click(card(ARTICLE));

    expect(openForm().querySelector('[data-plan-approve-hint]')?.textContent).toBe(
      'Approve starts the work. Its brief opens with the answers, and then with these words. Revise keeps the step blocked and asks the Helmsman to rewrite it from these words.',
    );
  });

  it('closes an answer with no closing punctuation, so the folded note line does not run on', async () => {
    blockedCarded();
    await render({ data: withStatus(ARTICLE, 'blocked') });
    await click(card(ARTICLE));

    await answer(0, 'only on decisions');
    await click(button(openForm(), 'Approve'));

    const why = (recorded.sent[0]!.body as { why: string }).why;
    expect(why).toBe(
      'Is the card optional? Answer: only on decisions.\nDoes Approve accept every recommendation? Answer: Yes.',
    );
    expect(planNodeOperatorLine(PLAN_NODE_APPROVED_HEAD, why)).toBe(
      'Approved: Is the card optional? Answer: only on decisions. Does Approve accept every recommendation? Answer: Yes.',
    );
  });

  describe('Decide after a refusal pins a rewritten card', () => {
    const REWRITTEN: PlanNodeCard = {
      ...CARD,
      questions: [{ question: 'Where is the answer recorded?', recommended: 'In the outcome.' }],
    };

    function refusedOnce(): void {
      recorded.details[DECISION] = detail(
        fullNode(DECISION, 'Where the decide answer is recorded', {
          kind: 'decide',
          revision: 3,
          card: CARD,
        }),
      );
      recorded.mutateAsync.mockRejectedValueOnce(
        Object.assign(
          new Error('This step changed since the plan was read: it is at revision 4.'),
          {
            status: 409,
          },
        ),
      );
      recorded.detailRefetch.mockImplementation(() => {
        recorded.details[DECISION] = detail(
          fullNode(DECISION, 'Where the decide answer is recorded', {
            kind: 'decide',
            revision: 4,
            card: REWRITTEN,
          }),
        );
        return Promise.resolve({ data: recorded.details[DECISION]!.data });
      });
    }

    it('fills an untouched field with the new questions', async () => {
      refusedOnce();
      await render();
      await click(button(card(DECISION), 'Decide'));
      await click(button(rail(), 'Record decision'));

      expect(rail().querySelector('textarea')?.value).toBe(
        'Where is the answer recorded? Answer: In the outcome.',
      );
      expect(rail().querySelector('[data-plan-decide-card-changed]')).toBe(null);
    });

    it('keeps an edited field as written and says the questions changed', async () => {
      refusedOnce();
      await render();
      await click(button(card(DECISION), 'Decide'));
      await type(rail(), 'Is the card optional? Answer: No.');
      await click(button(rail(), 'Record decision'));

      expect(rail().querySelector('textarea')?.value).toBe('Is the card optional? Answer: No.');
      expect(rail().querySelector('[data-plan-decide-card-changed]')?.textContent).toContain(
        'questions changed',
      );
    });
  });

  it('gates Revise on the instructions alone, whatever the length of the answers', async () => {
    blockedCarded();
    await render({ data: withStatus(ARTICLE, 'blocked') });
    await click(card(ARTICLE));

    await answer(0, 'x'.repeat(PLAN_NODE_OPEN_WHY_MAX_CHARS));
    await type(openForm(), 'Split it.');
    expect(button(openForm(), 'Approve').disabled).toBe(true);
    expect(button(openForm(), 'Revise').disabled).toBe(false);
  });

  it('renders each card item as markdown, its label outside the markdown', async () => {
    recorded.details[BOARD] = detail(
      fullNode(BOARD, 'P3.3 the board', {
        card: {
          ...CARD,
          change: { today: 'The rail shows **prose**.', after: 'The rail shows `sections`.' },
          risks: [{ risk: 'Items grow long.', mitigation: 'Read [the plan](https://x.test).' }],
        },
      }),
    );
    await render();
    await click(card(BOARD));

    const today = rail().querySelector('[data-plan-card-change="today"]')!;
    expect(today.querySelector('.md-content strong')?.textContent).toBe('prose');
    expect(today.querySelector('.md-content')?.textContent).not.toContain('Today:');
    expect(
      rail().querySelector('[data-plan-card-change="after"] .md-content code')?.textContent,
    ).toBe('sections');
    expect(
      rail().querySelector('[data-plan-card-mitigation] .md-content a')?.getAttribute('href'),
    ).toBe('https://x.test');
  });

  it('prefills Decide with each question and its recommended answer, and records the edited text as the outcome', async () => {
    recorded.mutateAsync.mockResolvedValue({ node: {} });
    recorded.details[DECISION] = detail(
      fullNode(DECISION, 'Where the decide answer is recorded', {
        kind: 'decide',
        revision: 3,
        card: CARD,
      }),
    );
    await render();
    await click(button(card(DECISION), 'Decide'));

    const field = rail().querySelector('textarea')!;
    expect(field.value).toBe(
      'Is the card optional? Answer: Yes, on every node.\nDoes Approve accept every recommendation? Answer: Yes.',
    );
    expect(rail().querySelector('[data-plan-decide-hint]')).not.toBe(null);

    await type(
      rail(),
      'Is the card optional? Answer: Yes, on every node.\nDoes Approve accept every recommendation? Answer: No.',
    );
    await click(button(rail(), 'Record decision'));

    expect(recorded.mutateAsync).toHaveBeenCalledWith({
      nodeId: DECISION,
      expectedRevision: 3,
      status: 'done',
      outcome:
        'Is the card optional? Answer: Yes, on every node.\nDoes Approve accept every recommendation? Answer: No.',
    });
  });

  it('offers Read the plan from the newest document link, a URL opened and a path shown as text', async () => {
    recorded.documents[BOARD] = detail(fullNode(BOARD, 'P3.3 the board'), {
      links: [{ nodeId: BOARD, kind: 'document', ref: DOC_URL, createdAt: at(10, 21) }],
      linksTotal: 2,
    });
    await render();
    await click(card(BOARD));

    expect(recorded.linkQueries.map((q) => q.path)).toContain(
      `/spaces/${SPACE_ID}/plan/nodes/${BOARD}?linkKind=document&limit=1`,
    );
    const link = rail().querySelector('[data-plan-document] a');
    expect(link?.textContent).toBe('Read the plan');
    expect(link?.getAttribute('href')).toBe(DOC_URL);

    root.unmount();
    root = createRoot(container);
    const pathRef = 'docs/plans/337-plans-the-operator-can-decide-from.md@93ce25659c0c';
    recorded.documents[BOARD] = detail(fullNode(BOARD, 'P3.3 the board'), {
      links: [{ nodeId: BOARD, kind: 'document', ref: pathRef, createdAt: at(10, 21) }],
      linksTotal: 1,
    });
    await render();
    await click(card(BOARD));
    const shown = rail().querySelector('[data-plan-document]')!;
    expect(shown.querySelector('a')).toBe(null);
    expect(shown.querySelector('[data-plan-document-ref]')?.textContent).toBe(pathRef);
  });
});
