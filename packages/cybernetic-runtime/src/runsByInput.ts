import { sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createTenantContext, withTenantSchema } from '@aflow/database';
import type { PayloadStore } from '@aflow/payload-store';
import {
  WORKFLOW_RUN_LIST_LIMIT_MAX,
  type TenantId,
  type WorkflowRunListInput,
  type WorkflowRunListOutput,
  type WorkflowRunListSucceededTask,
} from '@aflow/schemas';
import {
  drivenByActingConversationSql,
  drivenByLiveConversationSql,
  isReadersWork,
} from './conversationOwnership.js';
import { PLAN_TREE_WALK_BOUNDS } from './plan/operations.js';
import { loadConversationPlanRoots, placeInPlan } from './plan/attention.js';
import { createPlanNodeStore } from './plan/store.js';
import { readOutputPath } from './scheduling/outputPath.js';

interface RunsQueryParams {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  /** The reading session, which `own` is measured against. */
  sessionId: string;
  query: WorkflowRunListInput;
  /** Reads the outputs `succeeded` compares; only a query naming an output needs it. */
  payloadStore?: Pick<PayloadStore, 'retrieve'>;
  /**
   * The owner the loop records for the pull request `startedByActingOwnerOf`
   * names, read by the caller from the pull request's watch. Null where it
   * records none. Only a query naming that filter needs it.
   */
  pullRequestOwner?: string | null;
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
 *   slug bound the rows read before the input comparison. `succeeded`
 *   narrows them to runs that succeeded in each named task; an output it
 *   names is read from the payload that task recorded, newest run first,
 *   through at most {@link WORKFLOW_RUN_LIST_LIMIT_MAX} candidates.
 *   `startedByActingOwnerOf` narrows them to the runs the pull request's
 *   recorded owner started, while that conversation can act (Plan 339 D4).
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
  const { slug, input, succeeded = [] } = query;
  let startedByOwner = sql``;
  if (query.startedByActingOwnerOf !== undefined) {
    const owner = params.pullRequestOwner;
    if (owner === undefined) {
      throw new Error(
        "workflow.run.list lists a pull request owner's runs only where its caller read the owner",
      );
    }
    // A pull request no conversation owns has no owner's runs.
    if (owner === null) return { runs: [], hasMore: false };
    startedByOwner = sql` AND r.session_id = ${owner} AND ${drivenByActingConversationSql(sql`r.session_id`)}`;
  }
  return listRunsWhere(
    params,
    sql`r.workflow_slug = ${slug}
        AND (r.metadata -> 'parentTaskInputs' -> 'inputs' -> ${input.field}) = ${JSON.stringify(input.equals)}::jsonb
        ${startedByOwner}
        ${sql.join(
          succeeded.map((task) => sql` AND EXISTS (${succeededTaskRow(task, sql`1`)})`),
          sql``,
        )}`,
    succeeded.filter((task) => task.output !== undefined),
  );
}

function succeededTaskRow(task: WorkflowRunListSucceededTask, column: SQL): SQL {
  return sql`SELECT ${column} FROM workflow_run_tasks t
    WHERE t.run_id = r.run_id AND t.task_id = ${task.taskId} AND t.status = 'succeeded'
    ORDER BY t.attempt DESC LIMIT 1`;
}

async function recordedOutputsHold(
  payloadStore: Pick<PayloadStore, 'retrieve'> | undefined,
  row: Record<string, unknown>,
  outputs: readonly WorkflowRunListSucceededTask[],
): Promise<boolean> {
  if (payloadStore === undefined) {
    throw new Error('workflow.run.list compares a recorded output only with a payload store');
  }
  for (const [index, task] of outputs.entries()) {
    const ref = row[outputRefColumn(index)];
    if (typeof ref !== 'string' || task.output === undefined) return false;
    // A payload that can no longer be read — expired, or its store refusing —
    // shows this run's output to no one: it is not the run asked for, and the
    // runs after it are still read.
    let recorded: unknown;
    try {
      recorded = await payloadStore.retrieve(ref);
    } catch {
      return false;
    }
    if (readOutputPath(recorded, task.output.path) !== task.output.equals) return false;
  }
  return true;
}

function outputRefColumn(index: number): string {
  return `output_ref_${String(index)}`;
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
  outputs: readonly WorkflowRunListSucceededTask[] = [],
): Promise<WorkflowRunListOutput> {
  const { db, tenantId, spaceId, sessionId, query, payloadStore } = params;
  // Statuses come from the schema's enum, so the literal holds only those words.
  const statuses = `{${query.status.join(',')}}`;
  // An output is compared after the rows are read, so they are read to the
  // scan's bound rather than the page's.
  const rowLimit = outputs.length > 0 ? WORKFLOW_RUN_LIST_LIMIT_MAX : query.limit;
  const rows = await withTenantSchema(db, createTenantContext(tenantId as TenantId), (tx) =>
    tx.execute(sql`
      SELECT
        r.run_id,
        r.status,
        r.started_at,
        r.session_id,
        r.plan_node_id,
        ${sql.join(
          outputs.map(
            (task, index) =>
              sql`(${succeededTaskRow(task, sql`t.output_ref`)}) AS ${sql.raw(outputRefColumn(index))},`,
          ),
          sql``,
        )}
        ${drivenByLiveConversationSql(sql`r.session_id`)} AS driven_by_live_conversation
      FROM workflow_runs r
      LEFT JOIN sessions ON sessions.session_id = r.session_id
      WHERE r.space_id = ${spaceId}
        AND ${selects}
        AND r.status = ANY(${statuses}::text[])
        AND r.eval_batch_id IS NULL
      ORDER BY r.started_at DESC
      LIMIT ${rowLimit + 1}
    `),
  );
  const read = rows as Array<Record<string, unknown>>;
  const candidates = read.slice(0, rowLimit);
  let listed: Array<Record<string, unknown>>;
  let hasMore: boolean;
  if (outputs.length === 0) {
    listed = candidates;
    hasMore = read.length > rowLimit;
  } else {
    // Each candidate costs a payload read, so the scan stops at the page:
    // `hasMore` then says candidates were left unread, not that they match.
    listed = [];
    let scanned = 0;
    for (const row of candidates) {
      if (listed.length === query.limit) break;
      scanned += 1;
      if (await recordedOutputsHold(payloadStore, row, outputs)) listed.push(row);
    }
    hasMore = scanned < candidates.length || read.length > rowLimit;
  }
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
    hasMore,
  };
}
