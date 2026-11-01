/**
 * What waits on a person, as the Helmsman's attention block carries it (Plan
 * 338 D2): a count per kind and the newest few items, each by its title, its
 * Action Center id and, for a plan step, its place on the plan page. Enough to
 * point the operator at an item, and no more: no item's summary, request or
 * note enters the block.
 *
 * Plan steps are counted from the walk the block already makes, by the rules
 * the Action Center's two plan sources list by, so the count reads as the
 * sidebar's. Run gates and consents are counted with queries over the tables
 * their sources read. The aggregator is not called: it lives in the server,
 * builds whole items with their summaries, and projects them per reader.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  ACTION_CENTER_ITEM_ID_PREFIX,
  computeEgressTitle,
  humanRequestTitle,
  inferTaskType,
  oauthConsentTitle,
  pausedRequestTitle,
  pendingPlanStepCount,
  planItemTitle,
  type PlanNodeSummary,
  type TenantId,
  type Workflow,
  type WorkflowTask,
} from '@aflow/schemas';
import {
  createTenantContext,
  resolveWorkflowForRunRevision,
  withTenantSchema,
} from '@aflow/database';
import { selectWaitingNodes } from './plan/asks.js';
import { selectOpenDecisions } from './plan/operations.js';

/** The most items the section lists under its counts. */
export const WAITING_ON_PERSON_LINE_LIMIT = 5;

/**
 * The most characters of an item's title a line carries. A prompt budget,
 * measured against `WAITING_ON_PERSON_TOKEN_CEILING`, and not a limit on
 * what a title may hold.
 */
export const WAITING_ON_PERSON_TITLE_MAX_CHARS = 120;

/** The most tokens the section holds by `estimateStringTokens`, at its longest titles and ids. */
export const WAITING_ON_PERSON_TOKEN_CEILING = 500;

/** The step-plane source reads the newest this many paused sessions, so the count does too. */
const PAUSED_SESSION_SCAN_LIMIT = 1_000;

export type WaitingItemKind = 'plan_step' | 'run_gate' | 'consent';

export interface WaitingItem {
  kind: WaitingItemKind;
  /** The Action Center item's id, as `human.action_center.focus` takes it. */
  itemId: string;
  /** The item's title, cut to `WAITING_ON_PERSON_TITLE_MAX_CHARS`. */
  title: string;
  requestedAt: string;
  /** The plan node, where the item is a plan step. */
  planNodeId?: string;
}

/** The plan steps that wait, as the sidebar counts them: the two sets and the newest of both. */
export interface WaitingPlanSteps {
  /** Waiting nodes, at most `PLAN_OPEN_ASKS_LIMIT` (`selectWaitingNodes`). */
  asks: number;
  /** Open `decide` nodes, at most `PLAN_OPEN_DECISIONS_LIMIT` (`selectOpenDecisions`). */
  decisions: number;
  newest: WaitingItem[];
}

/** The run gates and consents that wait, counted over their sources' tables. */
export interface WaitingGates {
  runGates: number;
  consents: number;
  newest: WaitingItem[];
}

/** The section's data. A count left out was not read, and the section says so. */
export interface WaitingOnPerson {
  planSteps?: { asks: number; decisions: number };
  gates?: { runGates: number; consents: number };
  /** Newest first, at most `WAITING_ON_PERSON_LINE_LIMIT`. */
  items: WaitingItem[];
  /** The space's slug, for the plan link. */
  spaceSlug?: string;
}

// ============================================================================
// Titles and order
// ============================================================================

/** A title on one line, at most `WAITING_ON_PERSON_TITLE_MAX_CHARS`, ending in an ellipsis where it was cut. */
export function waitingItemTitle(title: string): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  if (flat.length <= WAITING_ON_PERSON_TITLE_MAX_CHARS) return flat;
  let end = WAITING_ON_PERSON_TITLE_MAX_CHARS - 1;
  // A cut between the halves of a surrogate pair would leave half a character.
  if (/[\uD800-\uDBFF]/.test(flat[end - 1]!)) end--;
  return `${flat.slice(0, end).trimEnd()}…`;
}

function newestFirst(a: WaitingItem, b: WaitingItem): number {
  return Date.parse(b.requestedAt) - Date.parse(a.requestedAt) || a.itemId.localeCompare(b.itemId);
}

