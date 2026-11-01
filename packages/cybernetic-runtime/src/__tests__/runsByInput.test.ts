/**
 * `workflow.run.list` narrowed by `succeeded`: the run must have succeeded in
 * every named task, and a named output is read from the payload the task
 * recorded and compared as recorded. The statement is rendered for real over
 * a fake client; only the rows and the payloads are scripted.
 */
import { describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { WORKFLOW_RUN_LIST_LIMIT_MAX, WorkflowRunListInputSchema } from '@aflow/schemas';
import { listRunsByInput } from '../runsByInput.js';

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const SPACE_ID = 'b0000000-0000-0000-0000-000000000001';
const SESSION_ID = 'c0000000-0000-0000-0000-000000000001';
const HEAD = 'c'.repeat(40);

function fakeDb(runs: unknown[]): {
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
        const answer = query.includes('FROM workflow_runs r') ? runs : [];
        return Object.assign(Promise.resolve(answer), { values: () => Promise.resolve(answer) });
      },
      begin: (fn: (tx: unknown) => Promise<unknown>) => fn(client),
      options: { parsers: {}, serializers: {} },
    },
  );
  return { db: drizzle(client as unknown as postgres.Sql), queries, parameters };
}

function run(id: string, outputRef: string): Record<string, unknown> {
  return {
    run_id: id,
    status: 'completed',
    started_at: '2026-10-18T07:00:00.000Z',
    session_id: null,
    plan_node_id: null,
    output_ref_0: outputRef,
    driven_by_live_conversation: false,
  };
}

const PUSHED_HEAD = {
  slug: 'publish-local-changes',
  input: { field: 'branch', equals: 'aflow/x' },
  succeeded: [
    { taskId: 'push' },
    { taskId: 'commit', output: { path: 'commit.sha', equals: HEAD } },
  ],
  status: ['completed', 'failed', 'cancelled'],
  limit: 1,
};

