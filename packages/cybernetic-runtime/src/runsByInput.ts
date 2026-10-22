import { sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createTenantContext, withTenantSchema } from '@aflow/database';
import type { TenantId, WorkflowRunListInput, WorkflowRunListOutput } from '@aflow/schemas';
import { drivenByLiveConversationSql, isReadersWork } from './conversationOwnership.js';
import { PLAN_TREE_WALK_BOUNDS } from './plan/operations.js';
import { loadConversationPlanRoots, placeInPlan } from './plan/attention.js';
import { createPlanNodeStore } from './plan/store.js';

interface RunsQueryParams {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  /** The reading session, which `own` is measured against. */
  sessionId: string;
  query: WorkflowRunListInput;
}

/**
 * Runs in a space, every conversation's, newest first, one page — each marked
 * whose it is by the ownership the attention block reads (`isReadersWork`).
 * Selected one of two ways:
 *
 * - `slug` and `input`: one workflow's runs that were started with one input
 *   equal to a value. The value is read from the inputs the start validated
 *   and recorded on the run (`metadata.parentTaskInputs.inputs`), so a run
 *   started without the input is not one of them. The status filter and the
 *   slug bound the rows read before the input comparison.
 * - `servingNodeOfPullRequest`: the runs of any workflow serving the plan
 *   nodes that hold a `pull_request` link to that URL, or any node under them
 *   (Plan 322 P2). It reads the plan as the run ledger joins it — a skill
 *   never calls `plan.*` (D3) — and says whether the walk below the nodes was
 *   whole, since runs past its bounds are unread rather than absent.
 *
 * Eval-batch replays are no one's work.
 */
export async function listRunsByInput(params: RunsQueryParams): Promise<WorkflowRunListOutput> {
  const { query } = params;
  if (query.servingNodeOfPullRequest !== undefined) {
    return listRunsServingPullRequestNode(params, query.servingNodeOfPullRequest);
  }
  if (query.slug === undefined || query.input === undefined) {
    throw new Error('workflow.run.list names a slug with an input, or a pull request');
  }
  const { slug, input } = query;
  return listRunsWhere(
    params,
    sql`r.workflow_slug = ${slug}
        AND (r.metadata -> 'parentTaskInputs' -> 'inputs' -> ${input.field}) = ${JSON.stringify(input.equals)}::jsonb`,
  );
}

async function listRunsServingPullRequestNode(
  params: RunsQueryParams,
  pullRequestUrl: string,
): Promise<WorkflowRunListOutput> {
  const { db, tenantId, spaceId } = params;
  const linked = await withTenantSchema(db, createTenantContext(tenantId as TenantId), (tx) =>
    tx.execute(sql`
      SELECT DISTINCT node_id
      FROM plan_node_links
      WHERE space_id = ${spaceId} AND kind = 'pull_request' AND ref = ${pullRequestUrl}
    `),
  );
  const planNodeIds = (linked as Array<Record<string, unknown>>)
    .map((row) => row['node_id'])
    .filter((id): id is string => typeof id === 'string')
    .sort();
  if (planNodeIds.length === 0) return { runs: [], hasMore: false, planNodeIds, complete: true };

  const store = createPlanNodeStore(db, tenantId);
  // Every status: a run in flight for a node closed under it is still in flight.
  const walks = await Promise.all(
    planNodeIds.map((rootId) => store.walk(spaceId, { rootId, ...PLAN_TREE_WALK_BOUNDS })),
  );
  const served = [...new Set(walks.flatMap((walk) => walk.nodes.map((node) => node.nodeId)))];
  const listed = await listRunsWhere(
    params,
    sql`r.plan_node_id = ANY(${`{${served.join(',')}}`}::uuid[])`,
  );
  return {
    ...listed,
    planNodeIds,
    complete: walks.every((walk) => walk.truncated === undefined),
  };
}

async function listRunsWhere(
  params: RunsQueryParams,
  selects: SQL,
): Promise<WorkflowRunListOutput> {
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
        AND ${selects}
        AND r.status = ANY(${statuses}::text[])
        AND r.eval_batch_id IS NULL
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