/** The newest items of every set given, at most `WAITING_ON_PERSON_LINE_LIMIT`. */
export function newestWaitingItems(...sets: ReadonlyArray<readonly WaitingItem[]>): WaitingItem[] {
  return sets.flat().sort(newestFirst).slice(0, WAITING_ON_PERSON_LINE_LIMIT);
}

/** An instant as ISO text; the first of the values given that reads as one. */
function isoOf(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string' && !(value instanceof Date)) continue;
    const at = new Date(value);
    if (!Number.isNaN(at.getTime())) return at.toISOString();
  }
  return new Date(0).toISOString();
}

// ============================================================================
// Plan steps, from the walk of the open tree
// ============================================================================

/**
 * The plan steps that wait, from a walk of the open tree: the nodes the
 * Action Center's `plan_ask` source lists and the decisions its
 * `plan_decision` source lists, each set cut where its source cuts.
 */
export function waitingPlanSteps(nodes: readonly PlanNodeSummary[]): WaitingPlanSteps {
  const asks = selectWaitingNodes(nodes);
  const decisions = selectOpenDecisions(nodes);
  return {
    asks: asks.length,
    decisions: decisions.length,
    newest: newestWaitingItems(
      asks.map((node) => ({
        kind: 'plan_step' as const,
        itemId: `${ACTION_CENTER_ITEM_ID_PREFIX.planAsk}${node.nodeId}`,
        title: waitingItemTitle(
          planItemTitle(node.status !== 'blocked' ? 'merge_wait' : 'blocked', node.title),
        ),
        requestedAt: node.updatedAt,
        planNodeId: node.nodeId,
      })),
      decisions.map((node) => ({
        kind: 'plan_step' as const,
        itemId: `${ACTION_CENTER_ITEM_ID_PREFIX.planDecision}${node.nodeId}`,
        title: waitingItemTitle(planItemTitle('decide', node.title)),
        requestedAt: node.createdAt,
        planNodeId: node.nodeId,
      })),
    ),
  };
}

// ============================================================================
// Run gates and consents, over the tables their sources read
// ============================================================================

/** Padded standard base64, the only text `decode(…, 'base64')` takes without throwing. */
const BASE64_TEXT = '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$';

/**
 * Bytes, as lowercase hex, that `convert_from(…, 'UTF8')` takes without
 * throwing: well-formed UTF-8 with no NUL, no surrogate and nothing past
 * U+10FFFF.
 */
const UTF8_HEX =
  '^(0[1-9a-f]|[1-7][0-9a-f]' +
  '|(c[2-9a-f]|d[0-9a-f])[89ab][0-9a-f]' +
  '|e0[ab][0-9a-f][89ab][0-9a-f]' +
  '|e[1-9a-cef][89ab][0-9a-f][89ab][0-9a-f]' +
  '|ed[89][0-9a-f][89ab][0-9a-f]' +
  '|f0[9ab][0-9a-f]([89ab][0-9a-f]){2}' +
  '|f[1-3]([89ab][0-9a-f]){3}' +
  '|f48[0-9a-f]([89ab][0-9a-f]){2})*$';

/**
 * A paused request's payload, where its ref holds it inline, read by Postgres
 * itself so a count needs no payload fetch. Each step that could throw is
 * tested first, so a ref that is not base64, UTF-8 or `jsonb` reads as none
 * and costs its own row only. An error would abort the transaction, and with
 * it every count.
 */
function inlinePayload(ref: SQL): SQL {
  return sql`(CASE WHEN ${ref} LIKE 'inline:%' AND substr(${ref}, 8) ~ ${BASE64_TEXT} THEN (
    SELECT CASE WHEN pg_input_is_valid(d.t, 'jsonb') AND strpos(d.t, '\\u0000') = 0
                THEN d.t::jsonb END
    FROM (
      SELECT CASE WHEN b.hex ~ ${UTF8_HEX} THEN convert_from(b.bytes, 'UTF8') END AS t
      FROM (
        SELECT decode(substr(${ref}, 8), 'base64') AS bytes,
               encode(decode(substr(${ref}, 8), 'base64'), 'hex') AS hex
      ) b
    ) d
  ) END)`;
}

type Row = Record<string, unknown>;

