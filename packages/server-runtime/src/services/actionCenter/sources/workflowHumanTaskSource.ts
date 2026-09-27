import { and, desc, eq } from 'drizzle-orm';
import {
  createTenantContext,
  resolveWorkflowForRunRevision,
  withTenantSchema,
  workflowRunTasks,
  workflowRuns,
  type WorkflowRunRow,
  type WorkflowRunTaskRow,
} from '@aflow/database';
import {
  type ActionCenterItemKind,
  type ActionCenterItemOrigin,
  type WorkflowTask,
  inferTaskType,
} from '@aflow/schemas';
import {
  buildHumanTaskHydrationFields,
  loadWorkflowHumanTaskHydration,
} from '@aflow/cybernetic-runtime';
import type { DurableWorkflowHumanTaskHydration } from '@aflow/schemas';
import {
  type ActionCenterContext,
  type ActionCenterResolveOutcome,
  type ActionCenterScope,
  type ActionCenterSource,
  type ActionCenterSourceItem,
  type ActionCenterSourceDeps,
  ActionCenterResolveError,
} from '../types.js';

const ITEM_ID_PREFIX = 'workflow-task:';
const LIST_LIMIT = 200;

interface PausedHumanTaskRow {
  run: WorkflowRunRow;
  task: WorkflowRunTaskRow;
  taskDef: WorkflowTask | null;
  durableHydration: DurableWorkflowHumanTaskHydration | null;
}

export function createWorkflowHumanTaskSource(deps: ActionCenterSourceDeps): ActionCenterSource {
  return {
    name: 'workflowHumanTask',
    rowScope: 'space',
    handlesOriginTypes: ['workflow_task'],

    async listOpen(scope: ActionCenterScope): Promise<ActionCenterSourceItem[]> {
      const rows = await listPausedHumanTasks(deps, scope, LIST_LIMIT);
      const items: ActionCenterSourceItem[] = [];
      for (const row of rows) {
        items.push(buildItem(scope, row));
      }
      return items;
    },

    async getById(ctx, itemId): Promise<ActionCenterSourceItem | null> {
      const parsed = parseItemId(itemId);
      if (!parsed) return null;
      const row = await loadPausedHumanTask(deps, ctx, parsed.runId, parsed.taskId);
      if (!row) return null;
      return buildItem(ctx, row);
    },

    // eslint-disable-next-line @typescript-eslint/require-await -- async signature required by the source contract; we always reject.
    async resolve(
      _ctx: ActionCenterContext,
      _item: ActionCenterSourceItem,
      _resolution,
    ): Promise<ActionCenterResolveOutcome> {
      throw new ActionCenterResolveError(
        'INVALID_RESOLUTION',
        'Workflow human tasks are resolved from the run surface in the chat. Open the run to approve or reject.',
        'permanent',
      );
    },
  };
}

