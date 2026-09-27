/**
 * Cybernetic post-run hooks — extracted for use from both the inline
 * handler path (workflowCrud.ts) and the graph engine path
 * (workflowRunEngine.ts).
 *
 * Runs the eval → coach → skill-projection pipeline after a workflow
 * run reaches terminal state.
 *
 * @packageDocumentation
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import {
  runEvaluation,
  buildEvalTaskResultsFromRows,
  triggerCoachReview,
  backgroundCoachReviewEnabled,
  triggerCampaignEndReview,
  type EvalRunOutcome,
  type EvalRunResult,
  onSkillRunCompleted,
  onEvalCompleted,
  finalizeExpiredWindows,
  loadRunById,
  countProductionRuns,
  getCyberneticLogger,
  parseRunEvaluationEnvelope,
  prepareRunScoring,
  materializeRunScore,
  getCampaignScoreSeries,
  computeFailedRequiredTaskIds,
  writeRunEvaluationEnvelope,
} from '@aflow/cybernetic-runtime';
import type {
  TenantId,
  EntityDirectives,
  WorkflowLearning,
  CampaignEndedReason,
} from '@aflow/schemas';
import { createTenantContext, withTenantSchema, spaces } from '@aflow/database';
import { createByokAiClientFactory } from '@aflow/credential-resolver';
import { eq } from 'drizzle-orm';
import { EntityDirectivesSchema } from '@aflow/schemas';
import { appendEntityEvent } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import { randomUUID } from 'node:crypto';

export interface PostRunHookParams {
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  runId: string;
  db: PostgresJsDatabase;
  redis: Redis;
  payloadStore?: PayloadStore;
}

/**
 * Fire the eval → coach → skill-projection pipeline for a completed run.
 * Safe to call from any context — checks cybernetic mode internally and
 * catches all errors to avoid blocking the caller.
 */