describe('workflow.run.list — the runs that succeeded in named tasks', () => {
  it('lists the newest run whose recorded output holds the value, past newer ones that recorded another', async () => {
    const recorded: Record<string, unknown> = {
      'inline:newest': { commit: { sha: 'd'.repeat(40) } },
      'inline:pushed-head': { commit: { sha: HEAD } },
      'inline:older': { commit: { sha: HEAD } },
    };
    const retrieve = vi.fn((ref: string) => Promise.resolve(recorded[ref]));
    const { db, queries, parameters } = fakeDb([
      run('00000000-0000-4000-8000-000000000003', 'inline:newest'),
      run('00000000-0000-4000-8000-000000000002', 'inline:pushed-head'),
      run('00000000-0000-4000-8000-000000000001', 'inline:older'),
    ]);

    const listed = await listRunsByInput({
      db,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      sessionId: SESSION_ID,
      query: WorkflowRunListInputSchema.parse(PUSHED_HEAD),
      payloadStore: { retrieve } as never,
    });

    expect(listed.runs.map((r) => r.id)).toEqual(['00000000-0000-4000-8000-000000000002']);
    expect(listed.hasMore).toBe(true);
    expect(retrieve.mock.calls.map(([ref]) => ref)).toEqual([
      'inline:newest',
      'inline:pushed-head',
    ]);
    const index = queries.findIndex((query) => query.includes('FROM workflow_runs r'));
    const statement = queries[index]!;
    expect(statement.match(/FROM workflow_run_tasks t/g)).toHaveLength(3);
    expect(statement).toContain("t.status = 'succeeded'");
    expect(statement).toContain('AS output_ref_0');
    expect(parameters[index]).toEqual(
      expect.arrayContaining(['push', 'commit', WORKFLOW_RUN_LIST_LIMIT_MAX + 1]),
    );
  });

  it('passes over a run whose recorded output can no longer be read, and lists the next that holds the value', async () => {
    const retrieve = vi.fn((ref: string) =>
      ref === 'inline:expired'
        ? Promise.reject(new Error('payload expired'))
        : Promise.resolve({ commit: { sha: HEAD } }),
    );
    const { db } = fakeDb([
      run('00000000-0000-4000-8000-000000000002', 'inline:expired'),
      run('00000000-0000-4000-8000-000000000001', 'inline:pushed-head'),
    ]);

    const listed = await listRunsByInput({
      db,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      sessionId: SESSION_ID,
      query: WorkflowRunListInputSchema.parse(PUSHED_HEAD),
      payloadStore: { retrieve } as never,
    });

    expect(listed.runs.map((r) => r.id)).toEqual(['00000000-0000-4000-8000-000000000001']);
    expect(listed.hasMore).toBe(false);
  });

  it('reads no payload and lists one page where no output is named', async () => {
    const retrieve = vi.fn();
    const { db, parameters, queries } = fakeDb([
      run('00000000-0000-4000-8000-000000000002', 'inline:x'),
    ]);

    const listed = await listRunsByInput({
      db,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      sessionId: SESSION_ID,
      query: WorkflowRunListInputSchema.parse({ ...PUSHED_HEAD, succeeded: [{ taskId: 'push' }] }),
      payloadStore: { retrieve } as never,
    });

    expect(listed.runs).toHaveLength(1);
    expect(listed.hasMore).toBe(false);
    expect(retrieve).not.toHaveBeenCalled();
    const index = queries.findIndex((query) => query.includes('FROM workflow_runs r'));
    expect(queries[index]).not.toContain('output_ref_0');
    expect(parameters[index]).toContain(2);
  });

  it("lists only the runs the pull request's recorded owner started, while it can act, a failed one excluded", async () => {
    const owner = '00000000-0000-4000-8000-0000000000aa';
    const owned = WorkflowRunListInputSchema.parse({
      slug: 'publish-local-changes',
      input: { field: 'branch', equals: 'aflow/x' },
      startedByActingOwnerOf: 'https://github.com/AflowAI/Aflow/pull/276',
      limit: 1,
    });
    const { db, queries, parameters } = fakeDb([]);
    await listRunsByInput({
      db,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      sessionId: SESSION_ID,
      query: owned,
      pullRequestOwner: owner,
    });
    const index = queries.findIndex((query) => query.includes('FROM workflow_runs r'));
    const statement = queries[index]!;
    const where = statement.slice(statement.indexOf('WHERE'));
    expect(where).toContain('r.session_id =');
    expect(where).toContain('"sessions"."target_system_role"');
    expect(where).toContain('not in');
    expect(parameters[index]).toEqual(
      expect.arrayContaining([owner, 'SUCCEEDED', 'CANCELLED', 'FAILED']),
    );

    // A pull request the loop records no owner for has no owner's runs, and nothing is read.
    const { db: unowned, queries: none } = fakeDb([]);
    expect(
      await listRunsByInput({
        db: unowned,
        tenantId: TENANT_ID,
        spaceId: SPACE_ID,
        sessionId: SESSION_ID,
        query: owned,
        pullRequestOwner: null,
      }),
    ).toEqual({ runs: [], hasMore: false });
    expect(none.some((query) => query.includes('FROM workflow_runs r'))).toBe(false);

    // The caller reads the owner. A query naming the filter without it is refused.
    await expect(
      listRunsByInput({
        db: unowned,
        tenantId: TENANT_ID,
        spaceId: SPACE_ID,
        sessionId: SESSION_ID,
        query: owned,
      }),
    ).rejects.toThrow(/read the owner/);

    const { db: unfiltered, queries: plain } = fakeDb([]);
    const { startedByActingOwnerOf: _filter, ...everyone } = owned;
    await listRunsByInput({
      db: unfiltered,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      sessionId: SESSION_ID,
      query: everyone,
    });
    const read = plain.find((query) => query.includes('FROM workflow_runs r'))!;
    expect(read.slice(read.indexOf('WHERE'))).not.toContain('target_system_role');
  });

  it('refuses the owner filter beside a pull request selector, or naming no pull request', () => {
    expect(
      WorkflowRunListInputSchema.safeParse({
        servingNodeOfPullRequest: 'https://github.com/o/r/pull/1',
        startedByActingOwnerOf: 'https://github.com/o/r/pull/1',
      }).success,
    ).toBe(false);
    expect(
      WorkflowRunListInputSchema.safeParse({
        slug: 'publish-local-changes',
        input: { field: 'branch', equals: 'aflow/x' },
        startedByActingOwnerOf: 'aflow/x',
      }).success,
    ).toBe(false);
  });

  it('refuses to compare an output with no payload store to read it from', async () => {
    const { db } = fakeDb([run('00000000-0000-4000-8000-000000000002', 'inline:x')]);
    await expect(
      listRunsByInput({
        db,
        tenantId: TENANT_ID,
        spaceId: SPACE_ID,
        sessionId: SESSION_ID,
        query: WorkflowRunListInputSchema.parse(PUSHED_HEAD),
      }),
    ).rejects.toThrow(/payload store/);
  });
});