function parseItemId(itemId: string): { runId: string; taskId: string } | null {
  if (!itemId.startsWith(ITEM_ID_PREFIX)) return null;
  const rest = itemId.slice(ITEM_ID_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  return { runId: rest.slice(0, sep), taskId: rest.slice(sep + 1) };
}

async function listPausedHumanTasks(
  deps: ActionCenterSourceDeps,
  scope: ActionCenterScope,
  limit: number,
): Promise<PausedHumanTaskRow[]> {
  const tenantCtx = createTenantContext(scope.tenantId);
  const joined = await withTenantSchema(deps.db, tenantCtx, async (tx) =>
    tx
      .select({
        run: workflowRuns,
        task: workflowRunTasks,
      })
      .from(workflowRuns)
      .innerJoin(workflowRunTasks, eq(workflowRunTasks.runId, workflowRuns.runId))
      .where(
        and(
          eq(workflowRuns.spaceId, scope.spaceId),
          eq(workflowRuns.status, 'paused'),
          eq(workflowRunTasks.status, 'paused'),
        ),
      )
      .orderBy(desc(workflowRuns.startedAt))
      .limit(limit),
  );

  const out: PausedHumanTaskRow[] = [];
  for (const { run, task } of joined) {
    const durableHydration = await loadDurableHydration(
      deps,
      scope,
      run.runId,
      task.taskId,
      run.pauseVersion,
      task.attempt,
    );
    const taskDef = await loadHumanTaskDef(deps, scope, run, task.taskId);
    // Surface the row when EITHER the definition is still resolvable
    // OR the harness stamped a durable hydration. Drop only when both
    // sources are absent (operation-typed pauses, pre-Plan-170 pauses
    // with no backfill, definition unresolvable AND no ref).
    if (!taskDef && !durableHydration) continue;
    out.push({ run, task, taskDef, durableHydration });
  }
  return out;
}

async function loadDurableHydration(
  deps: ActionCenterSourceDeps,
  scope: ActionCenterScope,
  runId: string,
  taskId: string,
  expectedPauseVersion: number,
  expectedAttempt: number,
): Promise<DurableWorkflowHumanTaskHydration | null> {
  const result = await loadWorkflowHumanTaskHydration(
    { db: deps.db, payloadStore: deps.payloadStore },
    scope.tenantId,
    { runId, taskId, expectedPauseVersion, expectedAttempt },
  );
  return result.kind === 'hydrated' ? result.hydration : null;
}

async function loadPausedHumanTask(
  deps: ActionCenterSourceDeps,
  scope: ActionCenterScope,
  runId: string,
  taskId: string,
): Promise<PausedHumanTaskRow | null> {
  const tenantCtx = createTenantContext(scope.tenantId);
  const rows = await withTenantSchema(deps.db, tenantCtx, async (tx) =>
    tx
      .select({
        run: workflowRuns,
        task: workflowRunTasks,
      })
      .from(workflowRuns)
      .innerJoin(workflowRunTasks, eq(workflowRunTasks.runId, workflowRuns.runId))
      .where(
        and(
          eq(workflowRuns.spaceId, scope.spaceId),
          eq(workflowRuns.runId, runId),
          eq(workflowRunTasks.taskId, taskId),
          eq(workflowRuns.status, 'paused'),
          eq(workflowRunTasks.status, 'paused'),
        ),
      )
      .limit(1),
  );
  const row = rows[0];
  if (!row) return null;
  const durableHydration = await loadDurableHydration(
    deps,
    scope,
    row.run.runId,
    taskId,
    row.run.pauseVersion,
    row.task.attempt,
  );
  const taskDef = await loadHumanTaskDef(deps, scope, row.run, taskId);
  if (!taskDef && !durableHydration) return null;
  return { run: row.run, task: row.task, taskDef, durableHydration };
}

async function loadHumanTaskDef(
  deps: ActionCenterSourceDeps,
  scope: ActionCenterScope,
  run: WorkflowRunRow,
  taskId: string,
): Promise<WorkflowTask | null> {
  const resolved = await resolveWorkflowForRunRevision(
    deps.db,
    scope.tenantId,
    scope.spaceId,
    run.workflowSlug,
    run.workflowRevision,
  );
  const def = resolved?.workflow;
  if (!def) return null;
  const task = def.tasks.find((t) => t.taskId === taskId);
  if (!task || inferTaskType(task) !== 'human') return null;
  return task;
}

function buildItem(scope: ActionCenterScope, row: PausedHumanTaskRow): ActionCenterSourceItem {
  const intent = row.durableHydration?.humanIntent ?? row.taskDef?.intent ?? ('collect' as const);
  const kind: ActionCenterItemKind = intent === 'approve' ? 'human_approval' : 'human_input';

  const origin: ActionCenterItemOrigin = {
    type: 'workflow_task',
    runId: row.run.runId,
    taskId: row.task.taskId,
    pauseVersion: row.run.pauseVersion,
  };

  let resolutionSchema: Record<string, unknown> | undefined;
  if (row.durableHydration?.resolutionSchema) {
    resolutionSchema = row.durableHydration.resolutionSchema;
  } else if (row.taskDef) {
    const hydration = buildHumanTaskHydrationFields({
      task: row.taskDef,
      runPauseVersion: row.run.pauseVersion,
    });
    resolutionSchema = hydration?.resolutionSchema;
  }

  // Title + summary: the workflow definition carries the human-authored
  // copy. When the definition has drifted we fall back to the task id
  // so the item is still identifiable in the inbox.
  const title = row.taskDef?.name ?? row.task.taskId;
  const pauseInstruction = row.taskDef?.pauseInstruction;
  const baseSummary =
    intent === 'approve'
      ? (pauseInstruction ?? 'Approval required.')
      : (pauseInstruction ?? 'Input required.');
  const summary = `${baseSummary} Resolve from the run surface in chat — this inbox item is view-only.`;

  return {
    id: `${ITEM_ID_PREFIX}${row.run.runId}:${row.task.taskId}`,
    spaceId: scope.spaceId,
    kind,
    origin,
    title,
    summary,
    ...(resolutionSchema ? { resolutionSchema } : {}),
    requestedAt: (row.task.startedAt ?? row.run.startedAt).toISOString(),
    requestedBy: {
      kind: 'workflow',
      label: `Workflow: ${row.run.workflowSlug}`,
      ...(row.run.sessionId ? { sessionId: row.run.sessionId } : {}),
    },
    priority: 'normal',
    relatesTo: [
      {
        kind: 'workflow',
        id: row.run.workflowSlug,
        label: row.run.workflowSlug,
      },
    ],
    // The same kinds are resolvable when they come from a paused step, so the
    // kind cannot carry this: these are answered from the run surface in chat
    // and this source's own resolve() refuses every resolution.
    resolverAuthority: { kind: 'view_only' },
    status: 'open',
  };
}
