import { getDatabase, workflowDocPath } from '@aflow/database';
import type { Workflow, WorkflowEvaluateInput } from '@aflow/schemas';
import {
  compareWithThresholdOperator,
  outcomeHasCampaignRefs,
  resolveOutcomeEvaluatorParams,
} from '@aflow/schemas';
import {
  completeRun,
  loadRunById,
  getRunCampaignId,
  getCampaignById,
  writeRunEvaluationEnvelope,
} from '@aflow/cybernetic-runtime';
import { fireCyberneticPostRunHooksStandalone } from '../../../../cybernetic/postRunHooks.js';
import type { InlineHandlerArgs } from '../types.js';
import { emitStepSuccess, emitStepError } from '../helpers.js';
import { requireSpaceId } from '../spaceScope.js';
import { getRepos, readJsonDoc, writeJsonDoc } from './shared.js';

export async function handleWorkflowEvaluate(
  args: InlineHandlerArgs,
  input: WorkflowEvaluateInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const { docRepo } = getRepos(args.context.tenantId);
  const slug = input.slug;

  const workflow = await readJsonDoc<Workflow>(docRepo, workflowDocPath(slug), spaceId);
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

  const metrics = input.metrics;

  let campaignConfig: Record<string, unknown> | null = null;
  if (workflow.outcomes.some(outcomeHasCampaignRefs) && input.runId) {
    try {
      const db = getDatabase();
      const tenantIdStr = args.context.tenantId as string;
      const campaignId = await getRunCampaignId(db, tenantIdStr, input.runId);
      if (campaignId) {
        const campaign = await getCampaignById(db, tenantIdStr, campaignId);
        if (campaign) campaignConfig = campaign.config ?? {};
      }
    } catch {
      // Best-effort — unresolved refs surface per-outcome below.
    }
  }

  // Evaluate each outcome
  const outcomeResults = workflow.outcomes.map((outcome) => {
    // Resolve $campaign refs (pass-through for literal evaluators).
    const resolved = resolveOutcomeEvaluatorParams(outcome, campaignConfig ?? {});
    if (!resolved.ok) {
      return {
        outcomeId: outcome.id,
        met: false,
        value: null,
        detail:
          campaignConfig === null && outcomeHasCampaignRefs(outcome)
            ? `Unresolved $campaign reference (no campaign in scope — pass the runId of a campaign-keyed run): ${resolved.reason}`
            : `Unresolved $campaign reference: ${resolved.reason}`,
      };
    }
    const evaluator = resolved.outcome.evaluator;

    if (evaluator.type === 'threshold') {
      const value = metrics[evaluator.metric];
      if (value === undefined || typeof value !== 'number') {
        return {
          outcomeId: outcome.id,
          met: false,
          value,
          detail: `Metric "${evaluator.metric}" not found or not a number`,
        };
      }
      const met = compareWithThresholdOperator(
        value,
        evaluator.operator,
        evaluator.target,
        evaluator.targetHigh,
      );
      return { outcomeId: outcome.id, met, value };
    }

    if (evaluator.type === 'pattern') {
      const value = metrics[evaluator.metric];
      const strValue =
        value == null
          ? ''
          : typeof value === 'string' ||
              typeof value === 'number' ||
              typeof value === 'boolean' ||
              typeof value === 'bigint'
            ? String(value)
            : JSON.stringify(value);
      const met = new RegExp(evaluator.pattern).test(strValue);
      return { outcomeId: outcome.id, met, value: strValue };
    }

    return {
      outcomeId: outcome.id,
      met: false,
      value: null,
      detail: 'Manual outcome — requires human evaluation',
    };
  });

  const allMet = outcomeResults.every((r) => r.met);

  // If all met, optionally update workflow status
  if (allMet && workflow.status === 'approved') {
    const { dirRepo } = getRepos(args.context.tenantId);
    const updated: Workflow = {
      ...workflow,
      status: 'completed',
      updatedAt: new Date().toISOString(),
    };
    await writeJsonDoc(
      docRepo,
      dirRepo,
      workflowDocPath(slug),
      updated as unknown as Record<string, unknown>,
      'json',
      spaceId,
      'overwrite',
    );
  }

  // Record evaluation on relational run if runId is provided (104c Phase 2)
  let completedRunHere = false;
  if (input.runId) {
    const db = getDatabase();
    const tenantIdStr = args.context.tenantId as string;
    const run = await loadRunById(db, tenantIdStr, spaceId, input.runId);
    if (run?.workflowSlug === slug) {
      // Outcome results land in the run's evaluation envelope through the
      // single writer — a distinct slot from the post-run eval summary.
      await writeRunEvaluationEnvelope(db, tenantIdStr, {
        runId: run.runId,
        write: { kind: 'outcome', outcomeEvaluation: { outcomeResults, allMet } },
      });
      if (allMet && (run.status === 'running' || run.status === 'paused')) {
        completedRunHere = await completeRun(db, tenantIdStr, {
          runId: run.runId,
          status: 'completed',
          completedAt: new Date(),
        });
      }
    }
  }

  await emitStepSuccess(args, { outcomeResults, allMet }, startTime);

  // This op transitioned the run to terminal → fire the standard post-run
  // pipeline. Evaluation itself is dispatched ONLY there (single caller);
  // an already-terminal run was evaluated when it terminalized.
  if (input.runId && completedRunHere) {
    const db = getDatabase();
    fireCyberneticPostRunHooksStandalone({
      tenantId: args.context.tenantId as string,
      spaceId,
      workflowSlug: slug,
      runId: input.runId,
      db,
      redis: args.redis,
      ...(args.payloadStore ? { payloadStore: args.payloadStore } : {}),
    }).catch(() => {});
  }
}
