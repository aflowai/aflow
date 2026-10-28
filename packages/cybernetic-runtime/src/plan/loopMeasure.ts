/**
 * What the loop costs the operator (Plan 331 D7), read from records the
 * platform already writes: the operator's actions per merged pull request,
 * the idle time between a node becoming actionable and its first commission,
 * and the cost of each node's runs with the resident's wakes beside it. One
 * read for a window, beside `readPlanOverview`; nothing is stored.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { createTenantContext, withTenantSchema } from '@aflow/database';
import {
  PLAN_LOOP_MEASURE_DEFAULT_DAYS,
  PLAN_LOOP_MEASURE_MAX_DAYS,
  PLAN_LOOP_MEASURE_NODES_LIMIT,
  PLAN_STREAM_COMMISSION_SLUG,
  PLAN_STREAM_SCHEDULE_TARGET,
  PLAN_RESIDENT_SCHEDULE_VARIABLE,
  isPlanResidentSchedule,
  type PlanLoopMeasureOutput,
  type PlanLoopMeasureQuery,
  type TenantId,
} from '@aflow/schemas';

const DAY_MS = 24 * 60 * 60_000;

/** How many of the space's nodes the idle reckoning reads to find each node's predecessor. */
const PLAN_LOOP_NODES_READ_LIMIT = 5_000;

export interface PlanLoopWindow {
  from: Date;
  to: Date;
}

/** The window a query names, a week to now by default, never longer than the ceiling. */
export function planLoopWindow(
  query: PlanLoopMeasureQuery,
  now: Date = new Date(),
): PlanLoopWindow {
  const to = query.to !== undefined ? new Date(query.to) : now;
  const earliest = new Date(to.getTime() - PLAN_LOOP_MEASURE_MAX_DAYS * DAY_MS);
  const from =
    query.from !== undefined
      ? new Date(query.from)
      : new Date(to.getTime() - PLAN_LOOP_MEASURE_DEFAULT_DAYS * DAY_MS);
  return { from: from < earliest ? earliest : from, to };
}

export interface PlanLoopNodeFact {
  nodeId: string;
  parentId: string | null;
  title: string;
  position: number;
  createdAt: Date;
  closedAt: Date | null;
}

/** The records the three numbers are computed from. */
export interface PlanLoopFacts {
  helmsmanMessages: number;
  actionCenterByKind: Record<string, number>;
  planCloses: number;
  planOpens: number;
  scheduleWrites: number;
  mergedPullRequests: number;
  nodes: PlanLoopNodeFact[];
  /** When a person opened each node — approved, resumed or reopened it. */
  opens: Array<{ nodeId: string; at: Date }>;
  /** Each node's first commission, for nodes whose first commission started in the window. */
  firstCommissions: Array<{ nodeId: string; at: Date }>;
  /** The runs serving each node that started in the window. */
  nodeRuns: Array<{ nodeId: string; runs: number; cents: number }>;
  wakes: { sessions: number; cents: number };
}

function perMerged(value: number, merged: number): number | null {
  return merged > 0 ? value / merged : null;
}

/**
 * When a node became actionable: created, a person opened it, or the sibling
 * before it closed — the latest of those before its first commission.
 */
function actionableAt(
  node: PlanLoopNodeFact,
  firstCommission: Date,
  facts: PlanLoopFacts,
  siblingsOf: Map<string | null, PlanLoopNodeFact[]>,
): Date {
  let at = node.createdAt;
  const later = (candidate: Date | null | undefined) => {
    if (candidate && candidate > at && candidate <= firstCommission) at = candidate;
  };
  for (const open of facts.opens) if (open.nodeId === node.nodeId) later(open.at);
  const siblings = siblingsOf.get(node.parentId) ?? [];
  const index = siblings.findIndex((sibling) => sibling.nodeId === node.nodeId);
  if (index > 0) later(siblings[index - 1]!.closedAt);
  return at;
}