function asObject(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function total(rows: readonly Row[], kind?: string): number {
  const row = rows.find((r) => kind === undefined || r['kind'] === kind);
  return row !== undefined ? Number(row['total']) : 0;
}

/** The operations the user executor answers with a request for input and for an approval. */
const USER_INPUT_OPERATION_ID = 'user.interaction.ask';
const USER_APPROVAL_OPERATION_ID = 'user.interaction.approve';

/**
 * A request's kind from its own pause, where the ref holds it outside: the
 * paused step's operation for the user executor's two requests, and the pause
 * type the orchestrator stamps for a consent or a write approval. The pause
 * type outlives a resume, which is why the step's operation is read first.
 */
function pauseRequestKind(operationId: SQL, pauseType: SQL): SQL {
  return sql`(CASE
    WHEN ${operationId} = ${USER_INPUT_OPERATION_ID} THEN 'input'
    WHEN ${operationId} = ${USER_APPROVAL_OPERATION_ID} THEN 'approval'
    WHEN ${pauseType} = 'oauth_consent' THEN 'oauth_consent'
    WHEN ${pauseType} = 'approval' THEN 'write_approval'
  END)`;
}

/** A session id from snapshot text, or null where the text is no UUID, so the cast cannot throw. */
function sessionIdOf(text: SQL): SQL {
  return sql`(CASE WHEN ${text} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (${text})::uuid END)`;
}

/** The columns a session's own pause is read by, from its flushed hot state. */
function pauseColumns(session: SQL): SQL {
  return sql`${session}.hot_state_snapshot -> 'runHotState' ->> 'pauseType' AS pause_type,
    ${session}.hot_state_snapshot -> 'stepHotStates'
      -> (${session}.current_step_execution_id::text) ->> 'operationId' AS operation_id,
    ${session}.hot_state_snapshot -> 'runHotState' ->> 'pausedChildSessionId' AS child_id`;
}

/** The deepest delegation `maxDelegationDepth` admits, so a bubbled pause's chain ends. */
const BUBBLED_PAUSE_DEPTH_LIMIT = 10;

/**
 * Paused sessions, as `pausedStepSource` reads them, each by the request its
 * ref holds: input, an approval or a write approval is a run gate, and an
 * OAuth consent is a consent unless a workflow run owns the pause, which
 * `consentRuns` counts instead. A request held inline is read by its own
 * `kind`, so a conversation waiting for its next message is no item. An
 * executor's request is always held outside the ref, so its kind is read from
 * the pause (`pauseRequestKind`). A child's pause bubbled to its parent
 * (`subflow_waiting`) leaves the parent holding the child's ref, and the
 * source lists the parent by that request. Its kind is read from the session
 * that paused for it, down the chain of paused children holding the same ref
 * (Helmsman, then Driver, then Runner). Whether a workflow run owns a consent
 * is read from the listed session itself, as the source reads it. Any other
 * pause is no item.
 */
async function pausedSessions(tx: PostgresJsDatabase, spaceId: string): Promise<Row[]> {
  return (await tx.execute(sql`
    WITH RECURSIVE paused AS (
      SELECT s.current_step_execution_id::text AS step_id,
             s.started_at,
             s.requested_input_ref AS ref,
             s.requested_input_ref LIKE 'inline:%' AS inline,
             ${inlinePayload(sql`s.requested_input_ref`)} AS payload,
             ${pauseColumns(sql`s`)},
             COALESCE(
               jsonb_typeof(s.hot_state_snapshot -> 'runHotState' -> 'workflowExecution') <> 'null',
               false
             ) AS harness_routed
      FROM sessions s
      WHERE s.space_id = ${spaceId}::uuid
        AND s.status = 'PAUSED'
        AND s.requested_input_ref IS NOT NULL
        AND s.current_step_execution_id IS NOT NULL
      ORDER BY s.started_at DESC
      LIMIT ${PAUSED_SESSION_SCAN_LIMIT}
    ), bubbled AS (
      SELECT p.step_id, p.ref, ${pauseColumns(sql`c`)}, 1 AS depth
      FROM paused p
      JOIN sessions c
        ON c.session_id = ${sessionIdOf(sql`p.child_id`)}
       AND c.requested_input_ref = p.ref
      WHERE NOT p.inline
        AND p.pause_type = 'subflow_waiting'
        AND ${pauseRequestKind(sql`p.operation_id`, sql`p.pause_type`)} IS NULL
      UNION ALL
      SELECT b.step_id, b.ref, ${pauseColumns(sql`c`)}, b.depth + 1
      FROM bubbled b
      JOIN sessions c
        ON c.session_id = ${sessionIdOf(sql`b.child_id`)}
       AND c.requested_input_ref = b.ref
      WHERE b.pause_type = 'subflow_waiting'
        AND ${pauseRequestKind(sql`b.operation_id`, sql`b.pause_type`)} IS NULL
        AND b.depth < ${BUBBLED_PAUSE_DEPTH_LIMIT}
    ), origin AS (
      SELECT DISTINCT ON (step_id) step_id,
             ${pauseRequestKind(sql`operation_id`, sql`pause_type`)} AS request_kind
      FROM bubbled
      WHERE ${pauseRequestKind(sql`operation_id`, sql`pause_type`)} IS NOT NULL
      ORDER BY step_id, depth
    ), requested AS (
      SELECT p.*,
             CASE
               WHEN p.inline THEN p.payload ->> 'kind'
               ELSE COALESCE(
                 ${pauseRequestKind(sql`p.operation_id`, sql`p.pause_type`)},
                 o.request_kind
               )
             END AS request_kind
      FROM paused p
      LEFT JOIN origin o ON o.step_id = p.step_id
    ), waiting AS (
      SELECT step_id, started_at, payload, request_kind,
             CASE
               WHEN request_kind IN ('input', 'approval', 'write_approval') THEN 'run_gate'
               WHEN request_kind = 'oauth_consent' AND NOT harness_routed THEN 'consent'
             END AS kind
      FROM requested
    ), ranked AS (
      SELECT *,
             count(*) OVER (PARTITION BY kind)::int AS total,
             row_number() OVER (PARTITION BY kind ORDER BY started_at DESC) AS rank
      FROM waiting
      WHERE kind IS NOT NULL
    )
    SELECT step_id, started_at, payload, request_kind, kind, total
    FROM ranked
    WHERE rank <= ${WAITING_ON_PERSON_LINE_LIMIT}
  `)) as unknown as Row[];
}

/** The workflow sources each list at most this many rows, so the count reads no more. */
const PAUSED_TASK_SCAN_LIMIT = 200;

/**
 * Paused tasks of paused runs, in the windows `workflowHumanTaskSource` and
 * `workflowWriteApprovalSource` select them in. Which of the two lists a row
 * is decided by `classifyPausedTask`, since the human-task rule reads the
 * run's definition.
 */
async function pausedTaskRows(tx: PostgresJsDatabase, spaceId: string): Promise<Row[]> {
  return (await tx.execute(sql`
    WITH paused AS (
      SELECT r.run_id, r.workflow_slug, r.workflow_revision, r.pause_version, r.started_at,
             t.task_id, t.output_ref,
             t.human_task_hydration_ref IS NOT NULL
               AND (t.human_task_hydration_pause_version IS NULL
                    OR t.human_task_hydration_pause_version = r.pause_version)
               AND (t.human_task_hydration_attempt IS NULL
                    OR t.human_task_hydration_attempt = t.attempt) AS stamped,
             COALESCE(
               r.paused_reason = 'task_paused'
                 AND r.paused_payload_ref IS NOT NULL
                 AND t.output_ref = r.paused_payload_ref,
               false
             ) AS holds_pause,
             COALESCE(t.started_at, r.started_at) AS task_started_at,
             COALESCE(t.completed_at, r.started_at) AS task_paused_at
      FROM workflow_runs r
      JOIN workflow_run_tasks t ON t.run_id = r.run_id
      WHERE r.space_id = ${spaceId}::uuid
        AND r.status = 'paused'
        AND t.status = 'paused'
    ), windowed AS (
      SELECT *,
             row_number() OVER (ORDER BY started_at DESC) AS human_rank,
             row_number() OVER (PARTITION BY holds_pause ORDER BY started_at DESC) AS holder_rank
      FROM paused
    )
    SELECT run_id, workflow_slug, workflow_revision, pause_version, task_id,
           task_started_at, task_paused_at, stamped,
           human_rank <= ${PAUSED_TASK_SCAN_LIMIT} AS in_human_window,
           holds_pause AND holder_rank <= ${PAUSED_TASK_SCAN_LIMIT} AS in_approval_window,
           output_ref LIKE 'inline:%' AS inline,
           CASE WHEN holds_pause THEN ${inlinePayload(sql`output_ref`)} END AS payload
    FROM windowed
    WHERE human_rank <= ${PAUSED_TASK_SCAN_LIMIT}
       OR (holds_pause AND holder_rank <= ${PAUSED_TASK_SCAN_LIMIT})
  `)) as unknown as Row[];
}

/** The paused task's definition at the run's revision, each revision read once. */
function taskDefinitionLookup(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): (row: Row) => Promise<WorkflowTask | undefined> {
  const workflows = new Map<string, Promise<Workflow | undefined>>();
  return async (row) => {
    const slug = String(row['workflow_slug']);
    const revision = Number(row['workflow_revision']);
    const key = `${slug}@${String(revision)}`;
    let workflow = workflows.get(key);
    if (workflow === undefined) {
      workflow = resolveWorkflowForRunRevision(
        db,
        tenantId as TenantId,
        spaceId,
        slug,
        revision,
      ).then(
        (resolved) => resolved.workflow,
        () => undefined,
      );
      workflows.set(key, workflow);
    }
    return (await workflow)?.tasks.find((t) => t.taskId === row['task_id']);
  };
}

function taskTypeOf(task: WorkflowTask | undefined): ReturnType<typeof inferTaskType> | undefined {
  if (task === undefined) return undefined;
  try {
    return inferTaskType(task);
  } catch {
    return undefined;
  }
}

type PausedTaskKind = 'human_task' | 'write_approval';

/**
 * Which source lists a paused task, if either does. A human task is listed
 * where its hydration is stamped for the pause it stands at or its definition
 * still resolves to a human task, as `workflowHumanTaskSource` lists it. A
 * write approval is a task holding the run's pause whose request asks for
 * one. Where the ref holds the request inline its kind says so. Otherwise the
 * definition does: only an operation task outside the user executor's two
 * operations pauses with a write approval held outside the ref.
 */
function classifyPausedTask(row: Row, task: WorkflowTask | undefined): PausedTaskKind | undefined {
  const type = taskTypeOf(task);
  if (row['in_human_window'] === true && (row['stamped'] === true || type === 'human')) {
    return 'human_task';
  }
  if (row['in_approval_window'] !== true) return undefined;
  if (row['inline'] === true) {
    const payload = asObject(row['payload']);
    const kind =
      typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>)['kind']
        : undefined;
    return kind === 'write_approval' ? 'write_approval' : undefined;
  }
  const operation = type === 'operation' ? task?.operation : undefined;
  return operation !== undefined &&
    operation !== USER_INPUT_OPERATION_ID &&
    operation !== USER_APPROVAL_OPERATION_ID
    ? 'write_approval'
    : undefined;
}

