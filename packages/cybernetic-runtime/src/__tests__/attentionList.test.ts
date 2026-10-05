/**
 * `workflow.run.list_attention`'s read without a database: a space's items of
 * mixed ownership in a fake ledger that narrows by the owner filter as the
 * query does, so what is listed, how it pages and where the read stops are
 * the operation's own. `activeRunQueries.pg.test.ts` holds the query to it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItemRow } from '@aflow/database';
import type { AttentionItemKind } from '@aflow/schemas';
import type { AttentionItemWithRun, AttentionOwnerFilter } from '../ledger/attention.js';
import { InMemoryPlanNodeStore } from './planStoreFake.js';

const TENANT = 'a0000000-0000-4000-8000-000000000322';
const SPACE = '5e1d0000-0000-4000-8000-000000000322';
const DB = {} as never;

/** The reading conversation, another live one, and one whose session row has not landed. */
const ME = 'c01d0000-0000-4000-8000-00000000000a';
const OTHER = 'c01d0000-0000-4000-8000-00000000000b';
const UNPROJECTED = 'c01d0000-0000-4000-8000-00000000000c';
const ENDED = 'c01d0000-0000-4000-8000-00000000000d';

const fakeStore = { current: new InMemoryPlanNodeStore() };

/** The space's items, newest first, with who drove each one's run; and the nodes each session's runs serve. */
const fakeLedger = {
  rows: [] as AttentionItemWithRun[],
  drives: new Map<string, string[]>(),
  /** The rows each read returned. */
  reads: [] as number[],
  owners: [] as Array<AttentionOwnerFilter | undefined>,
};

/** Whether the walk under the reader's roots stopped at its bound. */
const subtreeWalk = { truncated: false };

function passesOwner(row: AttentionItemWithRun, owner: AttentionOwnerFilter): boolean {
  const placed = row.planNodeId !== null && fakeStore.current.nodes.has(row.planNodeId);
  if (placed) return owner.planNodeIds?.includes(row.planNodeId ?? '') ?? true;
  return !row.drivenByLiveConversation || row.sessionId === owner.sessionId;
}

vi.mock('../ledger/attention.js', async () => {
  const actual =
    await vi.importActual<typeof import('../ledger/attention.js')>('../ledger/attention.js');
  return {
    ...actual,
    listAttentionItems: (
      _db: unknown,
      _tenantId: string,
      opts: {
        spaceId?: string;
        kind?: AttentionItemKind;
        includeConsumed?: boolean;
        limit?: number;
        afterItemId?: string;
        owner?: AttentionOwnerFilter;
      },
    ) => {
      fakeLedger.owners.push(opts.owner);
      const after =
        opts.afterItemId !== undefined
          ? fakeLedger.rows.findIndex((row) => row.item.id === opts.afterItemId) + 1
          : 0;
      const rows = fakeLedger.rows
        .slice(after)
        .filter(
          (row) =>
            row.item.spaceId === opts.spaceId &&
            (opts.kind === undefined || row.item.kind === opts.kind) &&
            (opts.includeConsumed === true || row.item.consumedAt === null) &&
            (opts.owner === undefined || passesOwner(row, opts.owner)),
        )
        .slice(0, opts.limit);
      fakeLedger.reads.push(rows.length);
      return Promise.resolve(rows);
    },
  };
});
vi.mock('../ledger/queries.js', async () => {
  const actual =
    await vi.importActual<typeof import('../ledger/queries.js')>('../ledger/queries.js');
  return {
    ...actual,
    listPlanNodeIdsDrivenBySession: (_db: unknown, _t: string, _s: string, sessionId: string) =>
      Promise.resolve(fakeLedger.drives.get(sessionId) ?? []),
  };
});
vi.mock('../plan/store.js', async () => {
  const actual = await vi.importActual<typeof import('../plan/store.js')>('../plan/store.js');
  return { ...actual, createPlanNodeStore: () => fakeStore.current };
});
vi.mock('../plan/attention.js', async () => {
  const actual =
    await vi.importActual<typeof import('../plan/attention.js')>('../plan/attention.js');
  return {
    ...actual,
    loadPlanSubtreeNodeIds: (...args: Parameters<typeof actual.loadPlanSubtreeNodeIds>) =>
      subtreeWalk.truncated ? Promise.resolve(undefined) : actual.loadPlanSubtreeNodeIds(...args),
  };
});

