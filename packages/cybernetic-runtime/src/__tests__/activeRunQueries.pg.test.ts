/**
 * The reads the attention block and `workflow.run.list_attention` make, against
 * a real database: a run started on a plan node is read back with that node,
 * and whose a run is — its driving session's target and status — is decided by
 * Postgres itself, in the run read, the pending-item read and its counts.
 * Gated on DATABASE_URL like every pg test, and skipped where the tenant schema
 * predates the plan node column.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inArray, sql as drizzleSql } from 'drizzle-orm';
import {
  createDatabase,
  createTenantContext,
  sessions,
  tenantIdToSchemaName,
  withTenantSchema,
} from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import {
  addAttentionItemInTransaction,
  listAttentionItems,
  readPendingRunAttention,
} from '../ledger/attention.js';
import { listAttentionForConversation } from '../attentionList.js';
import { isReadersWork } from '../conversationOwnership.js';
import { listActiveRunsWithLiveness } from '../ledger/queries.js';
import { recordRunStart } from '../ledger/runs.js';
import {
  pendingAttentionFor,
  renderedAttentionItemIds,
  summarizePendingAttention,
} from '../pendingAttention.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const TENANT_SCHEMA = tenantIdToSchemaName(TENANT_ID);
const SPACE_ID = randomUUID();
const LIMIT = 10;

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('listActiveRunsWithLiveness — a run carries its plan node (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  let columnPresent = false;

  beforeAll(async () => {
    const rows = await handle.sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = ${TENANT_SCHEMA}
          AND table_name = 'workflow_runs'
          AND column_name = 'plan_node_id'
      ) AS ok`;
    columnPresent = rows[0]?.ok === true;
  });

  beforeEach((test) => {
    if (!columnPresent) test.skip();
  });

  afterAll(async () => {
    if (columnPresent) {
      await withTenantSchema(handle.db, createTenantContext(TENANT_ID), (tx) =>
        tx.execute(drizzleSql`DELETE FROM workflow_runs WHERE space_id = ${SPACE_ID}::uuid`),
      );
    }
    await handle.close();
  });

  it('reads the node back on the run that serves it, and none on the run that serves none', async () => {
    const planNodeId = randomUUID();
    const onNode = `run-${randomUUID()}`;
    const offPlan = `run-${randomUUID()}`;
    const startedAt = new Date();
    for (const [runId, node] of [
      [onNode, planNodeId],
      [offPlan, undefined],
    ] as const) {
      await recordRunStart(handle.db, TENANT_ID, {
        spaceId: SPACE_ID,
        workflowSlug: 'plan-node-read-back',
        runId,
        workflowRevision: 1,
        startedAt,
        planNodeId: node,
      });
    }

    const runs = await listActiveRunsWithLiveness(handle.db, TENANT_ID, SPACE_ID, {
      limit: LIMIT,
    });

    expect(runs.find((run) => run.runId === onNode)).toMatchObject({ planNodeId });
    expect(runs.find((run) => run.runId === offPlan)).not.toHaveProperty('planNodeId');
  });

  describe('a run is owned by the live Helmsman conversation that drove it', () => {
    const HELMSMAN = {
      targetKind: 'platform-role',
      targetSystemRole: 'cybernetic-helmsman',
    } as const;
    const RUNNER = { targetKind: 'platform-role', targetSystemRole: 'cybernetic-runner' } as const;
    /** Each driver, and whether it still owns the runs it drove. */
    const DRIVERS = [
      { name: 'a running conversation', target: HELMSMAN, status: 'RUNNING', owns: true },
      { name: 'a paused conversation', target: HELMSMAN, status: 'PAUSED', owns: true },
      {
        name: 'a failed conversation, which can be retried',
        target: HELMSMAN,
        status: 'FAILED',
        owns: true,
      },
      { name: 'a conversation that succeeded', target: HELMSMAN, status: 'SUCCEEDED', owns: false },
      { name: 'a cancelled conversation', target: HELMSMAN, status: 'CANCELLED', owns: false },
      {
        name: 'a running session that is not a conversation',
        target: RUNNER,
        status: 'RUNNING',
        owns: false,
      },
      { name: 'a session the projection has not written yet', unprojected: true, owns: true },
    ] as const;
    const sessionIds: string[] = [];

    afterAll(async () => {
      if (!columnPresent || sessionIds.length === 0) return;
      await withTenantSchema(handle.db, createTenantContext(TENANT_ID), async (tx) => {
        await tx.execute(
          drizzleSql`DELETE FROM attention_items WHERE space_id = ${SPACE_ID}::uuid`,
        );
        await tx.execute(drizzleSql`DELETE FROM workflow_runs WHERE space_id = ${SPACE_ID}::uuid`);
        await tx.delete(sessions).where(inArray(sessions.sessionId, sessionIds));
      });
    });

    /** A run driven by each driver, and one by no session, each paused with an attention item. */
    async function runsByDriver() {
      const startedAt = new Date();
      const driven = [];
      for (const driver of [...DRIVERS, { name: 'no session', owns: false }]) {
        const sessionId = 'target' in driver || 'unprojected' in driver ? randomUUID() : undefined;
        if (sessionId !== undefined && 'target' in driver) {
          sessionIds.push(sessionId);
          await withTenantSchema(handle.db, createTenantContext(TENANT_ID), (tx) =>
            tx.insert(sessions).values({
              sessionId,
              ...driver.target,
              agentVersion: '1',
              status: driver.status,
              spaceId: SPACE_ID,
            }),
          );
        }
        const runId = `run-${randomUUID()}`;
        await recordRunStart(handle.db, TENANT_ID, {
          spaceId: SPACE_ID,
          workflowSlug: 'run-ownership',
          runId,
          workflowRevision: 1,
          startedAt,
          ...(sessionId !== undefined ? { sessionId } : {}),
        });
        await withTenantSchema(handle.db, createTenantContext(TENANT_ID), (tx) =>
          addAttentionItemInTransaction(tx, TENANT_ID, {
            spaceId: SPACE_ID,
            kind: 'workflow_run_paused',
            relatedRunId: runId,
            payload: {},
            priority: 0,
          }),
        );
        driven.push({ ...driver, runId, sessionId: sessionId ?? null });
      }
      return driven;
    }

    it('reads each active run as owned or everyone’s by its driver’s target and status', async () => {
      const driven = await runsByDriver();

      const runs = await listActiveRunsWithLiveness(handle.db, TENANT_ID, SPACE_ID, {
        limit: LIMIT * 2,
      });

      for (const { name, runId, owns } of driven) {
        expect(runs.find((run) => run.runId === runId)?.drivenByLiveConversation, name).toBe(owns);
      }
    });

    it("reads each pending item's run the same way, in the block's read and the operation's", async () => {
      const driven = await runsByDriver();
      const runIds = new Set(driven.map(({ runId }) => runId));

      const pending = await readPendingRunAttention(handle.db, TENANT_ID, SPACE_ID, LIMIT);
      const listed = await listAttentionItems(handle.db, TENANT_ID, {
        spaceId: SPACE_ID,
        limit: LIMIT * 4,
      });

      for (const { name, runId, sessionId, owns } of driven) {
        expect(
          pending.items.find((item) => item.runId === runId)?.drivenByLiveConversation,
          name,
        ).toBe(owns);
        expect(
          listed.find(({ item }) => item.relatedRunId === runId)?.drivenByLiveConversation,
          name,
        ).toBe(owns);
        expect(
          pending.counts.find(
            (count) => count.sessionId === sessionId && count.planNodeId === null,
          ),
          name,
        ).toMatchObject({ drivenByLiveConversation: owns });
      }
      expect(
        pending.items.filter((item) => item.runId !== null && runIds.has(item.runId)),
      ).toHaveLength(driven.length);
    });

    it('counts a run whose driving session has no row yet to every other conversation, and lists it to none', async () => {
      const driven = await runsByDriver();
      const unprojected = driven.find((driver) => 'unprojected' in driver);
      const driver = unprojected?.sessionId;
      if (unprojected === undefined || driver == null) throw new Error('no unprojected driver');
      const stranger = { sessionId: randomUUID(), planRootIds: new Set<string>() };

      const run = (
        await listActiveRunsWithLiveness(handle.db, TENANT_ID, SPACE_ID, { limit: LIMIT * 4 })
      ).find(({ runId }) => runId === unprojected.runId);
      expect(run).toMatchObject({ sessionId: driver, drivenByLiveConversation: true });
      expect(isReadersWork({ sessionId: driver, drivenByLiveConversation: true }, stranger)).toBe(
        false,
      );

      const pending = summarizePendingAttention(
        await readPendingRunAttention(handle.db, TENANT_ID, SPACE_ID, LIMIT),
        new Map(),
      );
      const itemId = pending?.items.find(({ runId }) => runId === unprojected.runId)?.itemId;
      expect(itemId).toBeDefined();
      const toStranger = pendingAttentionFor(pending, stranger);
      expect(renderedAttentionItemIds(toStranger)).not.toContain(itemId);
      expect(
        pending?.totals.find((total) => total.sessionId === driver && total.plan === undefined),
      ).toMatchObject({ drivenByLiveConversation: true, total: 1 });
      expect(toStranger.others).toBeGreaterThanOrEqual(1);
      expect(
        renderedAttentionItemIds(
          pendingAttentionFor(pending, { sessionId: driver, planRootIds: new Set() }),
        ),
      ).toContain(itemId);

      const listed = (scope: 'conversation' | 'space') =>
        listAttentionForConversation({
          db: handle.db,
          tenantId: TENANT_ID,
          spaceId: SPACE_ID,
          sessionId: stranger.sessionId,
          scope,
          includeConsumed: false,
          limit: LIMIT * 10,
        });
      expect((await listed('conversation')).items.map(({ item }) => item.id)).not.toContain(itemId);
      expect((await listed('space')).items.find(({ item }) => item.id === itemId)).toMatchObject({
        own: false,
      });
    });

    it('narrows the operation’s read to the rows its reader owns, as `isReadersWork` decides them', async () => {
      const driven = await runsByDriver();
      const reader = driven.find(({ name }) => name === 'a running conversation')?.sessionId;
      if (reader == null) throw new Error('no running conversation');
      const whole = await listAttentionItems(handle.db, TENANT_ID, {
        spaceId: SPACE_ID,
        limit: LIMIT * 10,
      });

      const narrowed = await listAttentionItems(handle.db, TENANT_ID, {
        spaceId: SPACE_ID,
        limit: LIMIT * 10,
        owner: { sessionId: reader, planNodeIds: [] },
      });

      const owned = whole.filter((row) =>
        isReadersWork(
          {
            ...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
            drivenByLiveConversation: row.drivenByLiveConversation,
          },
          { sessionId: reader, planRootIds: new Set() },
        ),
      );
      expect(narrowed.map(({ item }) => item.id)).toEqual(owned.map(({ item }) => item.id));
      expect(owned.length).toBeLessThan(whole.length);
    });

    it('pages the operation’s read one item at a time in the order it lists them whole', async () => {
      await runsByDriver();
      const whole = await listAttentionItems(handle.db, TENANT_ID, {
        spaceId: SPACE_ID,
        limit: LIMIT * 4,
      });

      const paged: string[] = [];
      for (;;) {
        const after = paged.at(-1);
        const [next] = await listAttentionItems(handle.db, TENANT_ID, {
          spaceId: SPACE_ID,
          limit: 1,
          ...(after !== undefined ? { afterItemId: after } : {}),
        });
        if (next === undefined) break;
        paged.push(next.item.id);
      }

      expect(paged).toEqual(whole.map(({ item }) => item.id));
    });
  });
});