/**
 * Runs paused for an OAuth consent, as `workflowOAuthConsentSource` reads
 * them: of its newest `PAUSED_TASK_SCAN_LIMIT` such runs, each whose stored
 * resume contract carries the consent it waits on. The source cuts before it
 * drops a run with no consent, so the count does too.
 */
async function consentRuns(tx: PostgresJsDatabase, spaceId: string): Promise<Row[]> {
  return (await tx.execute(sql`
    WITH listed AS (
      SELECT run_id, started_at, paused_payload_ref
      FROM workflow_runs
      WHERE space_id = ${spaceId}::uuid
        AND status = 'paused'
        AND paused_reason = 'needs_oauth_consent'
      ORDER BY started_at DESC
      LIMIT ${PAUSED_TASK_SCAN_LIMIT}
    ), paused AS (
      SELECT run_id, started_at,
             paused_payload_ref LIKE 'inline:%' AS inline,
             ${inlinePayload(sql`paused_payload_ref`)} AS payload
      FROM listed
      WHERE paused_payload_ref IS NOT NULL
    ), ranked AS (
      SELECT *,
             count(*) OVER ()::int AS total,
             row_number() OVER (ORDER BY started_at DESC) AS rank
      FROM paused
      WHERE NOT inline OR jsonb_typeof(payload -> 'oauthConsent') = 'object'
    )
    SELECT run_id, started_at, payload -> 'oauthConsent' AS consent, total
    FROM ranked
    WHERE rank <= ${WAITING_ON_PERSON_LINE_LIMIT}
  `)) as unknown as Row[];
}