const { LIST_ATTENTION_SCAN_LIMIT, listAttentionForConversation } =
  await import('../attentionList.js');

async function planNode(parentId: string | null, title: string): Promise<string> {
  const inserted = await fakeStore.current.insert(SPACE, {
    parentId,
    kind: 'execute',
    title,
    goal: title,
    criteria: title,
    note: null,
    position: 0,
    createdBy: null,
  });
  if (inserted.outcome !== 'inserted') throw new Error(inserted.outcome);
  return inserted.node.nodeId;
}

let sequence = 0;

/** An item about a run, appended as the oldest so far. */
function item(
  name: string,
  run: { planNodeId?: string; sessionId?: string; driven: boolean },
  overrides: Partial<AttentionItemRow> = {},
): string {
  sequence += 1;
  const id = `17e00000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  fakeLedger.rows.push({
    item: {
      id,
      tenantId: TENANT,
      userId: null,
      spaceId: SPACE,
      kind: 'workflow_run_paused',
      relatedRunId: `run-${name}`,
      relatedResource: null,
      payload: {},
      priority: 0,
      createdAt: new Date(Date.parse('2026-10-05T09:00:00.000Z') - sequence * 1000),
      consumedAt: null,
      consumedBySession: null,
      ...overrides,
    },
    planNodeId: run.planNodeId ?? null,
    sessionId: run.sessionId ?? null,
    drivenByLiveConversation: run.driven,
  });
  return id;
}

function list(overrides: Partial<Parameters<typeof listAttentionForConversation>[0]> = {}) {
  return listAttentionForConversation({
    db: DB,
    tenantId: TENANT,
    spaceId: SPACE,
    sessionId: ME,
    scope: 'conversation',
    includeConsumed: false,
    limit: 25,
    ...overrides,
  });
}

const ids = (listed: Awaited<ReturnType<typeof list>>) => listed.items.map(({ item }) => item.id);

beforeEach(() => {
  fakeStore.current = new InMemoryPlanNodeStore();
  fakeLedger.rows = [];
  fakeLedger.drives = new Map();
  fakeLedger.reads = [];
  fakeLedger.owners = [];
  subtreeWalk.truncated = false;
  sequence = 0;
});

describe('workflow.run.list_attention over a space of mixed ownership', () => {
  /** One item of every kind of owner, newest first, and which of them are this conversation's. */
  async function mixedSpace() {
    const rootMine = await planNode(null, '315 · first-run ergonomics');
    const nodeMine = await planNode(rootMine, 'F114 findings');
    const rootOther = await planNode(null, '320 · browser approvals');
    fakeLedger.drives.set(ME, [nodeMine]);
    fakeLedger.drives.set(OTHER, [rootOther]);
    const others = [
      item('other-unplaced', { sessionId: OTHER, driven: true }),
      item('other-placed', { planNodeId: rootOther, sessionId: OTHER, driven: true }),
      item('unprojected', { sessionId: UNPROJECTED, driven: true }),
    ];
    const mine = [
      item('mine-unplaced', { sessionId: ME, driven: true }),
      item('mine-on-root', { planNodeId: rootMine, sessionId: OTHER, driven: true }),
      item('mine-under-root', { planNodeId: nodeMine, sessionId: ME, driven: true }),
      item('operator', { driven: false }),
      item('ended-conversation', { sessionId: ENDED, driven: false }),
    ];
    return { mine: new Set(mine), others: new Set(others), rootMine, nodeMine };
  }

  it('lists only its own: unplaced runs it drove, runs under its roots, and runs no conversation owns', async () => {
    const { mine } = await mixedSpace();

    const listed = await list();

    expect(new Set(ids(listed))).toEqual(mine);
    expect(listed.items.every(({ own }) => own)).toBe(true);
    expect(listed).toMatchObject({ hasMore: false });
    expect(listed).not.toHaveProperty('cursor');
    expect(listed).not.toHaveProperty('truncated');
  });

  it('counts a run whose driving session has no row yet as that session’s, never everyone’s', async () => {
    await mixedSpace();

    const listed = await list({ scope: 'space' });

    expect(listed.items.find(({ item }) => item.relatedRunId === 'run-unprojected')).toMatchObject({
      own: false,
    });
    expect((await list()).items.map(({ item }) => item.relatedRunId)).not.toContain(
      'run-unprojected',
    );
  });

  it('narrows the query to the reader: its session, and every node under its roots', async () => {
    const { rootMine, nodeMine } = await mixedSpace();

    await list();

    expect(fakeLedger.owners).toHaveLength(1);
    const [owner] = fakeLedger.owners;
    expect(owner?.sessionId).toBe(ME);
    expect(new Set(owner?.planNodeIds)).toEqual(new Set([rootMine, nodeMine]));
  });

  it('lists every conversation’s under the space scope, each marked, with the query unnarrowed', async () => {
    const { mine, others } = await mixedSpace();

    const listed = await list({ scope: 'space' });

    expect(fakeLedger.owners).toEqual([undefined]);
    expect(listed.items).toHaveLength(mine.size + others.size);
    for (const { item, own } of listed.items) expect(own).toBe(mine.has(item.id));
  });

  it('pages its own newest first, each page’s cursor reading on from the last item it shows', async () => {
    const { mine } = await mixedSpace();
    const newestFirst = fakeLedger.rows.map(({ item }) => item.id).filter((id) => mine.has(id));

    const pages: string[][] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await list({ limit: 2, ...(cursor !== undefined ? { cursor } : {}) });
      pages.push(ids(page));
      if (!page.hasMore) {
        expect(page).not.toHaveProperty('cursor');
        break;
      }
      expect(page.cursor).toBe(ids(page).at(-1));
      cursor = page.cursor;
    }

    expect(pages.flat()).toEqual(newestFirst);
    expect(pages.slice(0, -1).every((page) => page.length === 2)).toBe(true);
  });

  it('fills a page in one read however many of another conversation’s items are newer', async () => {
    await mixedSpace();
    const foreign = LIST_ATTENTION_SCAN_LIMIT * 2;
    const older = fakeLedger.rows;
    fakeLedger.rows = [];
    for (let i = 0; i < foreign; i++)
      item(`foreign-${String(i)}`, { sessionId: OTHER, driven: true });
    fakeLedger.rows.push(...older);

    const listed = await list({ limit: 3, includeConsumed: true });

    expect(listed.items).toHaveLength(3);
    expect(listed.hasMore).toBe(true);
    expect(fakeLedger.reads).toEqual([4]);
  });

  describe('where the plan under its roots is too large to name in the query', () => {
    beforeEach(() => {
      subtreeWalk.truncated = true;
    });

    it('lets every placed item through the query and still lists only its own', async () => {
      const { mine } = await mixedSpace();

      const listed = await list();

      expect(fakeLedger.owners[0]).not.toHaveProperty('planNodeIds');
      expect(new Set(ids(listed))).toEqual(mine);
    });

    it('stops at the bound, says so, and carries the cursor that reads on to its own', async () => {
      await mixedSpace();
      const rootOther = await planNode(null, 'another stream');
      const older = fakeLedger.rows;
      fakeLedger.rows = [];
      for (let i = 0; i < LIST_ATTENTION_SCAN_LIMIT; i++) {
        item(`foreign-${String(i)}`, { planNodeId: rootOther, sessionId: OTHER, driven: true });
      }
      const lastForeign = fakeLedger.rows.at(-1)?.item.id;
      fakeLedger.rows.push(...older);

      const first = await list({ limit: 5 });

      expect(first).toEqual({
        items: [],
        hasMore: true,
        cursor: lastForeign,
        truncated: { bound: 'rows_examined', value: LIST_ATTENTION_SCAN_LIMIT },
      });
      expect(fakeLedger.reads.reduce((sum, n) => sum + n, 0)).toBe(LIST_ATTENTION_SCAN_LIMIT);

      const next = await list({
        limit: 5,
        ...(first.cursor !== undefined ? { cursor: first.cursor } : {}),
      });

      expect(next.items.map(({ item }) => item.relatedRunId)).toContain('run-mine-on-root');
      expect(next).not.toHaveProperty('truncated');
    });
  });
});