export function measurePlanLoop(
  facts: PlanLoopFacts,
  window: PlanLoopWindow,
): PlanLoopMeasureOutput {
  const actionCenterTotal = Object.values(facts.actionCenterByKind).reduce((a, b) => a + b, 0);
  const total =
    facts.helmsmanMessages +
    actionCenterTotal +
    facts.planCloses +
    facts.planOpens +
    facts.scheduleWrites;
  const merged = facts.mergedPullRequests;

  const byId = new Map(facts.nodes.map((node) => [node.nodeId, node]));
  const siblingsOf = new Map<string | null, PlanLoopNodeFact[]>();
  for (const node of facts.nodes) {
    const siblings = siblingsOf.get(node.parentId) ?? [];
    siblings.push(node);
    siblingsOf.set(node.parentId, siblings);
  }
  for (const siblings of siblingsOf.values()) {
    siblings.sort((a, b) => a.position - b.position || a.nodeId.localeCompare(b.nodeId));
  }

  const idle = facts.firstCommissions
    .flatMap(({ nodeId, at }) => {
      const node = byId.get(nodeId);
      if (!node) return [];
      const actionable = actionableAt(node, at, facts, siblingsOf);
      return [
        {
          nodeId,
          title: node.title,
          actionableAt: actionable.toISOString(),
          firstCommissionAt: at.toISOString(),
          idleMs: Math.max(0, at.getTime() - actionable.getTime()),
        },
      ];
    })
    .sort((a, b) => b.firstCommissionAt.localeCompare(a.firstCommissionAt))
    .slice(0, PLAN_LOOP_MEASURE_NODES_LIMIT);

  const nodes = facts.nodeRuns
    .map((run) => ({
      nodeId: run.nodeId,
      title: byId.get(run.nodeId)?.title ?? run.nodeId,
      runs: run.runs,
      cents: run.cents,
    }))
    .sort((a, b) => b.cents - a.cents)
    .slice(0, PLAN_LOOP_MEASURE_NODES_LIMIT);

  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    operatorActions: {
      total,
      helmsmanMessages: facts.helmsmanMessages,
      actionCenter: { total: actionCenterTotal, byKind: facts.actionCenterByKind },
      planWrites: { close: facts.planCloses, open: facts.planOpens },
      scheduleWrites: facts.scheduleWrites,
    },
    mergedPullRequests: merged,
    actionsPerMergedPullRequest: perMerged(total, merged),
    idle,
    cost: {
      nodes,
      wakes: {
        sessions: facts.wakes.sessions,
        cents: facts.wakes.cents,
        centsPerMergedPullRequest: perMerged(facts.wakes.cents, merged),
      },
    },
  };
}

/** The audit actions that are a person's writes to the plan or a schedule. */
export const PLAN_LOOP_AUDITED_ACTIONS = [
  'plan.node.close',
  'plan.node.open',
  'schedule.create',
  'schedule.update',
  'schedule.delete',
] as const;

async function rows<T>(tx: PostgresJsDatabase, query: SQL): Promise<T[]> {
  return (await tx.execute(query)) as unknown as T[];
}