/** Pending compute-egress requests, tenant-wide or this space's, as `computeEgressSource` reads them. */
async function egressRequests(
  tx: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<Row[]> {
  return (await tx.execute(sql`
    SELECT request_id::text AS request_id, requested_at, scope,
           cardinality(requested_hosts) AS hosts,
           count(*) OVER ()::int AS total
    FROM public.egress_approval_requests
    WHERE tenant_id = ${tenantId}::uuid
      AND status = 'pending_approval'
      AND (scope = 'tenant' OR (scope = 'space' AND space_id = ${spaceId}::uuid))
    ORDER BY requested_at DESC
    LIMIT ${WAITING_ON_PERSON_LINE_LIMIT}
  `)) as unknown as Row[];
}

function sessionItems(rows: readonly Row[]): WaitingItem[] {
  return rows.map((row) => {
    const payload = asObject(row['payload']);
    const requestedAt =
      typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>)['requestedAt']
        : undefined;
    return {
      kind: row['kind'] === 'consent' ? ('consent' as const) : ('run_gate' as const),
      itemId: `${ACTION_CENTER_ITEM_ID_PREFIX.pausedStep}${String(row['step_id'])}`,
      title: waitingItemTitle(pausedRequestTitle(payload) ?? requestKindTitle(row['request_kind'])),
      requestedAt: isoOf(requestedAt, row['started_at']),
    };
  });
}

