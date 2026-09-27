import { getDatabase } from '@aflow/database';
import type { WorkflowLearning, WorkflowLearnInput } from '@aflow/schemas';
import { WorkflowLearnInputSchema } from '@aflow/schemas';
import {
  loadRunById,
  loadWorkflowTaskByWorkerSession,
  updateRunMetadata,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from '../types.js';
import { emitStepSuccess, emitStepError } from '../helpers.js';
import { requireSpaceId } from '../spaceScope.js';

export async function handleWorkflowLearn(
  args: InlineHandlerArgs,
  rawInput: WorkflowLearnInput,
  startTime: number,
): Promise<void> {
  // The dispatcher casts the raw payload-store object to `WorkflowLearnInput`
  // without parsing — parse here so schema validation and defaults apply.
  const parsed = WorkflowLearnInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    await emitStepError(
      args,
      'INVALID_INPUT',
      `workflow.learn input invalid: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('; ')}`,
      startTime,
      'validation',
    );
    return;
  }
  const input = parsed.data;
  const spaceId = requireSpaceId(args.context);
  const db = getDatabase();
  const tenantIdStr = args.context.tenantId as string;

  let runId = input.runId ?? args.workflowExecution?.runId;
  // A Runner calling workflow.learn as an agent TOOL
  // (mid-task, e.g. recording a discovery during hydrate) has no
  // workflowExecution envelope, and the agent cannot know the runId — but
  // the platform does: its session IS a worker session on a task row.
  // System-derivable context is resolved by the system, never demanded
  // from the agent (the spaceId invariant's sibling).
  if (!runId) {
    try {
      const taskRow = await loadWorkflowTaskByWorkerSession(db, tenantIdStr, args.context.runId);
      if (taskRow) runId = taskRow.runId;
    } catch {
      /* fall through to the teaching error */
    }
  }
  if (!runId) {
    await emitStepError(
      args,
      'WORKFLOW_RUN_NOT_FOUND',
      'workflow.learn requires a workflow-run context: pass runId explicitly when calling outside a workflow run (e.g. from Helmsman or the Coach).',
      startTime,
      'validation',
    );
    return;
  }

  // Find the target run (relational — 104c Phase 2)
  const run = await loadRunById(db, tenantIdStr, spaceId, runId);
  if (!run) {
    await emitStepError(
      args,
      'WORKFLOW_RUN_NOT_FOUND',
      `Run ${runId} not found.`,
      startTime,
      'validation',
    );
    return;
  }
  const slug = input.slug ?? run.workflowSlug;
  if (run.workflowSlug !== slug) {
    await emitStepError(
      args,
      'WORKFLOW_RUN_NOT_FOUND',
      `Run ${runId} not found for workflow "${slug}".`,
      startTime,
      'validation',
    );
    return;
  }

  // Build new learnings array (existing + new)
  const existingLearnings = Array.isArray(run.learningsJson)
    ? (run.learningsJson as WorkflowLearning[])
    : [];

  const newLearnings: WorkflowLearning[] = [];
  for (const { evidence, ...learningInput } of input.learnings) {
    const learning: WorkflowLearning = {
      ...learningInput,
      evidence: {
        runId: evidence?.runId ?? runId,
        ...(evidence?.taskId ? { taskId: evidence.taskId } : {}),
        ...(evidence?.sessionId ? { sessionId: evidence.sessionId } : {}),
        ...(evidence?.metrics ? { metrics: evidence.metrics } : {}),
      },
    };
    newLearnings.push(learning);
  }

  const allLearnings = [...existingLearnings, ...newLearnings];

  // Update learnings on the run without touching status (104c Phase 2)
  await updateRunMetadata(db, tenantIdStr, {
    runId: run.runId,
    learningsJson: allLearnings,
  });

  await emitStepSuccess(
    args,
    {
      recorded: input.learnings.length,
      totalRecordedLearnings: allLearnings.length,
    },
    startTime,
  );
}