/** Read the facts for a window from the space's records. */
export async function readPlanLoopFacts(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  window: PlanLoopWindow,
): Promise<PlanLoopFacts> {
  const { from, to } = window;
  const helmsman = PLAN_STREAM_SCHEDULE_TARGET.systemRole;
  return withTenantSchema(db, createTenantContext(tenantId as TenantId), async (tx) => {
    const [messages] = await rows<{ n: number }>(
      tx,
      sql`SELECT count(*)::int AS n FROM event_log e JOIN sessions s ON s.session_id = e.session_id
           WHERE s.space_id = ${spaceId}::uuid AND s.target_system_role = ${helmsman}
             AND (e.event_type = 'SessionResumed' OR (e.event_type = 'SessionStarted'
               AND s.execution_authority ->> 'establishedReason' IS DISTINCT FROM 'schedule'))
             AND e.envelope -> 'metadata' ->> 'userMessage' IS NOT NULL
             AND e.envelope -> 'metadata' ->> 'actorUserId' IS NOT NULL
             AND e.timestamp >= ${from} AND e.timestamp < ${to}`,
    );
    const resolutions = await rows<{ kind: string; n: number }>(
      tx,
      sql`SELECT kind, count(*)::int AS n FROM hitl_action_audit
           WHERE space_id = ${spaceId}::uuid AND created_at >= ${from} AND created_at < ${to}
           GROUP BY kind`,
    );
    const audited = await rows<{ action: string; n: number }>(
      tx,
      sql`SELECT action, count(*)::int AS n FROM public.platform_audit_log
           WHERE tenant_id = ${tenantId}::uuid AND target ->> 'spaceId' = ${spaceId}
             AND actor_type = 'human' AND outcome = 'success'
             AND action IN (${sql.join(
               PLAN_LOOP_AUDITED_ACTIONS.map((action) => sql`${action}`),
               sql`, `,
             )})
             AND timestamp >= ${from} AND timestamp < ${to}
           GROUP BY action`,
    );
    const [mergedRow] = await rows<{ n: number }>(
      tx,
      sql`SELECT count(*)::int AS n FROM plan_node_links
           WHERE space_id = ${spaceId}::uuid AND kind = 'merge'
             AND created_at >= ${from} AND created_at < ${to}`,
    );
    const nodes = await rows<{
      id: string;
      parent_id: string | null;
      title: string;
      position: number;
      created_at: string | Date;
      closed_at: string | Date | null;
    }>(
      tx,
      sql`SELECT id, parent_id, title, position, created_at, closed_at FROM plan_nodes
           WHERE space_id = ${spaceId}::uuid ORDER BY created_at DESC LIMIT ${PLAN_LOOP_NODES_READ_LIMIT}`,
    );
    const opens = await rows<{ node_id: string; at: string | Date }>(
      tx,
      sql`SELECT resource_id AS node_id, timestamp AS at FROM public.platform_audit_log
           WHERE tenant_id = ${tenantId}::uuid AND target ->> 'spaceId' = ${spaceId}
             AND action = 'plan.node.open' AND outcome = 'success' AND timestamp < ${to}`,
    );
    const firsts = await rows<{ node_id: string; at: string | Date }>(
      tx,
      sql`SELECT plan_node_id AS node_id, min(started_at) AS at FROM workflow_runs
           WHERE space_id = ${spaceId}::uuid AND workflow_slug = ${PLAN_STREAM_COMMISSION_SLUG}
             AND plan_node_id IS NOT NULL AND eval_batch_id IS NULL
           GROUP BY plan_node_id
           HAVING min(started_at) >= ${from} AND min(started_at) < ${to}`,
    );
    const nodeRuns = await rows<{ node_id: string; runs: number; cents: number }>(
      tx,
      sql`SELECT plan_node_id AS node_id, count(*)::int AS runs,
                 coalesce(sum(total_cost_cents), 0)::int AS cents
            FROM workflow_runs
           WHERE space_id = ${spaceId}::uuid AND plan_node_id IS NOT NULL AND eval_batch_id IS NULL
             AND started_at >= ${from} AND started_at < ${to}
           GROUP BY plan_node_id`,
    );
    const schedules = await rows<{
      id: string;
      targetKind: string | null;
      targetSystemRole: string | null;
      inputTemplate: unknown;
    }>(
      tx,
      sql`SELECT id, target_kind AS "targetKind", target_system_role AS "targetSystemRole",
                 input_template AS "inputTemplate" FROM agent_schedules
           WHERE space_id = ${spaceId}::uuid`,
    );
    const residentIds = new Set(schedules.filter(isPlanResidentSchedule).map((s) => s.id));
    const wakeRows = await rows<{ cents: string; inputRef: string | null }>(
      tx,
      sql`SELECT coalesce(s.total_cost_cents, 0)::text AS cents,
                 e.envelope -> 'metadata' ->> 'inputRef' AS "inputRef"
            FROM sessions s JOIN event_log e ON e.session_id = s.session_id
           WHERE s.space_id = ${spaceId}::uuid AND s.target_system_role = ${helmsman}
             AND s.execution_authority ->> 'establishedReason' = 'schedule'
             AND e.event_type = 'SessionStarted'
             AND s.started_at >= ${from} AND s.started_at < ${to}`,
    );
    const wakes = { sessions: 0, cents: 0 };
    const inputSchema = z.object({
      config: z.object({ [PLAN_RESIDENT_SCHEDULE_VARIABLE]: z.string().uuid() }),
    });
    for (const row of wakeRows) {
      if (!row.inputRef?.startsWith('inline:')) continue;
      let input: unknown;
      try {
        input = JSON.parse(Buffer.from(row.inputRef.slice(7), 'base64').toString('utf8'));
      } catch {
        continue;
      }
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success || !residentIds.has(parsed.data.config[PLAN_RESIDENT_SCHEDULE_VARIABLE]))
        continue;
      wakes.sessions += 1;
      wakes.cents += Number(row.cents);
    }

    const count = (action: string) => audited.find((row) => row.action === action)?.n ?? 0;
    return {
      helmsmanMessages: messages?.n ?? 0,
      actionCenterByKind: Object.fromEntries(resolutions.map((row) => [row.kind, row.n])),
      planCloses: count('plan.node.close'),
      planOpens: count('plan.node.open'),
      scheduleWrites:
        count('schedule.create') + count('schedule.update') + count('schedule.delete'),
      mergedPullRequests: mergedRow?.n ?? 0,
      nodes: nodes.map((row) => ({
        nodeId: row.id,
        parentId: row.parent_id,
        title: row.title,
        position: row.position,
        createdAt: new Date(row.created_at),
        closedAt: row.closed_at === null ? null : new Date(row.closed_at),
      })),
      opens: opens.map((row) => ({ nodeId: row.node_id, at: new Date(row.at) })),
      firstCommissions: firsts.map((row) => ({ nodeId: row.node_id, at: new Date(row.at) })),
      nodeRuns: nodeRuns.map((row) => ({ nodeId: row.node_id, runs: row.runs, cents: row.cents })),
      wakes,
    };
  });
}

/** The D7 read for a window: the facts, and the three numbers computed from them. */
export async function readPlanLoopMeasure(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  query: PlanLoopMeasureQuery,
): Promise<PlanLoopMeasureOutput> {
  const window = planLoopWindow(query);
  return measurePlanLoop(await readPlanLoopFacts(db, tenantId, spaceId, window), window);
}
