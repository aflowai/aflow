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
  oauthConsentTitle,
  pausedRequestTitle,
  pendingPlanStepCount,
  planItemTitle,
  type PlanNodeSummary,
  type TenantId,
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

/**
 * A paused request's payload, where its ref holds it inline, read by Postgres
 * itself so a count needs no payload fetch. A payload Postgres cannot hold as
 * `jsonb` — one carrying an escaped NUL — reads as none.
 */
function inlinePayload(ref: SQL): SQL {
  return sql`(CASE WHEN ${ref} LIKE 'inline:%' THEN (
    SELECT CASE WHEN strpos(d.t, '\\u0000') = 0 THEN d.t::jsonb END
    FROM (SELECT convert_from(decode(substr(${ref}, 8), 'base64'), 'UTF8') AS t) d
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

/**
 * Paused sessions, as `pausedStepSource` reads them. The payload's kind says
 * what the pause asks: input, an approval or a write approval is a run gate,
 * and an OAuth consent is a consent unless a workflow run owns the pause,
 * which its run-plane source shows instead. A payload with no such kind, such
 * as a conversation waiting for its next message, is no item. A payload held
 * outside the ref is read as a gate, since only an executor's large request
 * is stored that way.
 */
async function pausedSessions(tx: PostgresJsDatabase, spaceId: string): Promise<Row[]> {
  return (await tx.execute(sql`
    WITH paused AS (
      SELECT s.current_step_execution_id::text AS step_id,
             s.started_at,
             s.requested_input_ref LIKE 'inline:%' AS inline,
             ${inlinePayload(sql`s.requested_input_ref`)} AS payload,
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
    ), waiting AS (
      SELECT step_id, started_at, payload,
             CASE
               WHEN NOT inline THEN 'run_gate'
               WHEN payload ->> 'kind' IN ('input', 'approval', 'write_approval') THEN 'run_gate'
               WHEN payload ->> 'kind' = 'oauth_consent' AND NOT harness_routed THEN 'consent'
             END AS kind
      FROM paused
    ), ranked AS (
      SELECT *,
             count(*) OVER (PARTITION BY kind)::int AS total,
             row_number() OVER (PARTITION BY kind ORDER BY started_at DESC) AS rank
      FROM waiting
      WHERE kind IS NOT NULL
    )
    SELECT step_id, started_at, payload, kind, total
    FROM ranked
    WHERE rank <= ${WAITING_ON_PERSON_LINE_LIMIT}
  `)) as unknown as Row[];
}

/**
 * Paused workflow tasks, as `workflowHumanTaskSource` and
 * `workflowWriteApprovalSource` read them: a human task stamped with its
 * hydration for the pause it stands at, and an operation task whose payload
 * the run's pause holds and asks for a write approval.
 */
async function pausedTasks(tx: PostgresJsDatabase, spaceId: string): Promise<Row[]> {
  return (await tx.execute(sql`
    WITH paused AS (
      SELECT r.run_id, r.workflow_slug, r.workflow_revision, r.pause_version,
             t.task_id, t.output_ref,
             CASE
               WHEN t.human_task_hydration_ref IS NOT NULL
                 AND t.human_task_hydration_pause_version = r.pause_version
                 AND t.human_task_hydration_attempt = t.attempt THEN 'human_task'
               WHEN r.paused_reason = 'task_paused'
                 AND r.paused_payload_ref IS NOT NULL
                 AND t.output_ref = r.paused_payload_ref THEN 'write_approval'
             END AS source,
             CASE
               WHEN t.human_task_hydration_ref IS NOT NULL THEN COALESCE(t.started_at, r.started_at)
               ELSE COALESCE(t.completed_at, r.started_at)
             END AS requested_at
      FROM workflow_runs r
      JOIN workflow_run_tasks t ON t.run_id = r.run_id
      WHERE r.space_id = ${spaceId}::uuid
        AND r.status = 'paused'
        AND t.status = 'paused'
    ), waiting AS (
      SELECT *,
             CASE WHEN source = 'write_approval' THEN ${inlinePayload(sql`output_ref`)} END AS payload
      FROM paused
      WHERE source IS NOT NULL
    ), ranked AS (
      SELECT *,
             count(*) OVER (PARTITION BY source)::int AS total,
             row_number() OVER (PARTITION BY source ORDER BY requested_at DESC) AS rank
      FROM waiting
      WHERE source = 'human_task'
         OR output_ref NOT LIKE 'inline:%'
         OR payload ->> 'kind' = 'write_approval'
    )
    SELECT run_id, workflow_slug, workflow_revision, pause_version, task_id, requested_at,
           payload, source AS kind, total
    FROM ranked
    WHERE rank <= ${WAITING_ON_PERSON_LINE_LIMIT}
  `)) as unknown as Row[];
}

/**
 * Runs paused for an OAuth consent, as `workflowOAuthConsentSource` reads
 * them: a run whose stored resume contract carries the consent it waits on.
 */
async function consentRuns(tx: PostgresJsDatabase, spaceId: string): Promise<Row[]> {
  return (await tx.execute(sql`
    WITH paused AS (
      SELECT run_id, started_at,
             paused_payload_ref LIKE 'inline:%' AS inline,
             ${inlinePayload(sql`paused_payload_ref`)} AS payload
      FROM workflow_runs
      WHERE space_id = ${spaceId}::uuid
        AND status = 'paused'
        AND paused_reason = 'needs_oauth_consent'
        AND paused_payload_ref IS NOT NULL
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
      title: waitingItemTitle(
        pausedRequestTitle(payload) ?? humanRequestTitle('approval', undefined),
      ),
      requestedAt: isoOf(requestedAt, row['started_at']),
    };
  });
}