/** The title of a request held outside its ref, from its kind alone. */
function requestKindTitle(kind: unknown): string {
  switch (kind) {
    case 'input':
      return humanRequestTitle('input', undefined);
    case 'oauth_consent':
      return oauthConsentTitle({});
    default:
      return humanRequestTitle('approval', undefined);
  }
}

interface ClassifiedTask {
  row: Row;
  task: WorkflowTask | undefined;
  kind: PausedTaskKind;
}

function taskItems(tasks: readonly ClassifiedTask[]): WaitingItem[] {
  return tasks.map(({ row, task, kind }) =>
    kind === 'human_task'
      ? {
          kind: 'run_gate' as const,
          itemId: `${ACTION_CENTER_ITEM_ID_PREFIX.workflowHumanTask}${String(row['run_id'])}:${String(row['task_id'])}`,
          title: waitingItemTitle(task?.name ?? String(row['task_id'])),
          requestedAt: isoOf(row['task_started_at']),
        }
      : {
          kind: 'run_gate' as const,
          itemId: `${ACTION_CENTER_ITEM_ID_PREFIX.workflowWriteApproval}${String(row['run_id'])}:${String(row['pause_version'])}`,
          title: waitingItemTitle(
            pausedRequestTitle(asObject(row['payload'])) ??
              humanRequestTitle('approval', undefined),
          ),
          requestedAt: isoOf(row['task_paused_at']),
        },
  );
}

function consentItems(rows: readonly Row[]): WaitingItem[] {
  return rows.map((row) => {
    const consent = asObject(row['consent']);
    const fields =
      typeof consent === 'object' && consent !== null ? (consent as Record<string, unknown>) : {};
    return {
      kind: 'consent' as const,
      itemId: `${ACTION_CENTER_ITEM_ID_PREFIX.workflowOAuthConsent}${String(row['run_id'])}`,
      title: waitingItemTitle(
        oauthConsentTitle({
          ...(typeof fields['resourceKey'] === 'string'
            ? { resourceKey: fields['resourceKey'] }
            : {}),
          ...(typeof fields['bindingId'] === 'string' ? { bindingId: fields['bindingId'] } : {}),
        }),
      ),
      requestedAt: isoOf(row['started_at']),
    };
  });
}

function egressItems(rows: readonly Row[]): WaitingItem[] {
  return rows.map((row) => ({
    kind: 'run_gate' as const,
    itemId: `${ACTION_CENTER_ITEM_ID_PREFIX.computeEgress}${String(row['request_id'])}`,
    title: waitingItemTitle(
      computeEgressTitle(row['scope'] === 'tenant' ? 'tenant' : 'space', Number(row['hosts'])),
    ),
    requestedAt: isoOf(row['requested_at']),
  }));
}

/**
 * The run gates and consents that wait in the space, and the space's slug.
 * One transaction reads every table, and no payload is fetched. A request's
 * kind comes from the payload its ref holds inline, or else from the pause,
 * and a paused task's from its run's definition as well.
 */