export async function fireCyberneticPostRunHooksStandalone(
  params: PostRunHookParams,
): Promise<void> {
  const { tenantId, spaceId, workflowSlug, runId, db, redis, payloadStore } = params;
  const logger = getCyberneticLogger();

  try {
    // Check if space is cybernetic
    const tenantCtx = createTenantContext(tenantId as TenantId);
    const spaceRows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select({ directives: spaces.directives })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .limit(1),
    );

    const row = spaceRows[0];
    if (row?.directives == null) {
      logger.debug(`[postRunHooks] Space ${spaceId} has no directives — skipping`);
      return;
    }

    // Load the run detail
    const run = await loadRunById(db, tenantId, spaceId, runId);
    if (!run) {
      logger.warn(`[postRunHooks] Run ${runId} not found — skipping`);
      return;
    }

    // Frozen-mode gate (Plan 269 D5) — an eval-batch trial is graded by the
    // batch engine against its case's expectations, never by the production
    // suite: NO eval, NO Coach activation, no score/candidate
    // materialization, no campaign hooks. Only the envelope decision is
    // recorded, so "did eval fire" stays a read on frozen runs too.
    if (run.evalBatchId != null) {
      try {
        await writeRunEvaluationEnvelope(db, tenantId, {
          runId,
          write: { kind: 'decision', decision: 'eval_batch' },
        });
      } catch (envErr) {
        logger.warn(
          `[postRunHooks] Failed to write eval-batch envelope for run=${runId}: ${
            envErr instanceof Error ? envErr.message : String(envErr)
          }`,
        );
      }
      return;
    }

    // Operator-cancel gate — a run the operator stopped deliberately carries
    // no behavioral signal: NO eval, NO Coach activation, no score/candidate
    // materialization; only the envelope decision is recorded. System/agent
    // cancels keep the existing path.
    if (run.status === 'cancelled' && run.cancelledBy === 'operator') {
      logger.info(
        `[postRunHooks] Run ${runId} was cancelled by the operator — skipping eval + Coach hooks`,
      );
      try {
        await writeRunEvaluationEnvelope(db, tenantId, {
          runId,
          write: { kind: 'decision', decision: 'operator_cancelled' },
        });
      } catch (envErr) {
        logger.warn(
          `[postRunHooks] Failed to write operator-cancel envelope for run=${runId}: ${
            envErr instanceof Error ? envErr.message : String(envErr)
          }`,
        );
      }
      return;
    }

    const taskResults = await buildEvalTaskResultsFromRows(run.tasks, payloadStore, { runId });

    const scoring = await prepareRunScoring({
      db,
      tenantId,
      spaceId,
      workflowSlug,
      runId,
      taskResults,
    });

    const failedRequiredTaskIds = computeFailedRequiredTaskIds(scoring.workflow?.tasks, run.tasks);

    // Step 1: Run eval — unconditional when a suite exists; the outcome is
    // recorded on the run as a typed evaluation envelope either way.
    const byokFactory = createByokAiClientFactory(db);
    let evalOutcome: EvalRunOutcome;
    try {
      evalOutcome = await runEvaluation({
        tenantId,
        spaceId,
        workflowSlug,
        runId,
        sessionId: run.sessionId ?? runId,
        taskResults,
        resolveJudgeClient: async (model) => {
          const { client } = await byokFactory.getClientForModel(model, { tenantId, spaceId });
          return client;
        },
        runLevelMetrics: scoring.runLevelMetrics,
        ...(scoring.workflow ? { workflowTasks: scoring.workflow.tasks } : {}),
        ...(() => {
          const outcomeEvaluation = parseRunEvaluationEnvelope(
            run.evaluationJson,
          )?.outcomeEvaluation;
          if (!outcomeEvaluation) return {};
          return {
            outcomeResults: {
              met: outcomeEvaluation.outcomeResults.filter((o) => o.met).length,
              total: outcomeEvaluation.outcomeResults.length,
              details: outcomeEvaluation.outcomeResults,
            },
          };
        })(),
        runTerminal: { runStatus: run.status, failedRequiredTaskIds },
        db,
        redis,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      evalOutcome = { decision: 'error', message: errorMessage };
      logger.warn(`[postRunHooks] Eval failed for ${workflowSlug} run=${runId}: ${errorMessage}`);
      // Emit hook.failed event
      try {
        await appendEntityEvent(redis, {
          tenantId,
          spaceId,
          event: {
            eventId: randomUUID(),
            eventType: 'entity.hook.failed',
            spaceId,
            tenantId,
            timestamp: Date.now(),
            workflowSlug,
            workflowRunId: runId,
            operatingMode: 'supervisory',
            payload: {
              hookName: 'eval-runner',
              errorMessage,
              workflowSlug,
              runId,
            },
            summary: `Eval hook failed for ${workflowSlug}: ${errorMessage}`,
          },
        });
      } catch {
        // Best-effort
      }
    }

    const evalResult: EvalRunResult | null =
      evalOutcome.decision === 'ran' || evalOutcome.decision === 'error'
        ? (evalOutcome.result ?? null)
        : null;

    try {
      await writeRunEvaluationEnvelope(db, tenantId, {
        runId,
        write: {
          kind: 'decision',
          decision: evalOutcome.decision,
          ...(evalOutcome.decision !== 'no_suite' && evalOutcome.suiteContentHash !== undefined
            ? { suiteContentHash: evalOutcome.suiteContentHash }
            : {}),
          ...(evalOutcome.decision === 'ran'
            ? {
                summary: {
                  verdict: evalOutcome.result.verdict,
                  scores: evalOutcome.result.scores,
                  faultLayer: evalOutcome.result.faultLayer ?? null,
                  regressionDetected: evalOutcome.result.regressionDetected,
                },
              }
            : {}),
          ...(evalOutcome.decision !== 'no_suite' && evalOutcome.judgeSelection !== undefined
            ? { judgeSelection: evalOutcome.judgeSelection }
            : {}),
          ...(evalOutcome.decision === 'error' ? { errorMessage: evalOutcome.message } : {}),
        },
      });
    } catch (persistErr) {
      logger.warn(
        `[postRunHooks] Failed to write evaluation envelope for ${workflowSlug} run=${runId}: ${
          persistErr instanceof Error ? persistErr.message : String(persistErr)
        }`,
      );
    }

    if (evalOutcome.decision === 'ran') {
      logger.info(
        `[postRunHooks] Eval completed for ${workflowSlug} run=${runId}: ` +
          `verdict=${evalOutcome.result.verdict} overall=${String(evalOutcome.result.scores.overall)}`,
      );

      // 104e follow-up Phase B: wire causal binder — update post_metrics
      try {
        await onEvalCompleted(
          { tenantId, spaceId, db, redis },
          {
            workflowSlug,
            overallScore: evalOutcome.result.scores.overall,
            evaluatedAt: new Date(),
          },
        );
      } catch (causalErr) {
        logger.warn(
          `[postRunHooks] Causal binder onEvalCompleted failed for ${workflowSlug}: ${
            causalErr instanceof Error ? causalErr.message : String(causalErr)
          }`,
        );
      }
    }

    let campaignEnded: { campaignId: string; reason: CampaignEndedReason } | undefined;
    try {
      const learnings = Array.isArray(run.learningsJson)
        ? (run.learningsJson as WorkflowLearning[])
        : [];
      const scored = await materializeRunScore({
        db,
        tenantId,
        spaceId,
        workflowSlug,
        runId,
        goal: scoring.goal,
        campaign: scoring.campaign,
        outcomes: scoring.workflow?.outcomes ?? [],
        runLevelMetrics: scoring.runLevelMetrics,
        evalResult: evalResult
          ? {
              resultId: evalResult.resultId,
              overall: evalResult.scores.overall,
              verdict: evalResult.verdict,
              regressionDetected: evalResult.regressionDetected,
            }
          : null,
        learnings,
        ...(run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
          ? { runTerminalStatus: run.status }
          : {}),
      });
      campaignEnded = scored.campaignEnded;
    } catch (err) {
      logger.warn(
        `[postRunHooks] score/candidate materialization failed for ${workflowSlug} run=${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Step 1.5: Finalize any expired causal measurement windows (best-effort)
    try {
      await finalizeExpiredWindows({ tenantId, spaceId, db, redis });
    } catch (err) {
      logger.debug(
        `[postRunHooks] Causal window finalization failed for ${spaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    let parsedDirectives: EntityDirectives | undefined;
    try {
      parsedDirectives = EntityDirectivesSchema.parse(row.directives);
    } catch {
      // Fall back to defaults
    }

    let maturityTransition: { from: string; to: string } | undefined;
    try {
      const reconcile = await onSkillRunCompleted(
        {
          db,
          tenantId,
          spaceId,
          redis,
          ...(parsedDirectives ? { directives: parsedDirectives } : {}),
        },
        workflowSlug,
      );
      maturityTransition = reconcile.maturityTransition;
    } catch (err) {
      logger.warn(
        `[postRunHooks] SkillProjection update failed for ${workflowSlug}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Load actual run count — feeds both the bootstrap trigger logic and the
    // campaign-end dispatch below. Production runs only: frozen batch trials
    // must not fast-forward the Coach bootstrap window.
    let totalRuns = 1;
    try {
      totalRuns = await countProductionRuns(db, tenantId, spaceId, workflowSlug);
    } catch {
      // Fall back to 1
    }

    // Step 3: Trigger Coach
    try {
      const coachEvalResult = evalResult
        ? {
            verdict: evalResult.verdict,
            scores: { overall: evalResult.scores.overall },
            regressionDetected: evalResult.regressionDetected,
            ...(evalResult.faultLayer ? { faultLayer: evalResult.faultLayer } : {}),
            ...(evalResult.faultEvidence ? { faultEvidence: evalResult.faultEvidence } : {}),
            ...(evalResult.suggestedRemediationOwner
              ? { suggestedRemediationOwner: evalResult.suggestedRemediationOwner }
              : {}),
          }
        : undefined;

      let trajectory: { direction: 'maximize' | 'minimize'; series: number[] } | undefined;
      if (scoring.campaign) {
        try {
          const series = await getCampaignScoreSeries(db, tenantId, scoring.campaign.campaignId);
          trajectory = {
            direction: scoring.campaign.direction,
            series: series.map((p) => p.score),
          };
        } catch {
          // Best-effort — a series load failure just skips the trajectory producer.
        }
      }

      // Nobody asked for this one. Background review is off unless a
      // deployment turns it on — see `backgroundCoachReviewEnabled`. Guarded at
      // the dispatch rather than by returning early, so the steps after it are
      // not silently skipped along with it.
      if (backgroundCoachReviewEnabled()) {
        await triggerCoachReview({
          tenantId,
          spaceId,
          workflowSlug,
          runId,
          totalRuns,
          ...(coachEvalResult ? { evalResult: coachEvalResult } : {}),
          ...(parsedDirectives ? { directives: parsedDirectives } : {}),
          ...(trajectory ? { trajectory } : {}),
          ...(scoring.campaign ? { campaignId: scoring.campaign.campaignId } : {}),
          ...(maturityTransition ? { maturityTransition } : {}),
          db,
          redis,
          ...(params.payloadStore ? { payloadStore: params.payloadStore } : {}),
        });
      }
    } catch (err) {
      logger.warn(
        `[postRunHooks] Coach trigger failed for ${workflowSlug} run=${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Step 4: campaign ended on this finalize (goal met) → dispatch the
    // campaign-end synthesis review. Separate from the run review above:
    // campaign-keyed idempotency, synthesis brief instead of run diagnosis.
    if (campaignEnded) {
      try {
        await triggerCampaignEndReview({
          tenantId,
          spaceId,
          workflowSlug,
          runId,
          totalRuns,
          campaignId: campaignEnded.campaignId,
          reason: campaignEnded.reason,
          ...(parsedDirectives ? { directives: parsedDirectives } : {}),
          db,
          redis,
          ...(params.payloadStore ? { payloadStore: params.payloadStore } : {}),
        });
      } catch (err) {
        logger.warn(
          `[postRunHooks] campaign-end review dispatch failed for campaign=${campaignEnded.campaignId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } catch (err) {
    logger.error(
      `[postRunHooks] Unexpected error for ${workflowSlug} run=${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
