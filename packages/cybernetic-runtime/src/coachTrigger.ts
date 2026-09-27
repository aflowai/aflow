import { randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { encodeInlinePayloadRef, type PayloadStore } from '@aflow/payload-store';
import type {
  TenantId,
  SessionId,
  StepExecutionId,
  TraceId,
  IdempotencyKey,
  EntityDirectives,
  RunnerReflection,
  AppliedChangeOutcome,
  SystemRole,
} from '@aflow/schemas';
import { createTenantContext, withTenantSchema, sessions, spaces } from '@aflow/database';
import { getPlatformAgentBySystemRole } from '@aflow/platform-artifacts';
import {
  addControlMessage,
  appendEntityEvent,
  claimControlDispatchIdempotency,
  getSessionStateSafe,
} from '@aflow/redis';
import { getCyberneticLogger, logCyberneticError } from './logger.js';
import { emitPhaseIfChanged } from './interactionPhase.js';
import { loadCoachFeedback, formatCoachFeedbackForPrompt } from './coachFeedback.js';
import { loadUserFeedbackForSkill, formatUserFeedbackForPrompt } from './userFeedback.js';
import { loadEvalSuite } from './evalRunner.js';
import type { CoachReviewFacts } from '@aflow/schemas';
import { buildCoachReviewContext, persistCoachReviewContext } from './coachReviewContext.js';
import type { CoachFocusArea, CoachReviewTriggerKind, CoachSkillMode } from '@aflow/schemas';
import {
  compileCoachFacts,
  formatCoachFactsForPrompt,
  formatLearningsForPrompt,
  loadRecentLearnings,
  persistCoachReviewFacts,
  type LearningSetStateForPrompt,
} from './facts/index.js';
import { resolveActiveSetBudget, selectActiveLearningSet } from './activeLearningSet.js';
import { checkTrajectoryCoachActivation } from './coachTriggerTrajectory.js';
import { checkAgentSignalCoachActivation } from './coachTriggerAgentSignal.js';
import {
  formatAppliedChangeOutcomesForPrompt,
  loadAppliedChangeOutcomes,
} from './coachTriggerAppliedChanges.js';
import {
  resolveReflectionEvidenceSnapshot,
  type ReflectionCompleteness,
} from './reflectionCapture.js';
import { formatReflectionsForPrompt, loadReflections } from './coachTriggerReflections.js';
import {
  buildValidityRepairPromptParts,
  checkValidityCoachActivation,
  type ValidityCoachTriggerInput,
} from './coachTriggerValidity.js';
import { loadCandidateEvidenceForPrompt } from './coachTriggerCandidateEvidence.js';
import {
  buildCampaignEndReviewPromptParts,
  formatCampaignSynthesisForPrompt,
  loadCampaignSynthesisEvidence,
} from './coachTriggerCampaignEnd.js';
import { formatBreadthEvidenceForPrompt, resolveBreadthForReview } from './coachTriggerBreadth.js';
import {
  formatEvalSuiteForPrompt,
  loadEvalQualityReportForReview,
} from './coachTriggerEvalQuality.js';

// ============================================================================
// Types
// ============================================================================

export type CoachTriggerSource =
  | 'eval_signal'
  | 'maturity_signal'
  | 'directive_sampled'
  | 'trajectory_signal'
  | 'validity_signal'
  | 'agent_signal';

/**
 * What the dispatch is labelled with (log line, entity event, coach input,
 * suppressed-activity row): a gate-evaluated source, or — for explicit
 * requests and forced retriggers — the review kind itself.
 */
export type CoachDispatchSource = CoachTriggerSource | CoachReviewTriggerKind;

export interface CoachTriggerParams {
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  runId: string;
  /** Total number of runs (including this one) for this workflow. */
  totalRuns: number;
  /** Eval result from the eval runner (may be undefined if no eval suite). */
  evalResult?: {
    verdict: 'pass' | 'fail' | 'partial' | 'error';
    scores: { overall: number };
    regressionDetected: boolean;
    faultLayer?: string;
    faultEvidence?: string;
    suggestedRemediationOwner?: 'learner' | 'operator' | 'platform_team' | 'none';
  };
  /** Entity directives — provides Coach policy knobs. */
  directives?: EntityDirectives;
  /** Maturity transition that triggered this call (if maturity-signal source). */
  maturityTransition?: { from: string; to: string };
  trajectory?: { direction: 'maximize' | 'minimize'; series: number[] };
  campaignId?: string;
  validity?: ValidityCoachTriggerInput;
  reflections?: RunnerReflection[];
  db: PostgresJsDatabase;
  redis: Redis;
  payloadStore?: PayloadStore;
  /** Operator-driven manual retrigger. Skips the activation gate and the
   *  per-skill rate cap, and suffixes the idempotency key so a new Coach
   *  session is dispatched even if one already ran for this run. */
  force?: boolean;
  /** Suffix the idempotency key so the dispatch never dedupes against an
   *  earlier session for the same run/campaign. Unlike `force`, the
   *  activation gate and the per-skill rate cap still apply. */
  freshDispatch?: boolean;
  reviewContextOverrides?: {
    triggerKind?: CoachReviewTriggerKind;
    requestedBy?: string;
    rationale?: string;
    taskId?: string;
    focusAreas?: CoachFocusArea[];
    skillMode?: CoachSkillMode;
  };
}

// ============================================================================
// Activation gate — unified three-source evaluation (104e §4.8)
// ============================================================================

export async function shouldActivateCoach(params: CoachTriggerParams): Promise<{
  activate: boolean;
  source: CoachTriggerSource;
  reason: string;
} | null> {
  const { evalResult, totalRuns, directives, maturityTransition } = params;
  const policy = directives?.learningPolicy;

  // Master switch — disables every source, validity-repair included.
  if (policy && !policy.enabled) {
    return null;
  }

  // Validity-repair is evaluated ahead of the per-run gate: a structurally
  // broken skill must be repairable even when per-run auto-review is off.
  if (params.validity) {
    return checkValidityCoachActivation(params.validity);
  }

  // Per-run auto-review gate — off by default. The sources below (eval /
  // trajectory / agent / maturity / directive sampling) fire only when the
  // operator has explicitly opted a run's finish into a Coach review.
  // Campaign-end synthesis and explicit requests bypass this function entirely.
  if (policy && !policy.coachAutoReviewPerRun) {
    return null;
  }

  const bootstrapRuns = policy?.coachBootstrapRuns ?? 5;
  const scoreFloor = policy?.coachScoreFloor ?? 0.7;

  // 1. Eval-signal source — terminal failures + confirmed regressions
  // fire here, before sampling has a chance to silence them.
  if (totalRuns <= bootstrapRuns) {
    return {
      activate: true,
      source: 'eval_signal',
      reason: `bootstrap (run ${String(totalRuns)} of first ${String(bootstrapRuns)})`,
    };
  }

  if (evalResult?.regressionDetected) {
    return { activate: true, source: 'eval_signal', reason: 'regression detected' };
  }

  if (evalResult && evalResult.scores.overall < scoreFloor) {
    return {
      activate: true,
      source: 'eval_signal',
      reason: `low score (${String(evalResult.scores.overall)} < ${String(scoreFloor)})`,
    };
  }

  if (params.trajectory) {
    const trajectoryActivation = checkTrajectoryCoachActivation({
      trajectory: params.trajectory,
      policy,
    });
    if (trajectoryActivation) {
      return trajectoryActivation;
    }
  }

  if (params.reflections && params.reflections.length > 0) {
    const agentActivation = checkAgentSignalCoachActivation({
      reflections: params.reflections,
    });
    if (agentActivation) {
      return agentActivation;
    }
  }

  // No eval result is not itself a trigger — the Coach should only fire
  // when a positive signal justifies it (bootstrap, regression, low score,
  // maturity transition, or directive sampling). Without eval data and
  // outside the bootstrap window, fall through to maturity/sampling checks.

  // 2. Maturity-signal source
  if (maturityTransition) {
    return {
      activate: true,
      source: 'maturity_signal',
      reason: `maturity transition ${maturityTransition.from} → ${maturityTransition.to}`,
    };
  }

  // 3. Directive-sampled source
  const samplingPolicy = policy?.coachSamplingPolicy ?? 'codified_only';
  switch (samplingPolicy) {
    case 'always':
      return { activate: true, source: 'directive_sampled', reason: 'sampling policy: always' };
    case 'sampled': {
      const rate = policy?.coachSampleRate ?? 0.2;
      if (Math.random() < rate) {
        return {
          activate: true,
          source: 'directive_sampled',
          reason: `sampling policy: sampled (rate=${rate.toFixed(3)})`,
        };
      }
      break;
    }
    case 'flagged':
      break;
    case 'codified_only':
      // Already covered by eval-signal above for codified runs
      break;
  }

  return null;
}

// ============================================================================
// Rate limiter (104e §4.8)
// ============================================================================

function coachRateKey(spaceId: string, skillSlug: string): string {
  return `cybernetic:coach-rate:${spaceId}:${skillSlug}`;
}

const DEFAULT_RATE_WINDOW_SECONDS = 24 * 60 * 60; // 1 day

/**
 * Check and increment the Coach activation rate for a skill.
 * Returns true if under the cap, false if rate-limited.
 */
async function checkAndIncrementRate(
  redis: Redis,
  spaceId: string,
  skillSlug: string,
  maxActivations: number,
): Promise<boolean> {
  const key = coachRateKey(spaceId, skillSlug);
  const current = await redis.incr(key);
  if (current === 1) {
    // First activation in this window — set TTL
    await redis.expire(key, DEFAULT_RATE_WINDOW_SECONDS);
  }
  return current <= maxActivations;
}

// ============================================================================
// Coach resolution
// ============================================================================

function resolveCoachAgent(): { systemRole: SystemRole; version: string } | null {
  const coachEntry = getPlatformAgentBySystemRole('cybernetic-coach');
  if (!coachEntry) return null;
  return { systemRole: 'cybernetic-coach' as SystemRole, version: '1' };
}

/**
 * Carry the Coach's dispatch input by value when it fits, by reference when not.
 *
 * The store is optional on the params, and a caller that did not supply one has
 * no way to carry an oversized input — so an input over the cap fails here,
 * naming the size, rather than dispatching a session whose first read cannot
 * resolve its own input.
 */
async function storeOrInlineCoachInput(
  coachInput: unknown,
  tenantId: string,
  coachSessionId: SessionId,
  payloadStore: PayloadStore | undefined,
): Promise<string> {
  if (payloadStore?.shouldStore(coachInput)) {
    // Scoped to the session it starts, not content-addressed: the payload route
    // authorizes by run, and a content-addressed object names none — its bytes
    // are served by whichever row references them, which for a dispatch input
    // is nothing. A fresh step identity per encode keeps one dispatch's input
    // from overwriting another's.
    return await payloadStore.store({
      tenantId: tenantId as TenantId,
      runId: coachSessionId,
      stepExecutionId: randomUUID() as StepExecutionId,
      attempt: 0,
      kind: 'input',
      data: coachInput,
    });
  }
  return encodeInlinePayloadRef(coachInput);
}

// ============================================================================
// Trigger
// ============================================================================

/** One observable surface for every suppressed dispatch: the
 *  `entity.coach.suppressed` event plus a `coach_activity` row. */
async function recordSuppressedDispatch(params: {
  redis: Redis;
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  runId: string;
  source: CoachDispatchSource;
  triggerCause: string;
  reason: string;
  summary: string;
}): Promise<void> {
  // Row before event: the event doubles as a live-surface wake, and a rebuild
  // it triggers must find the activity row already committed.
  try {
    const { recordCoachActivity } = await import('./coachActivity/recordActivity.js');
    await recordCoachActivity(
      { tenantId: params.tenantId, db: params.db },
      {
        spaceId: params.spaceId,
        skillSlug: params.workflowSlug,
        triggerKind: params.source,
        triggerCause: params.triggerCause,
        outcome: 'suppressed',
        status: `suppressed:${params.reason}`,
      },
    );
  } catch {
    /* best-effort projection write */
  }
  await appendEntityEvent(params.redis, {
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    event: {
      eventId: randomUUID(),
      eventType: 'entity.coach.suppressed',
      spaceId: params.spaceId,
      tenantId: params.tenantId,
      timestamp: Date.now(),
      workflowSlug: params.workflowSlug,
      workflowRunId: params.runId,
      operatingMode: 'supervisory',
      payload: { reason: params.reason, skillSlug: params.workflowSlug },
      summary: params.summary,
    },
  });
}

/**
 * Trigger a Coach review session for a completed workflow run.
 *
 * @returns The Coach session ID if triggered, null if skipped.
 */
/**
 * Whether a review may be raised without anyone asking for one.
 *
 * Background review is off unless a deployment turns it on. It ran after every
 * run with nothing bounding it, and a review could ask for another: one session
 * reached 33,383 steps and 83,468 events — from a three-message conversation —
 * at 4,345 events a minute for twenty-five minutes. Those are model calls, so
 * the cost was spend, not just noise.
 *
 * A review asked for **explicitly** — by an operator, or by a platform workflow
 * the Helmsman drives — is unaffected. This gate only governs the automatic
 * kind, where nothing chose to start it and nothing was watching it finish.
 */
export function backgroundCoachReviewEnabled(): boolean {
  return process.env['COACH_AUTO_REVIEW_ENABLED'] === '1';
}

export async function triggerCoachReview(params: CoachTriggerParams): Promise<string | null> {
  const logger = getCyberneticLogger();
  const { tenantId, spaceId, workflowSlug, runId, directives, db, redis } = params;

  try {
    const overrideKind = params.reviewContextOverrides?.triggerKind;
    // A campaign-end review synthesizes over the whole campaign — the last
    // run's reflections are not its evidence, so the barrier wait is skipped.
    const isCampaignEndReview =
      overrideKind === 'campaign_end_review' && params.campaignId !== undefined;

    let reflections: RunnerReflection[] = params.reflections ?? [];
    let reflectionCompleteness: ReflectionCompleteness = 'none';
    if (!params.validity && params.reflections === undefined && !isCampaignEndReview) {
      try {
        const captureKnobs = directives?.learningPolicy.reflectionCapture;
        reflectionCompleteness = await resolveReflectionEvidenceSnapshot(redis, {
          tenantId,
          runId,
          barrierTimeoutMs: captureKnobs?.barrierTimeoutMs ?? 5_000,
          barrierPollMs: captureKnobs?.barrierPollMs ?? 200,
        });
        reflections = await loadReflections(db, tenantId, runId);
      } catch (err) {
        logger.warn(
          `coachTrigger: reflection barrier/read failed for run=${runId} (continuing without): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 1. Activation gate — unified three-source evaluation. An ended campaign
    // is always review-worthy, so `campaign_end_review` bypasses sampling the
    // same way an explicit request does (the rate limiter still applies).
    // Explicit requests carry their own review kind as the dispatch source so
    // logs / events / coach_activity never mislabel them as sampling.
    const isExplicitRequest =
      overrideKind === 'helmsman_requested_review' ||
      overrideKind === 'operator_requested_review' ||
      overrideKind === 'eval_suite_audit' ||
      isCampaignEndReview;
    const gate: { activate: boolean; source: CoachDispatchSource; reason: string } | null =
      isExplicitRequest && overrideKind
        ? {
            activate: true,
            source: overrideKind,
            reason: `explicit ${overrideKind}`,
          }
        : params.force
          ? {
              activate: true,
              source: 'operator_requested_review',
              reason: 'manual retrigger',
            }
          : await shouldActivateCoach({ ...params, reflections });
    if (!gate) {
      logger.debug(`coachTrigger: skipping for ${workflowSlug} run=${runId}: no trigger matched`);
      return null;
    }

    // 2. Rate limiter — bypassed under `force` (manual retrigger).
    if (!params.force) {
      const maxActivations = directives?.learningPolicy.maxCoachActivationsPerSkillPerWindow ?? 10;
      const withinCap = await checkAndIncrementRate(redis, spaceId, workflowSlug, maxActivations);
      if (!withinCap) {
        logger.info(
          `coachTrigger: rate-capped for ${workflowSlug} run=${runId} (max ${String(maxActivations)}/window)`,
        );
        await recordSuppressedDispatch({
          redis,
          db,
          tenantId,
          spaceId,
          workflowSlug,
          runId,
          source: gate.source,
          triggerCause: gate.reason,
          reason: 'rate_cap',
          summary: `Coach activation rate-capped for ${workflowSlug}`,
        });
        return null;
      }
    }

    logger.info(
      `coachTrigger: activating for ${workflowSlug} run=${runId} [${gate.source}]: ${gate.reason}`,
    );

    const isValidityRepair = params.validity !== undefined && gate.source === 'validity_signal';

    // 3. Resolve Coach agent
    const coach = resolveCoachAgent();
    if (!coach) {
      logger.warn(`coachTrigger: no cybernetic-coach agent found for tenant ${tenantId}`);
      return null;
    }

    // 4. Generate the Coach session ID up front so it can be used as the
    const coachSessionId = randomUUID() as SessionId;

    let appliedChangeOutcomes: AppliedChangeOutcome[] = [];
    if (!isValidityRepair) {
      try {
        appliedChangeOutcomes = await loadAppliedChangeOutcomes({
          db,
          tenantId,
          spaceId,
          workflowSlug,
          limit: directives?.learningPolicy.appliedChangeEvidenceLimit ?? 5,
        });
      } catch (err) {
        logger.warn(
          `coachTrigger: applied-change evidence load failed for ${workflowSlug}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const { resolvedSkillMode, breadthEvidence } = await resolveBreadthForReview({
      db,
      tenantId,
      spaceId,
      workflowSlug,
      overrideMode: params.reviewContextOverrides?.skillMode,
      campaignId: params.campaignId,
      directives,
      isValidityRepair,
    });

    try {
      const overrides = params.reviewContextOverrides;
      const triggerKind: CoachReviewTriggerKind = overrides?.triggerKind ?? gate.source;

      const context = buildCoachReviewContext({
        spaceId,
        tenantId,
        coachSessionId,
        triggerKind,
        ...(overrides?.requestedBy ? { requestedBy: overrides.requestedBy } : {}),
        rationale: overrides?.rationale ?? gate.reason,
        bypassesGate: params.force === true,
        skillSlug: workflowSlug,
        runId,
        ...(overrides?.taskId ? { taskId: overrides.taskId } : {}),
        ...(params.campaignId ? { campaignId: params.campaignId } : {}),
        ...(overrides?.focusAreas ? { focusAreas: overrides.focusAreas } : {}),
        ...(resolvedSkillMode ? { skillMode: resolvedSkillMode } : {}),
        ...(params.validity ? { validityDiagnostics: params.validity.diagnostics } : {}),
        ...(appliedChangeOutcomes.length > 0 ? { appliedChangeOutcomes } : {}),
        ...(breadthEvidence ? { breadthEvidence } : {}),
      });
      await persistCoachReviewContext({ db, context });
    } catch (err) {
      // The persisted review context is load-bearing — coach_activity
      // trigger attribution, the finalize facet rules, and campaign-scope
      // recording guards all read it — so a Coach session never launches
      // without it.
      logCyberneticError(
        `coachTrigger: review-context persistence failed for ${workflowSlug} run=${runId} — dispatch aborted`,
        err,
      );
      await recordSuppressedDispatch({
        redis,
        db,
        tenantId,
        spaceId,
        workflowSlug,
        runId,
        source: gate.source,
        triggerCause: gate.reason,
        reason: 'context_persist_failed',
        summary: `Coach dispatch aborted for ${workflowSlug}: review-context persistence failed`,
      });
      return null;
    }

    let facts: CoachReviewFacts | undefined;
    try {
      if (!isValidityRepair && !isCampaignEndReview) {
        facts = await compileCoachFacts({
          db,
          redis,
          tenantId,
          spaceId,
          runId,
          workflowSlug,
          ...(params.evalResult
            ? {
                evalResult: {
                  verdict: params.evalResult.verdict,
                  scores: params.evalResult.scores,
                  regressionDetected: params.evalResult.regressionDetected,
                },
              }
            : {}),
        });
        await persistCoachReviewFacts({ db, tenantId, spaceId, coachSessionId, facts });
      }
    } catch (err) {
      logger.warn(
        `coachTrigger: facts compilation failed for ${workflowSlug} run=${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 6. Load supplementary context — feedback history + user feedback + learnings + eval suite
    //    (parallel). Reflections were already read ONCE at step 0 (the
    //    finalize barrier) — they are reused here, never re-read.
    const feedbackLimit = directives?.learningPolicy.coachFeedbackHistorySize ?? 10;
    const [feedback, userFeedbackEntries, durableLearnings, evalSuite] = await Promise.all([
      loadCoachFeedback(redis, tenantId, spaceId, feedbackLimit),
      loadUserFeedbackForSkill(
        db,
        tenantId,
        spaceId,
        workflowSlug,
        directives?.learningPolicy.userFeedbackPromptWindow ?? 20,
      ),
      loadRecentLearnings({ db, tenantId, spaceId, workflowSlug }),
      loadEvalSuite(db, tenantId, spaceId, workflowSlug),
    ]);

    // 7. Build Coach input with structured context
    const evalSummary = params.evalResult
      ? `Eval: ${params.evalResult.verdict}, overall=${String(params.evalResult.scores.overall)}${params.evalResult.regressionDetected ? ' (REGRESSION DETECTED)' : ''}${params.evalResult.faultLayer ? `, fault=${params.evalResult.faultLayer}` : ''}`
      : 'No eval result available';
    const remediationSummary = params.evalResult?.suggestedRemediationOwner
      ? `Suggested remediation owner: ${params.evalResult.suggestedRemediationOwner}.`
      : undefined;
    const faultEvidenceSummary = params.evalResult?.faultEvidence
      ? `Fault evidence: ${params.evalResult.faultEvidence}`
      : undefined;

    const reflectionBlock = formatReflectionsForPrompt(reflections);
    const feedbackBlock = formatCoachFeedbackForPrompt(feedback);
    const userFeedbackBlock = formatUserFeedbackForPrompt(userFeedbackEntries);
    const qualityReport = await loadEvalQualityReportForReview({
      db,
      tenantId,
      spaceId,
      workflowSlug,
      evalSuite,
      isValidityRepair,
      directives,
    });
    const evalSuiteBlock = formatEvalSuiteForPrompt(evalSuite, qualityReport);

    const factsBlock = facts ? formatCoachFactsForPrompt(facts) : '';
    let learningSetState: LearningSetStateForPrompt | undefined;
    try {
      const activeSetBudget = resolveActiveSetBudget(directives);
      const activeSet = await selectActiveLearningSet({
        db,
        tenantId,
        spaceId,
        skillSlug: workflowSlug,
        ...(params.campaignId ? { campaignId: params.campaignId } : {}),
        budget: activeSetBudget,
      });
      learningSetState = {
        activeSetSize: activeSet.selected.filter((e) => e.kind !== 'trajectory').length,
        budget: activeSetBudget,
        consolidationDue: activeSet.consolidationDue,
      };
    } catch {
      // The brief renders without curation pressure rather than failing the review.
    }
    const learningsBlock = formatLearningsForPrompt(durableLearnings, learningSetState);
    const appliedChangesBlock = formatAppliedChangeOutcomesForPrompt(appliedChangeOutcomes);

    const candidateEvidenceBlock = await loadCandidateEvidenceForPrompt({
      db,
      tenantId,
      spaceId,
      skillSlug: workflowSlug,
      ...(params.campaignId ? { campaignId: params.campaignId } : {}),
      ...(params.campaignId && params.trajectory && breadthEvidence?.mode !== 'optimization'
        ? {
            trajectory: {
              direction: params.trajectory.direction,
              series: params.trajectory.series,
            },
          }
        : {}),
    });
    const breadthBlock = breadthEvidence ? formatBreadthEvidenceForPrompt(breadthEvidence) : '';

    // The synthesis packet subsumes the per-run diagnosis surfaces (facts,
    // learnings, trajectory, candidate ledger) — those blocks are suppressed
    // below so the campaign evidence renders exactly once.
    let campaignSynthesisBlock = '';
    if (isCampaignEndReview && params.campaignId) {
      const synthesisEvidence = await loadCampaignSynthesisEvidence({
        db,
        tenantId,
        spaceId,
        workflowSlug,
        campaignId: params.campaignId,
      });
      if (synthesisEvidence) {
        campaignSynthesisBlock = formatCampaignSynthesisForPrompt({
          evidence: synthesisEvidence,
          ...(learningSetState ? { setState: learningSetState } : {}),
        });
      }
    }

    // The campaign-end framing promises the synthesis packet — use it only
    // when the packet was actually built; an unreadable campaign degrades to
    // the ordinary run-review framing with the run blocks intact.
    const packetSubsumesRunBlocks = campaignSynthesisBlock !== '';
    const promptParts =
      packetSubsumesRunBlocks && params.campaignId
        ? buildCampaignEndReviewPromptParts({
            workflowSlug,
            campaignId: params.campaignId,
            reason: params.reviewContextOverrides?.rationale ?? gate.reason,
          })
        : isValidityRepair && params.validity
          ? buildValidityRepairPromptParts({
              workflowSlug,
              diagnostics: params.validity.diagnostics,
              reason: gate.reason,
            })
          : [
              `Review workflow "${workflowSlug}" run ${runId}.`,
              evalSummary,
              `Trigger: ${gate.source} — ${gate.reason}.`,
              'The blocks below are the deterministic packet. Read the run with artifact.inspect.* for any detail the packet does not pin, then diagnose against the issue category framework and emit categorized proposals (or none).',
            ];
    if (remediationSummary) promptParts.push(remediationSummary);
    if (faultEvidenceSummary) promptParts.push(faultEvidenceSummary);
    if (factsBlock) promptParts.push('', factsBlock);
    if (campaignSynthesisBlock) promptParts.push('', campaignSynthesisBlock);
    if (evalSuiteBlock && !packetSubsumesRunBlocks) promptParts.push('', evalSuiteBlock);
    if (learningsBlock && !packetSubsumesRunBlocks) promptParts.push('', learningsBlock);
    if (appliedChangesBlock) promptParts.push('', appliedChangesBlock);
    if (breadthBlock && !packetSubsumesRunBlocks) promptParts.push('', breadthBlock);
    if (candidateEvidenceBlock && !packetSubsumesRunBlocks)
      promptParts.push('', candidateEvidenceBlock);
    if (reflectionBlock) promptParts.push('', reflectionBlock);
    if (feedbackBlock) promptParts.push('', feedbackBlock);
    if (userFeedbackBlock) promptParts.push('', userFeedbackBlock);

    const coachInput = {
      input: {
        prompt: promptParts.join('\n'),
        workflow_slug: workflowSlug,
        run_id: runId,
        trigger_source: gate.source,
      },
    };
    // The prompt is assembled from reflections, feedback and outcomes, none of
    // which are bounded, so this is the one dispatch input that can exceed the
    // inline cap. Storing it keeps the dispatch working at any size; inlining a
    // value over the cap would produce a ref the Coach's own first read rejects.
    const inputRef = await storeOrInlineCoachInput(
      coachInput,
      tenantId,
      coachSessionId,
      params.payloadStore,
    );
    const traceId = `coach-${workflowSlug.slice(0, 16)}-${runId.slice(0, 8)}` as TraceId;
    // A campaign-end synthesis is keyed to the CAMPAIGN, not the run — the
    // same terminal run also dispatches the regular run review, and sharing
    // the run-keyed idempotency key would silently drop one of the two.
    // A retrigger / re-summon suffixes a fresh key so the dispatch never
    // dedupes against an earlier session.
    const retrigger = params.force === true || params.freshDispatch === true;
    const idempotencyKey = (
      isCampaignEndReview && params.campaignId
        ? retrigger
          ? `coach:${workflowSlug}:campaign-end:${params.campaignId}:retrigger:${randomUUID()}`
          : `coach:${workflowSlug}:campaign-end:${params.campaignId}`
        : retrigger
          ? `coach:${workflowSlug}:${runId}:retrigger:${randomUUID()}`
          : `coach:${workflowSlug}:${runId}`
    ) as IdempotencyKey;

    // Attribute the Coach session to the user who initiated the parent run so
    // the review uses their grants/credentials and shows up in their session
    // list. Falls back to the space owner, then a zero UUID, when the parent
    // run's createdBy can't be resolved.
    let credentialOwnerId = '00000000-0000-0000-0000-000000000000';
    let initiatorResolved = false;
    try {
      const hot = await getSessionStateSafe(redis, tenantId, runId);
      if (hot.ok && hot.state.createdBy) {
        credentialOwnerId = hot.state.createdBy;
        initiatorResolved = true;
      }
    } catch {
      // Best-effort — fall through to DB lookup
    }
    if (!initiatorResolved) {
      try {
        const sessionRows = await withTenantSchema(
          db,
          createTenantContext(tenantId as TenantId),
          async (tx) =>
            tx
              .select({ createdBy: sessions.createdBy })
              .from(sessions)
              .where(eq(sessions.sessionId, runId as SessionId))
              .limit(1),
        );
        if (sessionRows[0]?.createdBy) {
          credentialOwnerId = sessionRows[0].createdBy;
          initiatorResolved = true;
        }
      } catch {
        // Best-effort — fall through to space-owner lookup
      }
    }
    if (!initiatorResolved) {
      try {
        const spaceRows = await withTenantSchema(
          db,
          createTenantContext(tenantId as TenantId),
          async (tx) =>
            tx
              .select({ createdBy: spaces.createdBy })
              .from(spaces)
              .where(eq(spaces.id, spaceId))
              .limit(1),
        );
        if (spaceRows[0]?.createdBy) {
          credentialOwnerId = spaceRows[0].createdBy;
        }
      } catch {
        // Best-effort — fall back to zero UUID
      }
    }

    const actorContext = {
      userId: credentialOwnerId,
      kind: 'system' as const,
      authMethod: 'system' as const,
      tenantId,
      tenantRole: 'admin',
      spaceId,
      spaceRole: 'admin',
      displayName: 'Coach Trigger',
      capturedAt: new Date().toISOString(),
    };

    // This producer enqueues start_run directly (no API boundary in front),
    // so it claims the idempotency key itself — the orchestrator stores the
    // key but never checks it.
    const claim = await claimControlDispatchIdempotency(redis, idempotencyKey, coachSessionId);
    if (!claim.claimed) {
      logger.info(
        `coachTrigger: duplicate dispatch suppressed for ${workflowSlug} run=${runId} ` +
          `(key=${idempotencyKey}, existing session ${claim.existingRunId ?? 'unknown'})`,
      );
      await recordSuppressedDispatch({
        redis,
        db,
        tenantId,
        spaceId,
        workflowSlug,
        runId,
        source: gate.source,
        triggerCause: gate.reason,
        reason: 'dedup',
        summary: `Coach dispatch deduped for ${workflowSlug}: idempotency key already claimed`,
      });
      return null;
    }

    await addControlMessage(redis, {
      messageVersion: 1,
      type: 'start_run',
      tenantId: tenantId as TenantId,
      runId: coachSessionId,
      target: { kind: 'platform-role', systemRole: coach.systemRole },
      agentVersion: coach.version,
      inputRef,
      traceId,
      idempotencyKey,
      requestedAtMs: Date.now(),
      spaceId,
      trigger: 'api',
      actorContext,
      createdBy: credentialOwnerId,
    });

    // 6. Emit entity event with trigger source
    await appendEntityEvent(redis, {
      tenantId,
      spaceId,
      event: {
        eventId: randomUUID(),
        eventType: 'entity.coach.activated',
        spaceId,
        tenantId,
        timestamp: Date.now(),
        causedBySessionId: coachSessionId,
        workflowSlug,
        workflowRunId: runId,
        operatingMode: 'supervisory',
        payload: {
          triggerSource: gate.source,
          reason: gate.reason,
          evidenceSnapshot: { runId, reflectionCompleteness },
        },
        summary: `Coach activated for ${workflowSlug} [${gate.source}]: ${gate.reason}`,
      },
    });

    logger.info(
      `coachTrigger: dispatched coach session ${coachSessionId} ` +
        `for ${workflowSlug} run=${runId} [${gate.source}]`,
    );

    // 104b: Coach dispatched → emit 'review' phase
    emitPhaseIfChanged({
      tenantId,
      spaceId,
      redis,
      inputs: {
        helmsmanStatus: 'idle',
        activeRunnerSessions: [],
        activeCoachSessions: [{ sessionId: coachSessionId }],
      },
    });

    return coachSessionId;
  } catch (err) {
    logger.warn(
      `coachTrigger: failed to trigger for ${workflowSlug} run=${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