export async function readWaitingGates(params: {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
}): Promise<{ gates: WaitingGates; spaceSlug?: string }> {
  const { db, tenantId, spaceId } = params;
  const read = await withTenantSchema(
    db,
    createTenantContext(tenantId as TenantId),
    async (tx) => ({
      sessions: await pausedSessions(tx, spaceId),
      tasks: await pausedTaskRows(tx, spaceId),
      consents: await consentRuns(tx, spaceId),
      egress: await egressRequests(tx, tenantId, spaceId),
      slug: (await tx.execute(
        sql`SELECT slug FROM spaces WHERE id = ${spaceId}::uuid LIMIT 1`,
      )) as unknown as Row[],
    }),
  );

  const definitionOf = taskDefinitionLookup(db, tenantId, spaceId);
  const tasks: ClassifiedTask[] = [];
  for (const row of read.tasks) {
    const task = await definitionOf(row);
    const kind = classifyPausedTask(row, task);
    if (kind !== undefined) tasks.push({ row, task, kind });
  }

  const slug = read.slug[0]?.['slug'];
  return {
    gates: {
      runGates: total(read.sessions, 'run_gate') + tasks.length + total(read.egress),
      consents: total(read.sessions, 'consent') + total(read.consents),
      newest: newestWaitingItems(
        sessionItems(read.sessions),
        taskItems(tasks),
        consentItems(read.consents),
        egressItems(read.egress),
      ),
    },
    ...(typeof slug === 'string' ? { spaceSlug: slug } : {}),
  };
}

// ============================================================================
// The section
// ============================================================================

/** The section's data from the walk's plan steps and the gate read. A read that failed is left out. */
export function waitingOnPersonFrom(
  plan: WaitingPlanSteps | undefined,
  outside: { gates: WaitingGates; spaceSlug?: string } | undefined,
): WaitingOnPerson {
  return {
    ...(plan !== undefined ? { planSteps: { asks: plan.asks, decisions: plan.decisions } } : {}),
    ...(outside !== undefined
      ? { gates: { runGates: outside.gates.runGates, consents: outside.gates.consents } }
      : {}),
    items: newestWaitingItems(plan?.newest ?? [], outside?.gates.newest ?? []),
    ...(outside?.spaceSlug !== undefined ? { spaceSlug: outside.spaceSlug } : {}),
  };
}

const KIND_LABEL: Record<WaitingItemKind, string> = {
  plan_step: 'plan step',
  run_gate: 'run gate',
  consent: 'consent',
};

function counted(label: string, count: number, mayBeCut = false): string {
  const shown = mayBeCut ? `${String(count)}+` : String(count);
  return `${shown} ${label}${count === 1 && !mayBeCut ? '' : 's'}`;
}

function renderWaitingLine(item: WaitingItem, spaceSlug: string | undefined): string {
  const link =
    item.planNodeId !== undefined && spaceSlug !== undefined
      ? ` /s/${spaceSlug}/plan?node=${item.planNodeId}`
      : '';
  return `- ${KIND_LABEL[item.kind]} "${item.title}" [itemId: ${item.itemId}]${link}`;
}

/**
 * The section as the block renders it: one heading with a count per kind, and
 * under it the newest items, one line each. A count that could not be read is
 * named as unread rather than shown as zero.
 */
export function renderWaitingOnPerson(waiting: WaitingOnPerson): string[] {
  const counts: string[] = [];
  if (waiting.planSteps !== undefined) {
    const steps = pendingPlanStepCount(waiting.planSteps);
    counts.push(counted('plan step', steps.count, steps.mayBeCut));
  }
  if (waiting.gates !== undefined) {
    counts.push(counted('run gate', waiting.gates.runGates));
    counts.push(counted('consent', waiting.gates.consents));
  }
  const heading = [
    counts.length > 0 ? `Waiting on a person: ${counts.join(', ')}.` : 'Waiting on a person:',
    ...(waiting.planSteps === undefined ? ['The plan steps could not be read.'] : []),
    ...(waiting.gates === undefined ? ['The run gates and consents could not be read.'] : []),
    ...(waiting.items.length > 0
      ? ['Point with the plan link or `human.action_center.focus`:']
      : []),
  ].join(' ');
  return [
    heading,
    ...waiting.items
      .slice(0, WAITING_ON_PERSON_LINE_LIMIT)
      .map((item) => renderWaitingLine(item, waiting.spaceSlug)),
  ];
}
