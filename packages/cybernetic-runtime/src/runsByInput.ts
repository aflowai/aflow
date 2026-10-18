import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createTenantContext, withTenantSchema } from '@aflow/database';
import type { TenantId, WorkflowRunListInput, WorkflowRunListOutput } from '@aflow/schemas';
import { drivenByLiveConversationSql, isReadersWork } from './conversationOwnership.js';
import { loadConversationPlanRoots, placeInPlan } from './plan/attention.js';
import { createPlanNodeStore } from './plan/store.js';

/**
 * One workflow's runs in a space that were started with one input equal to a
 * value — every conversation's, newest first, one page — each marked whose it
 * is by the ownership the attention block reads (`isReadersWork`).
 *
 * The value is read from the inputs the start validated and recorded on the
 * run (`metadata.parentTaskInputs.inputs`), so a run started without the
 * input is not one of them. The status filter and the slug bound the rows
 * read before the input comparison, and eval-batch replays are no one's work.
 */
export async function listRunsByInput(params: {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  /** The reading session, which `own` is measured against. */
  sessionId: string;
  query: WorkflowRunListInput;
}): Promise<WorkflowRunListOutput> {
  const { db, tenantId, spaceId, sessionId, query } = params;
  // Statuses come from the schema's enum, so the literal holds only those words.
  const statuses = `{${query.status.join(',')}}`;
  const rows = await withTenantSchema(db, createTenantContext(tenantId as TenantId), (tx) =>
    tx.execute(sql`
      SELECT
        r.run_id,
        r.status,
        r.started_at,
        r.session_id,
        r.plan_node_id,
        ${drivenByLiveConversationSql(sql`r.session_id`)} AS driven_by_live_conversation
      FROM workflow_runs r
      LEFT JOIN sessions ON sessions.session_id = r.session_id
      WHERE r.space_id = ${spaceId}
        AND r.workflow_slug = ${query.slug}
        AND r.status = ANY(${statuses}::text[])
        AND r.eval_batch_id IS NULL
        AND (r.metadata -> 'parentTaskInputs' -> 'inputs' -> ${query.input.field}) = ${JSON.stringify(query.input.equals)}::jsonb
      ORDER BY r.started_at DESC
      LIMIT ${query.limit + 1}
    `),
  );
  const listed = (rows as Array<Record<string, unknown>>).slice(0, query.limit);
  const reader = {
    sessionId,
    planRootIds: new Set(await loadConversationPlanRoots({ db, tenantId, spaceId, sessionId })),
  };
  const placements = await placeInPlan(
    createPlanNodeStore(db, tenantId),
    spaceId,
    listed.map((row) => (typeof row['plan_node_id'] === 'string' ? row['plan_node_id'] : null)),
  );
  return {
    runs: listed.map((row) => {
      const planNodeId = typeof row['plan_node_id'] === 'string' ? row['plan_node_id'] : undefined;
      const plan = planNodeId !== undefined ? placements.get(planNodeId) : undefined;
      const runSessionId = typeof row['session_id'] === 'string' ? row['session_id'] : undefined;
      return {
        id: row['run_id'] as string,
        status: row['status'] as WorkflowRunListOutput['runs'][number]['status'],
        startedAt: new Date(row['started_at'] as string).toISOString(),
        own: isReadersWork(
          {
            ...(plan !== undefined ? { plan } : {}),
            ...(runSessionId !== undefined ? { sessionId: runSessionId } : {}),
            drivenByLiveConversation: row['driven_by_live_conversation'] === true,
          },
          reader,
        ),
      };
    }),
    hasMore: rows.length > query.limit,
  };
}
