/**
 * The active-run reads are hand-written SELECTs mapped by hand, and every
 * caller's test mocks the read, so a column the mapper reads but the SELECT
 * omits is invisible to them: the field is simply absent on every row. Here
 * the statement is built for real and run against the mapper, and every column
 * the mapper reads must be one the SELECT returns.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  listActiveRunsForWorkflowWithLiveness,
  listActiveRunsWithLiveness,
} from '../ledger/queries.js';

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const SPACE_ID = 'b0000000-0000-0000-0000-000000000001';
const PLAN_NODE_ID = 'c0000000-0000-0000-0000-000000000001';
const LIMIT = 10;

/**
 * A real drizzle instance over a fake postgres-js client: each statement is
 * rendered for real and answered with `rows`, and nothing reaches a database.
 */
function fakeDb(rows: unknown[]): {
  db: PostgresJsDatabase;
  queries: string[];
  parameters: unknown[][];
} {
  const queries: string[] = [];
  const parameters: unknown[][] = [];
  const client: object = Object.assign(
    () => {
      throw new Error('tagged-template query is not expected');
    },
    {
      unsafe: (query: string, params: unknown[] = []) => {
        queries.push(query);
        parameters.push(params);
        const answer = query.includes('search_path') ? [] : rows;
        return Object.assign(Promise.resolve(answer), { values: () => Promise.resolve(answer) });
      },
      begin: (fn: (tx: unknown) => Promise<unknown>) => fn(client),
      options: { parsers: {}, serializers: {} },
    },
  );
  return { db: drizzle(client as unknown as postgres.Sql), queries, parameters };
}

/** A row that answers every column and records which ones were read. */
function recordingRow(): { row: Record<string, unknown>; read: Set<string> } {
  const read = new Set<string>();
  const row = new Proxy<Record<string, unknown>>(
    {},
    {
      get: (_target, key) => {
        if (typeof key === 'string') read.add(key);
        return '2026-10-05T00:00:00.000Z';
      },
    },
  );
  return { row, read };
}

/** The output names of the outer SELECT: each item's alias, or its bare column. */
function selectedColumns(query: string): string[] {
  const select = query.indexOf('SELECT');
  const from = query.indexOf('FROM workflow_runs');
  expect(select).toBeGreaterThanOrEqual(0);
  expect(from).toBeGreaterThan(select);

  const items: string[] = [];
  let depth = 0;
  let item = '';
  for (const char of query.slice(select + 'SELECT'.length, from)) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      items.push(item);
      item = '';
    } else {
      item += char;
    }
  }
  items.push(item);

  return items.map((selected) => {
    const name = /(?:\bAS\s+|\.)?(\w+)\s*$/i.exec(selected.trim())?.[1];
    expect(name, `no output name in "${selected.trim()}"`).toBeDefined();
    return name!;
  });
}

const READS = [
  {
    name: 'listActiveRunsWithLiveness',
    read: (db: PostgresJsDatabase) =>
      listActiveRunsWithLiveness(db, TENANT_ID, SPACE_ID, { limit: LIMIT }),
  },
  {
    name: 'listActiveRunsForWorkflowWithLiveness',
    read: (db: PostgresJsDatabase) =>
      listActiveRunsForWorkflowWithLiveness(db, TENANT_ID, SPACE_ID, 'a-skill', {
        limit: LIMIT,
      }),
  },
];

describe('active-run reads — the SELECT returns every column its mapper reads', () => {
  it.each(READS)('$name', async ({ read }) => {
    const { row, read: columnsRead } = recordingRow();
    const { db, queries } = fakeDb([row]);

    await read(db);

    const statement = queries.find((query) => query.includes('FROM workflow_runs'));
    expect(statement).toBeDefined();
    expect(columnsRead.size).toBeGreaterThan(0);
    expect(selectedColumns(statement!)).toEqual(expect.arrayContaining([...columnsRead]));
  });
});

describe('listActiveRunsWithLiveness', () => {
  it("carries a run's plan node, which the attention block groups it under", async () => {
    const { row, read } = recordingRow();
    const { db, queries } = fakeDb([row]);

    await listActiveRunsWithLiveness(db, TENANT_ID, SPACE_ID, { limit: LIMIT });

    const statement = queries.find((query) => query.includes('FROM workflow_runs'));
    expect(read).toContain('plan_node_id');
    expect(selectedColumns(statement!)).toContain('plan_node_id');
  });

  it('maps the node a run serves, and gives a run serving none no node', async () => {
    const { db } = fakeDb([
      {
        run_id: 'run-1',
        space_id: SPACE_ID,
        workflow_slug: 'a-skill',
        session_id: null,
        status: 'running',
        started_at: '2026-10-05T00:00:00.000Z',
        scheduler_cursor_at: null,
        plan_node_id: null,
        total_tasks: 0,
        succeeded_tasks: 0,
        live_tasks: 0,
        scheduled_tasks: 0,
        paused_tasks: 0,
      },
      {
        run_id: 'run-2',
        space_id: SPACE_ID,
        workflow_slug: 'a-skill',
        session_id: null,
        status: 'running',
        started_at: '2026-10-05T00:00:00.000Z',
        scheduler_cursor_at: null,
        plan_node_id: PLAN_NODE_ID,
        total_tasks: 0,
        succeeded_tasks: 0,
        live_tasks: 0,
        scheduled_tasks: 0,
        paused_tasks: 0,
      },
    ]);

    const [without, withNode] = await listActiveRunsWithLiveness(db, TENANT_ID, SPACE_ID, {
      limit: LIMIT,
    });

    expect(without).not.toHaveProperty('planNodeId');
    expect(withNode).toMatchObject({ runId: 'run-2', planNodeId: PLAN_NODE_ID });
  });

  it('asks whether the session that drove each run is a Helmsman conversation that has not ended', async () => {
    const { db, queries, parameters } = fakeDb([
      { run_id: 'run-live', driven_by_live_conversation: true },
      { run_id: 'run-operator', driven_by_live_conversation: false },
    ]);

    const [live, operator] = await listActiveRunsWithLiveness(db, TENANT_ID, SPACE_ID, {
      limit: LIMIT,
    });

    const index = queries.findIndex((query) => query.includes('FROM workflow_runs'));
    expect(queries[index]).toContain('LEFT JOIN sessions s ON s.session_id = r.session_id');
    expect(parameters[index]).toEqual(
      expect.arrayContaining([
        'platform-role',
        'cybernetic-helmsman',
        'SUCCEEDED',
        'FAILED',
        'CANCELLED',
      ]),
    );
    expect(live).toMatchObject({ runId: 'run-live', drivenByLiveConversation: true });
    expect(operator).toMatchObject({ runId: 'run-operator', drivenByLiveConversation: false });
  });
});
