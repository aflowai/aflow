import { getDatabase, workflowDocPath } from '@aflow/database';
import type { Workflow, WorkflowLedgerGetInput } from '@aflow/schemas';
import {
  getRunStatistics,
  listRecentRuns,
  loadRunById,
  selectActiveLearningSetForSkill,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from '../types.js';
import { emitStepSuccess } from '../helpers.js';
import { requireSpaceId } from '../spaceScope.js';
import {
  getRepos,
  readJsonDoc,
  buildTrajectory,
  nextCursorFromRuns,
  parseLedgerCursor,
} from './shared.js';

export async function handleWorkflowLedgerGet(
  args: InlineHandlerArgs,
  input: WorkflowLedgerGetInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const { docRepo } = getRepos(args.context.tenantId);
  const slug = input.slug;
  const db = getDatabase();
  const tenantIdStr = args.context.tenantId as string;

  const maxEntries = input.maxEntries;
  const campaignFilter = input.campaignId !== undefined ? { campaignId: input.campaignId } : {};
  const stats = await getRunStatistics(db, tenantIdStr, spaceId, slug, {
    windowDays: 36500,
    ...campaignFilter,
  });
  const recentRuns = await listRecentRuns(db, tenantIdStr, spaceId, slug, {
    limit: maxEntries,
    ...parseLedgerCursor(input.before),
    ...campaignFilter,
  });

  const trajectory = buildTrajectory(recentRuns);
  const nextCursor = nextCursorFromRuns(recentRuns, maxEntries);

  const entries: Array<Record<string, unknown>> = [];
  if (input.includeEntries) {
    for (const run of recentRuns) {
      const detail = await loadRunById(db, tenantIdStr, spaceId, run.runId);
      if (detail) {
        entries.push({
          runId: detail.runId,
          sessionId: detail.sessionId,
          startedAt: detail.startedAt.toISOString(),
          completedAt: detail.completedAt?.toISOString(),
          snapshot: { workflowRevision: detail.workflowRevision },
          status: detail.status,
          taskResults: detail.tasks.map((t) => ({
            taskId: t.taskId,
            status: t.status === 'succeeded' ? 'completed' : t.status,
            summary: t.summary,
            failureReason: t.failureReason,
            attempts: t.attempt,
            durationMs: t.durationMs,
            costCents: t.costCents,
            metrics: t.metricsJson,
          })),
          evaluation: detail.evaluationJson,
          learnings: detail.learningsJson,
        });
      }
    }
  }

  const learningSet = await selectActiveLearningSetForSkill({
    db,
    tenantId: tenantIdStr,
    spaceId,
    skillSlug: slug,
    ...(input.campaignId !== undefined ? { campaignId: input.campaignId } : {}),
  });

  const workflow = await readJsonDoc<Workflow>(docRepo, workflowDocPath(slug), spaceId);

  await emitStepSuccess(
    args,
    {
      workflowId: workflow?.id ?? '',
      totalEntries: stats.totalRuns,
      trajectory,
      entries,
      activeLearnings: learningSet.selected,
      omittedDueToBudget: learningSet.omittedDueToBudget,
      consolidationDue: learningSet.consolidationDue,
      ...(nextCursor ? { nextCursor } : {}),
    },
    startTime,
  );
}