function taskItems(rows: readonly Row[]): WaitingItem[] {
  return rows.map((row) =>
    row['kind'] === 'human_task'
      ? {
          kind: 'run_gate' as const,
          itemId: `${ACTION_CENTER_ITEM_ID_PREFIX.workflowHumanTask}${String(row['run_id'])}:${String(row['task_id'])}`,
          // The task's name, where its definition is read, replaces this below.
          title: waitingItemTitle(String(row['task_id'])),
          requestedAt: isoOf(row['requested_at']),
        }
      : {
          kind: 'run_gate' as const,
          itemId: `${ACTION_CENTER_ITEM_ID_PREFIX.workflowWriteApproval}${String(row['run_id'])}:${String(row['pause_version'])}`,
          title: waitingItemTitle(
            pausedRequestTitle(asObject(row['payload'])) ??
              humanRequestTitle('approval', undefined),
          ),
          requestedAt: isoOf(row['requested_at']),
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

/** A human task's line carries the task's name, as its item does, where the run's definition is read. */
async function nameHumanTasks(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  shown: readonly WaitingItem[],
  rows: readonly Row[],
): Promise<WaitingItem[]> {
  return Promise.all(
    shown.map(async (item) => {
      const row = rows.find(
        (r) =>
          r['kind'] === 'human_task' &&
          item.itemId ===
            `${ACTION_CENTER_ITEM_ID_PREFIX.workflowHumanTask}${String(r['run_id'])}:${String(r['task_id'])}`,
      );
      if (row === undefined) return item;
      try {
        const { workflow } = await resolveWorkflowForRunRevision(
          db,
          tenantId as TenantId,
          spaceId,
          String(row['workflow_slug']),
          Number(row['workflow_revision']),
        );
        const name = workflow.tasks.find((t) => t.taskId === row['task_id'])?.name;
        return name !== undefined ? { ...item, title: waitingItemTitle(name) } : item;
      } catch {
        return item;
      }
    }),
  );
}

/**
 * The run gates and consents that wait in the space, and the space's slug.
 * One transaction reads every table, and no payload is fetched: a request's
 * kind and title come from the payload its ref holds inline.
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
      tasks: await pausedTasks(tx, spaceId),
      consents: await consentRuns(tx, spaceId),
      egress: await egressRequests(tx, tenantId, spaceId),
      slug: (await tx.execute(
        sql`SELECT slug FROM spaces WHERE id = ${spaceId}::uuid LIMIT 1`,
      )) as unknown as Row[],
    }),
  );

  const newest = newestWaitingItems(
    sessionItems(read.sessions),
    taskItems(read.tasks),
    consentItems(read.consents),
    egressItems(read.egress),
  );
  const slug = read.slug[0]?.['slug'];
  return {
    gates: {
      runGates:
        total(read.sessions, 'run_gate') +
        total(read.tasks, 'human_task') +
        total(read.tasks, 'write_approval') +
        total(read.egress),
      consents: total(read.sessions, 'consent') + total(read.consents),
      newest: await nameHumanTasks(db, tenantId, spaceId, newest, read.tasks),
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
