import { getDatabase } from '@aflow/database';
import { resolveWorkflowForStart, listWorkflowsWithPlatform } from '@aflow/database';
import type { WorkflowGetInput, WorkflowListInput } from '@aflow/schemas';
import {
  getRunStatistics,
  listRecentRuns,
  loadRunById,
  deriveRunLiveness,
  deriveFirstTaskInputContract,
  surfaceWorkflowResumeContract,
  listActiveRunsForWorkflow,
  resolveBestScoreForWorkflow,
  ensureCurrentSkillValidity,
  resolveSkillForWorkflow,
  deriveCampaignContractJsonSchema,
  selectActiveLearningSetForSkill,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from '../types.js';
import { emitStepSuccess, emitStepError } from '../helpers.js';
import { requireSpaceId } from '../spaceScope.js';
import { buildTrajectory, nextCursorFromRuns, parseLedgerCursor } from './shared.js';

export async function handleWorkflowGet(
  args: InlineHandlerArgs,
  input: WorkflowGetInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const slug = input.slug;
  const db = getDatabase();

  const workflow = await resolveWorkflowForStart(db, args.context.tenantId, spaceId, slug);
  if (!workflow) {
    await emitStepError(
      args,
      'WORKFLOW_NOT_FOUND',
      `No workflow found with slug "${slug}".`,
      startTime,
      'validation',
    );
    return;
  }

  const result: Record<string, unknown> = { workflow };

  result['contractValidity'] = ensureCurrentSkillValidity({
    tasks: workflow.tasks,
    stateVariables: workflow.stateVariables,
    output: workflow.output,
    runInputs: workflow.runInputs,
  });

  const firstTaskInputContract = deriveFirstTaskInputContract(workflow);
  if (firstTaskInputContract !== null) {
    result['firstTaskInputContract'] = firstTaskInputContract;
  }

  // Surface the campaign contract so a caller knows the config shape (field
  // names, enums) BEFORE starting a run, rather than discovering it by failing
  // the CAMPAIGN_REQUIRED gate.
  const skill = await resolveSkillForWorkflow(
    { db, tenantId: args.context.tenantId as string, spaceId },
    slug,
  );
  if (skill?.manifest.campaign !== undefined) {
    result['campaignContract'] = deriveCampaignContractJsonSchema(skill.manifest.campaign);
  }

  if (input.includeLedgerSummary) {
    const tenantIdStr = args.context.tenantId as string;
    const maxEntries = input.ledgerMaxEntries;
    const campaignFilter = input.campaignId !== undefined ? { campaignId: input.campaignId } : {};
    const stats = await getRunStatistics(db, tenantIdStr, spaceId, slug, {
      windowDays: 365,
      ...campaignFilter,
    });
    const recentRuns = await listRecentRuns(db, tenantIdStr, spaceId, slug, {
      limit: maxEntries,
      ...parseLedgerCursor(input.before),
      ...campaignFilter,
    });
    const maxRuns = workflow.budget?.maxRuns;
    const runsUsed = stats.totalRuns;
    const budgetSummary = {
      ...(maxRuns !== undefined ? { maxRuns } : {}),
      runsUsed,
      ...(maxRuns !== undefined ? { runsRemaining: Math.max(0, maxRuns - runsUsed) } : {}),
      exceeded: maxRuns !== undefined && runsUsed >= maxRuns,
    };

    const trajectory = buildTrajectory(recentRuns);

    const recentEntries: Array<Record<string, unknown>> = [];
    if (input.includeRecentEntries) {
      for (const run of recentRuns) {
        const detail = await loadRunById(db, tenantIdStr, spaceId, run.runId);
        if (detail) {
          const liveness = deriveRunLiveness(detail);
          const lifecycleHint =
            detail.status === 'running' && liveness.liveness === 'stalled'
              ? 'stale_or_orphaned'
              : detail.status === 'running' && liveness.liveness === 'executing'
                ? 'live'
                : detail.status === 'paused' || liveness.liveness === 'waiting_for_input'
                  ? 'waiting_for_input'
                  : 'normal';
          const recommendedAction =
            lifecycleHint === 'stale_or_orphaned'
              ? 'continue_or_fresh'
              : lifecycleHint === 'waiting_for_input'
                ? 'resume'
                : lifecycleHint === 'live'
                  ? 'wait'
                  : 'none';
          recentEntries.push({
            runId: detail.runId,
            sessionId: detail.sessionId,
            startedAt: detail.startedAt.toISOString(),
            completedAt: detail.completedAt?.toISOString(),
            snapshot: { workflowRevision: detail.workflowRevision },
            status: detail.status,
            liveness: liveness.liveness,
            livenessReason: liveness.reason,
            lifecycleHint,
            recommendedAction,
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
    const lastRun = recentRuns[0];
    const nextCursor = nextCursorFromRuns(recentRuns, maxEntries);

    const bestScore =
      workflow.mode === 'optimization'
        ? await resolveBestScoreForWorkflow(db, tenantIdStr, spaceId, slug, campaignFilter)
        : undefined;

    result['ledgerSummary'] = {
      totalRuns: stats.totalRuns,
      lastRunStatus: lastRun?.status,
      bestScore,
      trajectory,
      recentEntries,
      activeLearnings: learningSet.selected,
      omittedDueToBudget: learningSet.omittedDueToBudget,
      consolidationDue: learningSet.consolidationDue,
      budget: budgetSummary,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  const tenantIdForPaused = args.context.tenantId as string;
  const activeRuns = await listActiveRunsForWorkflow(db, tenantIdForPaused, spaceId, slug, {
    limit: 10,
  });
  const pausedActive = activeRuns.filter((r) => r.status === 'paused');
  if (pausedActive.length > 0) {
    const pausedRuns: Array<Record<string, unknown>> = [];
    for (const run of pausedActive) {
      const surfaced = await surfaceWorkflowResumeContract(
        db,
        args.payloadStore,
        tenantIdForPaused,
        run.runId,
      );
      // Fall back to the run row's own fields when no structured
      // contract is attached — the resumer still needs runId/pauseVersion
      // to call workflow.run.resume even without a typed contract.
      // sessionId is the Driver session — required for the HUMAN-task /
      // no-contract resume path (`agent.control.resume` on the Driver).
      const entry: Record<string, unknown> = {
        runId: run.runId,
        pauseVersion: surfaced?.pauseVersion ?? run.pauseVersion,
        pausedReason: surfaced?.pausedReason ?? run.pausedReason,
        resumeAttemptCount: surfaced?.resumeAttemptCount ?? run.resumeAttemptCount,
        startedAt: run.startedAt.toISOString(),
        sessionId: run.sessionId,
      };
      if (surfaced) {
        entry['resumeContract'] = surfaced.contract;
      }
      pausedRuns.push(entry);
    }
    result['pausedRuns'] = pausedRuns;
  }

  await emitStepSuccess(args, result, startTime);
}

// ============================================================================
// workflow.manage.list
// ============================================================================

export async function handleWorkflowList(
  args: InlineHandlerArgs,
  input: WorkflowListInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const db = getDatabase();
  const tenantIdStr = args.context.tenantId as string;

  const merged = await listWorkflowsWithPlatform(db, args.context.tenantId, spaceId);

  const workflows: Array<Record<string, unknown>> = [];

  for (const workflow of merged) {
    // Apply filters
    if (input.status) {
      if (workflow.status !== input.status) continue;
    } else {
      if (workflow.status === 'abandoned') continue;
    }
    if (input.mode && workflow.mode !== input.mode) continue;

    // Run stats are space-local for every workflow, including platform ones —
    // a platform skill's ledger is the runs the *current space* has executed.
    const stats = await getRunStatistics(db, tenantIdStr, spaceId, workflow.slug, {
      windowDays: 365,
    });
    const lastRuns = await listRecentRuns(db, tenantIdStr, spaceId, workflow.slug, { limit: 1 });
    const lastRun = lastRuns[0];

    const bestScore =
      workflow.mode === 'optimization'
        ? await resolveBestScoreForWorkflow(db, tenantIdStr, spaceId, workflow.slug)
        : undefined;

    workflows.push({
      id: workflow.id,
      slug: workflow.slug,
      name: workflow.name,
      mode: workflow.mode,
      status: workflow.status,
      revision: workflow.revision,
      origin: workflow.origin,
      totalRuns: stats.totalRuns,
      lastRunStatus: lastRun?.status,
      bestScore,
    });

    if (workflows.length >= input.limit) break;
  }

  await emitStepSuccess(args, { workflows, total: workflows.length }, startTime);
}
