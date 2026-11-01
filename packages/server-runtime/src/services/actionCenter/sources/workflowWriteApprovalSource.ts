import { and, desc, eq, isNotNull } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  workflowRunTasks,
  workflowRuns,
  type WorkflowRunRow,
  type WorkflowRunTaskRow,
} from '@aflow/database';
import { ACTION_CENTER_ITEM_ID_PREFIX } from '@aflow/schemas';
import {
  readPausedTaskWriteApproval,
  resolvePausedRunWriteApproval,
} from '@aflow/cybernetic-runtime';
import { operatorResumeHarnessHooks } from '../../workflowRunOperatorResume.js';
import {
  type ActionCenterResolveOutcome,
  type ActionCenterScope,
  type ActionCenterSource,
  type ActionCenterSourceDeps,
  type ActionCenterSourceItem,
  ActionCenterResolveError,
} from '../types.js';
import { buildWriteApprovalCard, writeApprovalOperationId } from './pausedStepSource.js';

const ITEM_ID_PREFIX = ACTION_CENTER_ITEM_ID_PREFIX.workflowWriteApproval;
const LIST_LIMIT = 200;

interface PausedOperationTask {
  run: WorkflowRunRow;
  task: WorkflowRunTaskRow;
}

/**
 * Write approvals asked by a workflow run's operation tasks (Plan 253).
 *
 * The API executor's `write_approval` pause on a workflow task pauses the RUN —
 * `task_paused`, with the request as `paused_payload_ref` — and creates no
 * session, so `pausedStepSource` never sees it and the human-task sources
 * skip it as an operation task. This source surfaces it as the same
 * approve/deny card, and its resolve is the authenticated boundary that mints
 * the grant and resumes the run: approve re-dispatches the task, deny fails it.
 *
 * The item id carries the pause version: every pause bumps it, so a task that
 * asks again after an approval is a new item rather than the answered one.
 */
export function createWorkflowWriteApprovalSource(
  deps: ActionCenterSourceDeps,
): ActionCenterSource {
  return {
    name: 'workflowWriteApproval',
    rowScope: 'space',
    handlesOriginTypes: ['workflow_task'],

    async listOpen(scope: ActionCenterScope): Promise<ActionCenterSourceItem[]> {
      const rows = await selectPausedOperationTasks(deps, scope, {});
      const items: ActionCenterSourceItem[] = [];
      for (const row of rows) {
        const item = await buildItem(deps, scope, row);
        if (item) items.push(item);
      }
      return items;
    },

    async getById(ctx, itemId): Promise<ActionCenterSourceItem | null> {
      const parsed = parseItemId(itemId);
      if (!parsed) return null;
      const [row] = await selectPausedOperationTasks(deps, ctx, parsed);
      return row ? buildItem(deps, ctx, row) : null;
    },

    async resolve(ctx, item, resolution): Promise<ActionCenterResolveOutcome> {
      if (item.origin.type !== 'workflow_task') {
        throw new ActionCenterResolveError(
          'NOT_FOUND',
          `Item ${item.id} is not a workflow run's write approval.`,
          'permanent',
        );
      }
      if (resolution.kind !== 'approve' && resolution.kind !== 'reject') {
        throw new ActionCenterResolveError(
          'INVALID_RESOLUTION',
          `A write approval is approved or denied; got '${resolution.kind}'.`,
          'permanent',
        );
      }
      const reason = resolution.kind === 'approve' ? resolution.comment : resolution.reason;
      const result = await resolvePausedRunWriteApproval(
        deps,
        {
          tenantId: ctx.tenantId,
          spaceId: ctx.spaceId,
          runId: item.origin.runId,
          taskId: item.origin.taskId,
          pauseVersion: item.origin.pauseVersion,
          actorUserId: ctx.actorUserId,
          decision: resolution.kind === 'approve' ? 'approved' : 'denied',
          ...(reason ? { reason } : {}),
        },
        operatorResumeHarnessHooks(deps.redis, ctx.spaceId),
      );
      if (!result.ok) {
        throw result.code === 'STALE_PAUSE' || result.code === 'RESUME_IN_PROGRESS'
          ? new ActionCenterResolveError(
              'STALE_ACTION_CENTER_ITEM',
              result.message,
              'stale_target',
              'Reload to see where the run is now.',
            )
          : new ActionCenterResolveError('DISPATCH_FAILED', result.message, 'transient');
      }
      return {
        resolvedAt: new Date().toISOString(),
        dispatchedOperationId: 'workflow.run.resume',
        reportedOperationId: writeApprovalOperationId(result.request),
      };
    },
  };
}

function parseItemId(itemId: string): { runId: string; pauseVersion: number } | null {
  if (!itemId.startsWith(ITEM_ID_PREFIX)) return null;
  const rest = itemId.slice(ITEM_ID_PREFIX.length);
  const sep = rest.lastIndexOf(':');
  if (sep <= 0) return null;
  const pauseVersion = Number(rest.slice(sep + 1));
  if (!Number.isInteger(pauseVersion) || pauseVersion < 0) return null;
  return { runId: rest.slice(0, sep), pauseVersion };
}

/**
 * Paused runs joined to the paused task whose payload the run's pause holds —
 * the pairing `readPausedTaskWriteApproval` then confirms is a write approval.
 */
async function selectPausedOperationTasks(
  deps: ActionCenterSourceDeps,
  scope: ActionCenterScope,
  only: { runId?: string; pauseVersion?: number },
): Promise<PausedOperationTask[]> {
  const tenantCtx = createTenantContext(scope.tenantId);
  return withTenantSchema(deps.db, tenantCtx, async (tx) =>
    tx
      .select({ run: workflowRuns, task: workflowRunTasks })
      .from(workflowRuns)
      .innerJoin(workflowRunTasks, eq(workflowRunTasks.runId, workflowRuns.runId))
      .where(
        and(
          eq(workflowRuns.spaceId, scope.spaceId),
          eq(workflowRuns.status, 'paused'),
          eq(workflowRuns.pausedReason, 'task_paused'),
          isNotNull(workflowRuns.pausedPayloadRef),
          eq(workflowRunTasks.status, 'paused'),
          eq(workflowRunTasks.outputRef, workflowRuns.pausedPayloadRef),
          ...(only.runId !== undefined ? [eq(workflowRuns.runId, only.runId)] : []),
          ...(only.pauseVersion !== undefined
            ? [eq(workflowRuns.pauseVersion, only.pauseVersion)]
            : []),
        ),
      )
      .orderBy(desc(workflowRuns.startedAt))
      .limit(only.runId !== undefined ? 1 : LIST_LIMIT),
  );
}

async function buildItem(
  deps: ActionCenterSourceDeps,
  scope: ActionCenterScope,
  { run, task }: PausedOperationTask,
): Promise<ActionCenterSourceItem | null> {
  const request = await readPausedTaskWriteApproval(deps.payloadStore, run, task);
  if (!request) return null;
  return buildWriteApprovalCard({
    id: `${ITEM_ID_PREFIX}${run.runId}:${String(run.pauseVersion)}`,
    spaceId: scope.spaceId,
    request,
    origin: () => ({
      type: 'workflow_task',
      runId: run.runId,
      taskId: task.taskId,
      pauseVersion: run.pauseVersion,
    }),
    // The task row's completion is stamped by the pause itself.
    requestedAt: (task.completedAt ?? run.startedAt).toISOString(),
    requestedBy: {
      kind: 'workflow',
      label: `Workflow: ${run.workflowSlug}`,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    },
    open: true,
    relatesTo: [{ kind: 'workflow', id: run.workflowSlug, label: run.workflowSlug }],
  });
}
