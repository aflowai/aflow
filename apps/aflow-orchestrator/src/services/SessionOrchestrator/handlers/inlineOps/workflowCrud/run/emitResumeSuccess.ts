import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Workflow } from '@aflow/schemas';
import {
  type deriveRunLiveness,
  loadRunById,
  type WorkflowRunDetail,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from '../../types.js';
import { emitStepSuccess } from '../../helpers.js';

export async function emitResumeSuccess(
  args: InlineHandlerArgs,
  run: WorkflowRunDetail,
  workflow: Workflow,
  livenessResult: ReturnType<typeof deriveRunLiveness>,
  startTime: number,
  db: PostgresJsDatabase,
  tenantIdStr: string,
  spaceId: string,
): Promise<void> {
  const slug = run.workflowSlug;
  // Re-load to capture post-commit pauseVersion + resume_attempt_count.
  const post = await loadRunById(db, tenantIdStr, spaceId, run.runId);
  const completedTaskIds = (post ?? run).tasks
    .filter((t) => t.status === 'succeeded')
    .map((t) => t.taskId);
  const pendingTaskIds = workflow.tasks
    .filter((t) => !completedTaskIds.includes(t.taskId))
    .map((t) => t.taskId);
  const taskTools = workflow.tasks.map((t) => ({
    toolId: `task_${t.taskId}`,
    taskId: t.taskId,
    name: t.name,
  }));

  await emitStepSuccess(
    args,
    {
      runId: run.runId,
      slug,
      status: 'running',
      pauseVersion: post?.pauseVersion ?? run.pauseVersion,
      resumeAttemptCount: post?.resumeAttemptCount ?? run.resumeAttemptCount,
      priorLiveness: livenessResult.liveness,
      priorLivenessReason: livenessResult.reason,
      completedTasks: completedTaskIds,
      pendingTasks: pendingTaskIds,
      taskResults: (post ?? run).tasks.map((t) => ({
        taskId: t.taskId,
        status: t.status === 'succeeded' ? 'completed' : t.status,
        summary: t.summary,
        failureReason: t.failureReason,
        attempts: t.attempt,
      })),
      taskTools,
    },
    startTime,
  );
}
