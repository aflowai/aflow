import { randomUUID } from 'node:crypto';
import {
  getDatabase,
  createTenantContext,
  type createMemoryDocRepository,
  workflowDocPath,
} from '@aflow/database';
import { isPlatformWorkflowSlug } from '@aflow/platform-artifacts';
import { getSessionState } from '@aflow/redis';
import type {
  DirectiveLearningPolicy,
  Workflow,
  CyberneticEvalSuite,
  SkillManifest,
} from '@aflow/schemas';
import { WorkflowSchema, CyberneticEvalSuiteSchema } from '@aflow/schemas';
import type {
  LearnerProposeWorkflowChangeInput,
  LearnerProposeWithdrawInput,
  LearnerProposeArtifactUpdateInput,
  LearnerFlagPatternInput,
  LearnerProposeAnomalyInput,
  LearnerObservationRecordInput,
  LearnerReviewRetriggerInput,
  LearnerReviewRequestInput,
  LearnerReviewFinalizeInput,
  LearnerLearningRecordInput,
  LearnerLearningResolveCandidateInput,
  LearnerLearningResolveInput,
  LearnerLearningConsolidateInput,
  CoachLearning,
  CoachObservation,
  StagedChange,
  AnomalyReport,
  EntityDirectives,
} from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { attendedAsActingRun } from './actingRun.js';
import { handleResolveCandidate } from './coachResolveCandidate.js';
import { handleConsolidateLearnings } from './coachConsolidateLearnings.js';
import { handleWithdrawProposal, parseStagedChange } from './coachWithdrawProposal.js';
import { routeInferredCauseToObservation } from './coachInferredCauseDowngrade.js';
import { handleRecordLearning } from './coachRecordLearning.js';
import { getCoachCrudRepos, writeCoachJsonDoc } from './coachCrudMemory.js';
import {
  computeProposalFingerprint,
  checkDuplicateFingerprint,
  CoachProposalExceedsEvalCapError,
  persistObservation,
  triggerCoachReview,
  loadRunById,
  listRecentRuns,
  getRunStatistics,
  getCampaignById,
  maybeTriggerCampaignEndReview,
  resolveLearning,
  resolveProposalRoute,
  proposalDirForRoute,
  computeProposalPreconditions,
  collectEvalSkillSlugs,
  isInScopeForPinning,
  runWorkflowProposalValidations,
  loadProposalValidationSnapshot,
  previewProposalApply,
  resolveCampaignManifestParams,
  resolveSkillForWorkflow,
  loadCoachReviewContext,
  getCoachLearningById,
  parseRunEvaluationEnvelope,
  // Supersession coherence (platform_issue vs refinement).
  findSupersededRefinements,
} from '@aflow/cybernetic-runtime';
import type { AuthorityLevel } from '@aflow/cybernetic-runtime';
import type { PlatformIssueOccurrence } from '@aflow/schemas';
// Platform-issue aggregation-on-propose (one incident = one open document).
import {
  coachProposalsLedgerKey,
  recordProposalInSessionLedger,
  tryAggregatePlatformIssue,
} from './coachPlatformIssueAggregation.js';

export { coachProposalsLedgerKey } from './coachPlatformIssueAggregation.js';
import {
  validateCoachAuthoredProposal,
  detectInferredCauseDowngrade,
  EntityDirectivesSchema,
} from '@aflow/schemas';

// ============================================================================

async function loadWorkflowForPreconditions(
  docRepo: ReturnType<typeof createMemoryDocRepository>,
  slug: string,
  spaceId: string,
): Promise<Workflow | null> {
  const doc = await docRepo.getByPath(workflowDocPath(slug), spaceId);
  if (!doc?.inlineContent) return null;
  try {
    return WorkflowSchema.parse(JSON.parse(doc.inlineContent));
  } catch {
    return null;
  }
}

async function loadEvalSuitesForPreconditions(
  docRepo: ReturnType<typeof createMemoryDocRepository>,
  skillSlugs: string[],
  spaceId: string,
): Promise<Map<string, CyberneticEvalSuite>> {
  const suites = new Map<string, CyberneticEvalSuite>();
  for (const slug of skillSlugs) {
    const doc = await docRepo.getByPath(`/evals/${slug}/suite.json`, spaceId);
    if (!doc?.inlineContent) continue;
    try {
      suites.set(slug, CyberneticEvalSuiteSchema.parse(JSON.parse(doc.inlineContent)));
    } catch {
      // Suite present but malformed — skip; downstream apply will surface the
      // real error. We just won't pin against it.
    }
  }
  return suites;
}

// ============================================================================
// Router
// ============================================================================

export async function handleCoachCrudInline(args: InlineHandlerArgs): Promise<void> {
  const operationId = args.stepDef.operation;
  const startTime = Date.now();

  try {
    let input: Record<string, unknown> = {};
    try {
      const data = await args.payloadStore.retrieve(args.resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      /* missing payload — each handler surfaces its own validation error */
    }

    switch (operationId) {
      case 'learner.propose.workflow_change':
        await handleProposeWorkflowChange(
          args,
          input as unknown as LearnerProposeWorkflowChangeInput,
          startTime,
        );
        break;
      case 'learner.propose.withdraw':
        await handleWithdrawProposal(
          args,
          input as unknown as LearnerProposeWithdrawInput,
          startTime,
        );
        break;
      case 'learner.flag.pattern':
        await handleFlagPattern(args, input as unknown as LearnerFlagPatternInput, startTime);
        break;
      case 'learner.propose.anomaly':
        await handleProposeAnomaly(args, input as unknown as LearnerProposeAnomalyInput, startTime);
        break;
      case 'learner.propose.artifact_update':
        await handleProposeArtifactUpdate(
          args,
          input as unknown as LearnerProposeArtifactUpdateInput,
          startTime,
        );
        break;
      case 'learner.observation.record':
        await handleRecordObservation(
          args,
          input as unknown as LearnerObservationRecordInput,
          startTime,
        );
        break;
      case 'learner.review.retrigger':
        await handleReviewRetrigger(
          args,
          input as unknown as LearnerReviewRetriggerInput,
          startTime,
        );
        break;
      case 'learner.review.request':
        await handleReviewRequest(args, input as unknown as LearnerReviewRequestInput, startTime);
        break;
      case 'learner.review.finalize':
        await handleReviewFinalize(args, input as unknown as LearnerReviewFinalizeInput, startTime);
        break;
      case 'learner.learning.record':
        await handleRecordLearning(args, input as unknown as LearnerLearningRecordInput, startTime);
        break;
      case 'learner.learning.resolve_candidate':
        await handleResolveCandidate(
          args,
          input as unknown as LearnerLearningResolveCandidateInput,
          startTime,
        );
        break;
      case 'learner.learning.resolve':
        await handleResolveLearning(
          args,
          input as unknown as LearnerLearningResolveInput,
          startTime,
        );
        break;
      case 'learner.learning.consolidate':
        await handleConsolidateLearnings(
          args,
          input as unknown as LearnerLearningConsolidateInput,
          startTime,
        );
        break;
      default:
        await emitStepError(
          args,
          'UNKNOWN_OPERATION',
          `Unknown coach operation: ${operationId}`,
          startTime,
          'validation',
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emitStepError(args, 'LEARNER_OPERATION_FAILED', message, startTime, 'internal');
  }
}

// ============================================================================
// learner.propose.workflow_change
// ============================================================================

async function handleProposeWorkflowChange(
  args: InlineHandlerArgs,
  input: LearnerProposeWorkflowChangeInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const { db, docRepo, dirRepo } = getCoachCrudRepos(args.context.tenantId);

  const wfDocAny = await docRepo.getByPath(
    `/workflows/${input.targetSlug}/workflow.json`,
    spaceId,
    { includeDeleted: true },
  );
  if (wfDocAny && wfDocAny.deletedAt !== null) {
    await emitStepSuccess(args, { suppressed: true, reason: 'workflow_archived' }, startTime);
    return;
  }

  // Read governance directives for the learning policy (fingerprint windows,
  // expiry, etc.). Proposal authority no longer reads posture — every Coach
  // proposal routes to the operator (Plan 201 §4.2).
  let learningPolicy: DirectiveLearningPolicy;
  try {
    const { spaces, withTenantSchema } = await import('@aflow/database');
    const { eq: eqOp } = await import('drizzle-orm');
    const db = getDatabase();
    const tenantCtx = createTenantContext(args.context.tenantId);

    const spaceRows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select({ directives: spaces.directives })
        .from(spaces)
        .where(eqOp(spaces.id, spaceId))
        .limit(1),
    );

    const directivesRaw = spaceRows[0]?.directives as Record<string, unknown> | null;
    const { DirectiveLearningPolicySchema } = await import('@aflow/schemas');
    learningPolicy = DirectiveLearningPolicySchema.parse(directivesRaw?.['learningPolicy'] ?? {});
  } catch {
    const { DirectiveLearningPolicySchema } = await import('@aflow/schemas');
    learningPolicy = DirectiveLearningPolicySchema.parse({});
  }

  // Infer the change kind from ops — scan ALL ops and use the strictest kind.
  // Authority escalation order: workflow_refinement < eval_criterion_change < platform_issue
  const OP_TO_KIND: Record<string, string> = {
    flag_pattern: 'pattern_flag',
    block_workflow: 'workflow_block',
    update_outcome_threshold: 'workflow_refinement',
    'eval.criterion.add': 'eval_criterion_change',
    'eval.criterion.remove': 'eval_criterion_change',
    'eval.criterion.update': 'eval_criterion_change',
    platform_issue: 'platform_issue',
  };
  const KIND_STRICTNESS: Record<string, number> = {
    workflow_refinement: 0,
    context_strategy: 0,
    learning_merge: 0,
    pattern_flag: 1,
    workflow_block: 2,
    eval_criterion_change: 3,
    platform_issue: 3,
    directive_amendment: 4,
  };

  let kind = 'workflow_refinement';
  let kindStrictness = 0;
  for (const op of input.ops) {
    const opKind = OP_TO_KIND[op.op] ?? 'workflow_refinement';
    const strictness = KIND_STRICTNESS[opKind] ?? 0;
    if (strictness > kindStrictness) {
      kind = opKind;
      kindStrictness = strictness;
    }
  }

  // Plan 201 §4.2 — every Coach proposal routes to the operator. The
  // posture/maturity/escalation authority matrix and the auto-apply path are
  // gone; the operator ratifies all changes.
  const authorityLevel: AuthorityLevel = 'require_operator';

  // The review context's target run is the run this Coach session reviewed —
  // captured for the platform-issue occurrence citation below.
  let reviewTargetRunId: string | undefined;
  try {
    const reviewContext = await loadCoachReviewContext({
      db,
      tenantId: args.context.tenantId,
      spaceId,
      coachSessionId: args.context.runId,
    });
    reviewTargetRunId = reviewContext?.target.runId;
  } catch {
    /* best-effort — citation only */
  }

  // 104e §4.2: Duplicate fingerprint suppression
  const fingerprint = computeProposalFingerprint(input.ops, input.targetSlug);
  const windowMs = learningPolicy.rejectedFingerprintWindow;

  const dupCheck = await checkDuplicateFingerprint(args.redis, spaceId, fingerprint, windowMs);
  if (dupCheck.duplicate) {
    const { appendEntityEvent } = await import('@aflow/redis');
    await appendEntityEvent(args.redis, {
      tenantId: args.context.tenantId,
      spaceId,
      event: {
        eventId: randomUUID(),
        eventType: 'entity.coach.suppressed',
        spaceId,
        tenantId: args.context.tenantId,
        timestamp: Date.now(),
        workflowSlug: input.targetSlug,
        operatingMode: 'supervisory',
        payload: {
          reason: 'duplicate_fingerprint',
          originalRejectionId: dupCheck.originalRejectionId,
        },
        summary: `Proposal suppressed (duplicate of rejected ${dupCheck.originalRejectionId ?? 'unknown'})`,
      },
    });
    await emitStepSuccess(args, { suppressed: true, reason: 'duplicate_fingerprint' }, startTime);
    return;
  }

  // 104e §4.7: Eval criterion cap enforcement
  const evalAddOps = input.ops.filter((op) => op.op === 'eval.criterion.add');
  if (evalAddOps.length > 0) {
    const maxCriteria = learningPolicy.maxEvalCriteriaPerSkill;
    for (const addOp of evalAddOps) {
      if (!('replacedCriterionId' in addOp) || !addOp.replacedCriterionId) {
        // Load the eval suite to count current criteria
        try {
          const { loadEvalSuiteCriterionCount } = await import('./evalSuiteHelpers.js');
          const skillSlug = 'skillSlug' in addOp ? addOp.skillSlug : input.targetSlug;
          const currentCount = await loadEvalSuiteCriterionCount(
            args.context.tenantId,
            spaceId,
            skillSlug,
          );
          if (currentCount >= maxCriteria) {
            throw new CoachProposalExceedsEvalCapError(skillSlug, currentCount, maxCriteria);
          }
        } catch (err) {
          if (err instanceof CoachProposalExceedsEvalCapError) {
            await emitStepError(args, 'EVAL_CAP_EXCEEDED', err.message, startTime, 'validation');
            return;
          }
          // If we can't load the count, allow the proposal through — operator reviews anyway
        }
      }
    }
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  const resolutionRoute = resolveProposalRoute({
    targetSlug: input.targetSlug,
    ops: input.ops,
  });
  const expiryMs =
    resolutionRoute === 'platform_issue' ? 30 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + expiryMs).toISOString();

  // Aggregation-on-propose — one platform incident yields ONE open document.
  // The proposalFingerprint only dedups identical ops, so repeated reviews of
  // the same incident with different prose all mint siblings.
  // Matcher + absorb/found decision live in the
  // coachPlatformIssueAggregation slice.
  let foundingOccurrence: PlatformIssueOccurrence | undefined;
  if (resolutionRoute === 'platform_issue') {
    const aggregation = await tryAggregatePlatformIssue(args, input, {
      docRepo,
      dirRepo,
      spaceId,
      now,
      startTime,
      ...(reviewTargetRunId ? { reviewTargetRunId } : {}),
    });
    if (aggregation.handled) return;
    foundingOccurrence = aggregation.foundingOccurrence;
  }

  // Goal/campaign ops edit the manifest, which is platform-owned for platform
  // skills — reject at authorship, mirroring the ratify-time guard.
  const hasManifestOps = input.ops.some(
    (o) => o.op === 'update_goal' || o.op.startsWith('campaign.field.'),
  );
  if (hasManifestOps && input.targetSlug && isPlatformWorkflowSlug(input.targetSlug)) {
    await emitStepError(
      args,
      'PLATFORM_SKILL_READONLY',
      `Platform-owned skill "${input.targetSlug}" cannot have its goal or campaign contract edited.`,
      startTime,
      'validation',
      false,
    );
    return;
  }

  const preconditionShape: {
    pinnedRevision?: number;
    preconditions?: ReturnType<typeof computeProposalPreconditions>;
  } = {};
  let workflowForValidations: Workflow | null = null;
  const evalSuitesForPreview = new Map<string, CyberneticEvalSuite>();
  // The manifest backs goal/campaign-contract preconditions and the post-edit
  // validation — its goal/contract is the source of truth, not the workflow.
  let manifestForPreview: SkillManifest | null = null;
  const inScopeForPinning = isInScopeForPinning(kind as StagedChange['kind']);
  if (inScopeForPinning && input.targetSlug) {
    const proposalShape = {
      kind: kind as StagedChange['kind'],
      targetWorkflowSlug: input.targetSlug,
      proposal: { ops: input.ops },
    } as Pick<StagedChange, 'kind' | 'proposal' | 'targetWorkflowSlug'>;
    workflowForValidations = await loadWorkflowForPreconditions(docRepo, input.targetSlug, spaceId);
    const loadedEvalSuites = await loadEvalSuitesForPreconditions(
      docRepo,
      collectEvalSkillSlugs(proposalShape),
      spaceId,
    );
    for (const [slug, suite] of loadedEvalSuites) evalSuitesForPreview.set(slug, suite);
    if (hasManifestOps) {
      const skill = await resolveSkillForWorkflow(
        { db, tenantId: args.context.tenantId, spaceId },
        input.targetSlug,
      );
      manifestForPreview = skill?.manifest ?? null;
      // A contract edit can orphan a `$campaign` ref in the target skill's eval
      // suite — load it so the preview re-validates it against the new contract.
      if (!evalSuitesForPreview.has(input.targetSlug)) {
        const suites = await loadEvalSuitesForPreconditions(docRepo, [input.targetSlug], spaceId);
        const suite = suites.get(input.targetSlug);
        if (suite) evalSuitesForPreview.set(input.targetSlug, suite);
      }
    }
    preconditionShape.preconditions = computeProposalPreconditions(proposalShape, {
      workflow: workflowForValidations,
      evalSuites: loadedEvalSuites,
      manifest: manifestForPreview,
    });
    if (workflowForValidations) preconditionShape.pinnedRevision = workflowForValidations.revision;
  }

  let applyPreviewBlock:
    | {
        attempted: true;
        result: 'ok';
        previewedAt: string;
        workflowRevisionAtPreview: number | null;
      }
    | undefined;
  const campaignParams =
    inScopeForPinning && input.targetSlug
      ? await resolveCampaignManifestParams(
          { db, tenantId: args.context.tenantId, spaceId },
          input.targetSlug,
        )
      : undefined;

  if (inScopeForPinning && input.targetSlug) {
    const preview = previewProposalApply({
      workflow: workflowForValidations,
      evalSuites: evalSuitesForPreview,
      ops: input.ops,
      targetSlug: input.targetSlug,
      ...(manifestForPreview ? { manifest: manifestForPreview } : {}),
      ...(campaignParams ? { campaign: campaignParams } : {}),
    });
    if (!preview.ok) {
      try {
        const { incrementPreviewFailedCounter } = await import('@aflow/cybernetic-runtime');
        await incrementPreviewFailedCounter(args.redis, args.context.tenantId, args.context.runId);
      } catch {
        /* counter is best-effort */
      }
      // Telemetry — apply-preview failure rate / Coach authoring discipline.
      // NOT loaded into the cross-review feedback envelope.
      try {
        const { appendEntityEvent } = await import('@aflow/redis');
        await appendEntityEvent(args.redis, {
          tenantId: args.context.tenantId,
          spaceId,
          event: {
            eventId: randomUUID(),
            eventType: 'entity.coach.preview_failed',
            spaceId,
            tenantId: args.context.tenantId,
            timestamp: Date.now(),
            causedBySessionId: args.context.runId,
            causedByStepExecutionId: args.stepExecutionId,
            workflowSlug: input.targetSlug,
            payload: {
              targetSlug: input.targetSlug,
              failureCode: preview.failureCode,
              failureDetail: preview.failureDetail.slice(0, 500),
              ...(preview.failedOpIndex !== undefined
                ? {
                    failedOpIndex: preview.failedOpIndex,
                    failedOp: input.ops[preview.failedOpIndex]?.op,
                  }
                : {}),
              opCount: input.ops.length,
            },
            summary: `Apply-preview rejected proposal for "${input.targetSlug}": ${preview.failureCode}`,
          },
        });
      } catch {
        // best-effort telemetry
      }
      const detailParts = [
        `code=${preview.failureCode}`,
        `detail=${preview.failureDetail}`,
        ...(preview.failedOpIndex !== undefined
          ? [`failedOpIndex=${String(preview.failedOpIndex)}`]
          : []),
      ];
      await emitStepError(
        args,
        'PREVIEW_FAILED',
        detailParts.join('; '),
        startTime,
        'validation',
        false,
        {
          failureCode: preview.failureCode,
          failureDetail: preview.failureDetail,
          ...(preview.failedOpIndex !== undefined ? { failedOpIndex: preview.failedOpIndex } : {}),
          ...(preview.diagnostics !== undefined ? { diagnostics: preview.diagnostics } : {}),
        },
      );
      return;
    }
    applyPreviewBlock = {
      attempted: true,
      result: 'ok',
      previewedAt: new Date().toISOString(),
      workflowRevisionAtPreview: preview.workflowRevisionAtPreview,
    };
    workflowForValidations = preview.candidateWorkflow;
  }

  let validations: ReturnType<typeof runWorkflowProposalValidations> | undefined;
  if (workflowForValidations) {
    const snapshot = await loadProposalValidationSnapshot({
      db,
      tenantId: args.context.tenantId as string,
      spaceId,
    });
    validations = runWorkflowProposalValidations(workflowForValidations, snapshot, campaignParams);
  }

  const stagedChange: StagedChange = {
    id,
    kind: kind as StagedChange['kind'],
    source: 'coach',
    status: 'proposed',
    targetWorkflowSlug: input.targetSlug,
    proposal: {
      summary: `Proposed change to workflow "${input.targetSlug}"`,
      rationale: input.rationale,
      confidence: input.confidence,
      ops: input.ops,
      ...(validations ? { validations } : {}),
    },
    evidence: {
      sourceSessionIds: input.evidence.sourceSessionIds,
      ...(input.evidence.reflectionRefs ? { reflectionRefs: input.evidence.reflectionRefs } : {}),
      ...(input.evidence.digestRef ? { digestRef: input.evidence.digestRef } : {}),
      ...(input.evidence.digestSha256 ? { digestSha256: input.evidence.digestSha256 } : {}),
      ...(input.evidence.digestCitations
        ? { digestCitations: input.evidence.digestCitations }
        : {}),
      ...(input.evidence.validityDiagnostics && input.evidence.validityDiagnostics.length > 0
        ? { validityDiagnostics: input.evidence.validityDiagnostics }
        : {}),
      ...(input.diagnosis ? { diagnosis: input.diagnosis } : {}),
      ...(input.evidence.warrant ? { warrant: input.evidence.warrant } : {}),
      ...(applyPreviewBlock ? { applyPreview: applyPreviewBlock } : {}),
      ...(input.evidence.artifactRefs && input.evidence.artifactRefs.length > 0
        ? { artifactRefs: input.evidence.artifactRefs }
        : {}),
    },
    authorityLevel,
    resolutionRoute,
    proposedAt: now,
    expiresAt,
    coachSessionId: args.context.runId,
    rebaseState: 'clean',
    ...(preconditionShape.pinnedRevision !== undefined
      ? { pinnedRevision: preconditionShape.pinnedRevision }
      : {}),
    ...(preconditionShape.preconditions ? { preconditions: preconditionShape.preconditions } : {}),
    // Founding occurrence — platform-issue docs are born with their first
    // citation so later aggregations append to a uniform list.
    ...(foundingOccurrence ? { occurrences: [foundingOccurrence] } : {}),
  };

  const issues = validateCoachAuthoredProposal(stagedChange);
  if (issues.length > 0) {
    const message = issues.map((i) => `${i.field}: ${i.message}`).join('; ');
    await emitStepError(args, 'COACH_PROPOSAL_VALIDATION_FAILED', message, startTime, 'validation');
    return;
  }

  // An inferred cause with no confirmation step must not durably mutate the
  // workflow — record it as an observation instead. Visible and traceable: the
  // returned result carries the explanation + the confirmation ask. Never a
  // hard reject (loops the Coach), never a silent swap (untraceable).
  const downgrade = detectInferredCauseDowngrade(stagedChange);
  if (downgrade) {
    await routeInferredCauseToObservation(args, input, downgrade.message, startTime);
    return;
  }

  // Write the staged change document — route platform issues to the
  const proposalDir = proposalDirForRoute(resolutionRoute);
  await writeCoachJsonDoc(
    docRepo,
    dirRepo,
    `${proposalDir}/${id}.json`,
    stagedChange as unknown as Record<string, unknown>,
    'json',
    spaceId,
    'create',
    'staged_change',
  );

  // Session-proposal ledger (inspect-ledger pattern,
  // same 24h TTL): finalize's supersession coherence scans EVERY proposal
  // this session created, so omitting one from proposalIds can't dodge it.
  await recordProposalInSessionLedger(args, id);

  // Emit entity event
  try {
    const { appendEntityEvent } = await import('@aflow/redis');
    await appendEntityEvent(args.redis, {
      tenantId: args.context.tenantId,
      spaceId,
      event: {
        eventId: randomUUID(),
        eventType: 'entity.coach.proposal',
        spaceId,
        tenantId: args.context.tenantId,
        timestamp: Date.now(),
        causedBySessionId: args.context.runId,
        causedByStepExecutionId: args.stepExecutionId,
        payload: {
          stagedChangeId: id,
          targetSlug: input.targetSlug,
          authorityLevel,
          resolutionRoute,
          confidence: input.confidence,
          opCount: input.ops.length,
          source: 'coach',
          ...(input.diagnosis ? { issueCategory: input.diagnosis.issueCategory } : {}),
        },
        summary: `Coach proposed ${String(input.ops.length)} change(s) to workflow "${input.targetSlug}" (authority: ${authorityLevel}, route: ${resolutionRoute})`,
      },
    });
  } catch {
    // Best-effort event emission
  }

  await emitStepSuccess(
    args,
    {
      stagedChangeId: id,
      authorityLevel,
      resolutionRoute,
      status: stagedChange.status,
    },
    startTime,
  );
}

// ============================================================================
// learner.flag.pattern
// ============================================================================

async function handleFlagPattern(
  args: InlineHandlerArgs,
  input: LearnerFlagPatternInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const { docRepo, dirRepo } = getCoachCrudRepos(args.context.tenantId);

  const now = new Date().toISOString();
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const flagOps: StagedChange['proposal']['ops'] = [
    {
      op: 'flag_pattern',
      patternDescription: input.patternDescription,
      ...(input.suggestedScope ? { suggestedScope: input.suggestedScope } : {}),
    },
  ];
  const flagRoute = resolveProposalRoute({ ops: flagOps });

  const stagedChange: StagedChange = {
    id,
    kind: 'pattern_flag',
    source: 'coach',
    status: 'proposed',
    proposal: {
      summary: input.patternDescription,
      rationale: input.patternDescription,
      confidence: 'medium',
      ops: flagOps,
    },
    evidence: {
      sourceSessionIds: input.evidence.sourceSessionIds,
      ...(input.evidence.observedPatternCount
        ? {
            aggregate: {
              totalSessionsReviewed: input.evidence.sourceSessionIds.length,
              matchingPattern: input.evidence.observedPatternCount,
              timeWindow: 0,
            },
          }
        : {}),
    },
    authorityLevel: 'stage_for_review',
    resolutionRoute: flagRoute,
    proposedAt: now,
    expiresAt,
    coachSessionId: args.context.runId,
  };

  await writeCoachJsonDoc(
    docRepo,
    dirRepo,
    `${proposalDirForRoute(flagRoute)}/${id}.json`,
    stagedChange as unknown as Record<string, unknown>,
    'json',
    spaceId,
    'create',
    'staged_change',
  );

  try {
    const { appendEntityEvent } = await import('@aflow/redis');
    await appendEntityEvent(args.redis, {
      tenantId: args.context.tenantId,
      spaceId,
      event: {
        eventId: randomUUID(),
        eventType: 'entity.coach.proposal',
        spaceId,
        tenantId: args.context.tenantId,
        timestamp: Date.now(),
        causedBySessionId: args.context.runId,
        causedByStepExecutionId: args.stepExecutionId,
        payload: {
          stagedChangeId: id,
          kind: 'pattern_flag',
          resolutionRoute: flagRoute,
          source: 'coach',
        },
        summary: `Coach flagged a cross-session pattern for review`,
      },
    });
  } catch {
    // Best-effort event emission
  }

  await emitStepSuccess(
    args,
    {
      flagId: id,
      status: 'flagged' as const,
    },
    startTime,
  );
}

// ============================================================================

/**
 * Stage a Coach-authored proposal to publish a freshly-generated draft
 * as a new version of a bundle-shipped artifact. Authority is ALWAYS
 * `require_operator` (every Coach proposal is, Plan 201 §4.2). The apply
 * handler (`applyArtifactUpdateOps`) does the publish SQL on operator
 * ratification.
 *
 * No workflow-archive check (artifacts aren't slug-targeted); no
 * learning-policy lookup (authority is fixed); no kind inference (the
 * single op maps to `artifact_update` kind).
 */
async function handleProposeArtifactUpdate(
  args: InlineHandlerArgs,
  input: LearnerProposeArtifactUpdateInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const { docRepo, dirRepo } = getCoachCrudRepos(args.context.tenantId);

  const now = new Date().toISOString();
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const updateOp: StagedChange['proposal']['ops'][number] = {
    op: 'update_artifact',
    artifactId: input.artifactId,
    draftId: input.draftId,
    diffSummary: input.diffSummary,
    ...(input.triggeringRunId ? { triggeringRunId: input.triggeringRunId } : {}),
  };

  // Authority is fixed at require_operator (see ratificationHelpers.ts).
  // Coach-confidence does NOT escalate to auto-apply for artifact_update
  // because rendered output is user-facing on every future render and
  // there's no automated regression layer for it yet.
  const route = resolveProposalRoute({ ops: [updateOp] });

  const stagedChange: StagedChange = {
    id,
    kind: 'artifact_update',
    source: 'coach',
    status: 'proposed',
    proposal: {
      summary: `Refresh artifact ${input.artifactId.slice(0, 8)}…: ${input.diffSummary.slice(0, 120)}`,
      rationale: input.diffSummary,
      // Confidence is informational here — authority is fixed. Default
      // to `medium` so the operator UI's confidence column has a value
      // (Coach can pass `high` in a future revision if it wants the
      // signal surfaced even though it doesn't affect routing).
      confidence: 'medium',
      ops: [updateOp],
    },
    evidence: {
      sourceSessionIds: input.evidence.sourceSessionIds,
      ...(input.evidence.reflectionRefs ? { reflectionRefs: input.evidence.reflectionRefs } : {}),
      ...(input.evidence.digestRef ? { digestRef: input.evidence.digestRef } : {}),
      ...(input.evidence.digestSha256 ? { digestSha256: input.evidence.digestSha256 } : {}),
      ...(input.evidence.digestCitations
        ? { digestCitations: input.evidence.digestCitations }
        : {}),
      ...(input.evidence.artifactRefs && input.evidence.artifactRefs.length > 0
        ? { artifactRefs: input.evidence.artifactRefs }
        : {}),
    },
    authorityLevel: 'require_operator',
    resolutionRoute: route,
    proposedAt: now,
    expiresAt,
    coachSessionId: args.context.runId,
  };

  await writeCoachJsonDoc(
    docRepo,
    dirRepo,
    `${proposalDirForRoute(route)}/${id}.json`,
    stagedChange as unknown as Record<string, unknown>,
    'json',
    spaceId,
    'create',
    'staged_change',
  );

  // Emit the coach.proposal entity event mirroring workflow_change's
  // emission — gives the operator UI / Helmsman the same surface signal.
  try {
    const { appendEntityEvent } = await import('@aflow/redis');
    await appendEntityEvent(args.redis, {
      tenantId: args.context.tenantId,
      spaceId,
      event: {
        eventId: randomUUID(),
        eventType: 'entity.coach.proposal',
        spaceId,
        tenantId: args.context.tenantId,
        timestamp: Date.now(),
        causedBySessionId: args.context.runId,
        summary: `Coach proposed artifact refresh ${id.slice(0, 8)} — ${input.diffSummary.slice(0, 100)}`,
        payload: {
          stagedChangeId: id,
          kind: 'artifact_update',
          confidence: 'medium',
          targetWorkflowSlug: null,
        },
      },
    });
  } catch (err) {
    // Same defensive emit pattern as workflow_change — non-fatal.
    const logger = await import('../../../../lib/orchestratorLogger.js');
    logger
      .getOrchestratorLogger()
      .warn(
        `[learner.propose.artifact_update] entity event emit failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
  }

  await emitStepSuccess(
    args,
    {
      stagedChangeId: id,
      status: 'proposed' as const,
    },
    startTime,
  );
}

// ============================================================================
// learner.propose.anomaly
// ============================================================================

async function handleProposeAnomaly(
  args: InlineHandlerArgs,
  input: LearnerProposeAnomalyInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const { docRepo, dirRepo } = getCoachCrudRepos(args.context.tenantId);

  const now = new Date().toISOString();
  const id = randomUUID();

  const anomalyReport: AnomalyReport = {
    id,
    kind: input.kind,
    severity: input.severity,
    summary: input.summary,
    detail: input.detail,
    ...(input.affectedWorkflowSlug ? { affectedWorkflowSlug: input.affectedWorkflowSlug } : {}),
    evidence: {
      sessionIds: input.evidence.sessionIds,
    },
    reportedAt: now,
    coachSessionId: args.context.runId,
    acknowledged: false,
  };

  await writeCoachJsonDoc(
    docRepo,
    dirRepo,
    `/coach/anomalies/${id}.json`,
    anomalyReport as unknown as Record<string, unknown>,
    'json',
    spaceId,
    'create',
    'anomaly_report',
  );

  // Emit entity event if severity >= warning
  if (input.severity === 'warning' || input.severity === 'critical') {
    try {
      const { appendEntityEvent } = await import('@aflow/redis');
      await appendEntityEvent(args.redis, {
        tenantId: args.context.tenantId,
        spaceId,
        event: {
          eventId: randomUUID(),
          eventType: 'entity.coach.anomaly',
          spaceId,
          tenantId: args.context.tenantId,
          timestamp: Date.now(),
          causedBySessionId: args.context.runId,
          causedByStepExecutionId: args.stepExecutionId,
          ...(input.affectedWorkflowSlug ? { workflowSlug: input.affectedWorkflowSlug } : {}),
          payload: {
            anomalyId: id,
            kind: input.kind,
            severity: input.severity,
            summary: input.summary,
          },
          summary: `Anomaly detected: ${input.summary} (${input.severity})`,
        },
      });
    } catch {
      // Best-effort event emission
    }
  }

  await emitStepSuccess(
    args,
    {
      anomalyId: id,
      severity: input.severity,
    },
    startTime,
  );
}

// ============================================================================

async function handleRecordObservation(
  args: InlineHandlerArgs,
  input: LearnerObservationRecordInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const db = getDatabase();

  // Resolve the workflow slug + run id this Coach session is reviewing.
  // The Coach is dispatched with traceId 'coach-{slug-prefix}-{run-prefix}'
  // and the prompt embeds the run/slug, but we read them off state vars where
  // available. Fall back to the trace id parsing for back-compat.
  const stateVars = (args.context as { stateVariables?: Record<string, unknown> }).stateVariables;
  const workflowSlug =
    typeof stateVars?.['workflow_slug'] === 'string' ? stateVars['workflow_slug'] : 'unknown';
  const runId = typeof stateVars?.['run_id'] === 'string' ? stateVars['run_id'] : 'unknown';

  try {
    const result = await persistObservation({
      db,
      tenantId: args.context.tenantId as string,
      spaceId,
      coachSessionId: args.context.runId,
      workflowSlug,
      runId,
      reason: input.reason,
      summary: input.summary,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.digestRef ? { digestRef: input.digestRef } : {}),
      ...(input.digestSha256 ? { digestSha256: input.digestSha256 } : {}),
    });

    await emitStepSuccess(
      args,
      {
        observationId: result.observationId,
        observationRef: result.observationRef,
      },
      startTime,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emitStepError(args, 'OBSERVATION_RECORD_FAILED', message, startTime, 'internal');
  }
}

// ============================================================================

function coachEvalResultFromRun(evaluationJson: unknown):
  | {
      verdict: 'pass' | 'fail' | 'partial' | 'error';
      scores: { overall: number };
      regressionDetected: boolean;
      faultLayer?: string;
    }
  | undefined {
  const summary = parseRunEvaluationEnvelope(evaluationJson)?.summary;
  if (!summary) return undefined;
  return {
    verdict: summary.verdict,
    scores: { overall: summary.scores.overall },
    regressionDetected: summary.regressionDetected,
    ...(summary.faultLayer !== null ? { faultLayer: summary.faultLayer } : {}),
  };
}

async function handleReviewRetrigger(
  args: InlineHandlerArgs,
  input: LearnerReviewRetriggerInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const tenantIdStr = args.context.tenantId as string;
  const db = getDatabase();

  // 1. Load the run record
  const run = await loadRunById(db, tenantIdStr, spaceId, input.runId);
  if (!run) {
    await emitStepError(
      args,
      'WORKFLOW_RUN_NOT_FOUND',
      `Run ${input.runId} not found in space ${spaceId}.`,
      startTime,
      'validation',
    );
    return;
  }

  if (run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled') {
    await emitStepError(
      args,
      'RUN_NOT_TERMINAL',
      `Run ${input.runId} is "${run.status}" — Coach review only re-runs against terminal runs (completed/failed/cancelled).`,
      startTime,
      'validation',
    );
    return;
  }

  const workflowSlug = input.workflowSlug ?? run.workflowSlug;
  if (input.workflowSlug && input.workflowSlug !== run.workflowSlug) {
    await emitStepError(
      args,
      'WORKFLOW_SLUG_MISMATCH',
      `Run ${input.runId} belongs to workflow "${run.workflowSlug}" but caller asserted "${input.workflowSlug}".`,
      startTime,
      'validation',
    );
    return;
  }

  // 2. Resolve directives (best-effort)
  let parsedDirectives: EntityDirectives | undefined;
  try {
    const { spaces, withTenantSchema } = await import('@aflow/database');
    const { eq: eqOp } = await import('drizzle-orm');
    const tenantCtx = createTenantContext(args.context.tenantId);
    const spaceRows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select({ directives: spaces.directives })
        .from(spaces)
        .where(eqOp(spaces.id, spaceId))
        .limit(1),
    );
    if (spaceRows[0]?.directives) {
      parsedDirectives = EntityDirectivesSchema.parse(spaceRows[0].directives);
    }
  } catch {
    // Fall through with undefined directives — Coach uses defaults.
  }

  // 3. Stats + (best-effort) eval result reconstruction from the persisted run
  const stats = await getRunStatistics(db, tenantIdStr, spaceId, workflowSlug, {
    windowDays: 36500,
  });

  const coachEvalResult = coachEvalResultFromRun(run.evaluationJson);

  // 4. Dispatch Coach review with force=true (skip gate + rate cap, fresh idempotency key).
  const coachSessionId = await triggerCoachReview({
    tenantId: tenantIdStr,
    spaceId,
    workflowSlug,
    runId: input.runId,
    totalRuns: stats.totalRuns,
    ...(coachEvalResult ? { evalResult: coachEvalResult } : {}),
    ...(parsedDirectives ? { directives: parsedDirectives } : {}),
    db,
    redis: args.redis,
    payloadStore: args.payloadStore,
    activatedByPerson: attendedAsActingRun(
      await getSessionState(args.redis, tenantIdStr, args.context.runId),
    ),
    force: true,
  });

  if (!coachSessionId) {
    await emitStepSuccess(
      args,
      {
        coachSessionId: null,
        workflowSlug,
        status: 'skipped',
        reason: 'Coach trigger returned null (likely no Coach agent registered for this space).',
      },
      startTime,
    );
    return;
  }

  await emitStepSuccess(
    args,
    {
      coachSessionId,
      workflowSlug,
      status: 'dispatched',
      reason: 'Coach review re-dispatched with manual retrigger (gate + rate cap bypassed).',
    },
    startTime,
  );
}

// ============================================================================

async function handleReviewRequest(
  args: InlineHandlerArgs,
  input: LearnerReviewRequestInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const tenantIdStr = args.context.tenantId as string;
  const db = getDatabase();

  const runIdInput = input.runId ?? undefined;
  const skillSlugInput = input.skillSlug ?? undefined;
  const taskIdInput = input.taskId ?? undefined;
  const focusAreasInput = input.focusAreas ?? [];
  const campaignIdInput = input.campaignId ?? undefined;

  if (campaignIdInput) {
    await handleCampaignSynthesisRequest(args, input, campaignIdInput, startTime);
    return;
  }

  // Resolve the workflow slug from the run record when the caller only
  // passed runId. The Coach gate consumes a workflowSlug downstream so
  // we have to settle on one before dispatching.
  let workflowSlug = skillSlugInput;
  let resolvedRunId = runIdInput;
  if (resolvedRunId) {
    const run = await loadRunById(db, tenantIdStr, spaceId, resolvedRunId);
    if (!run) {
      await emitStepError(
        args,
        'WORKFLOW_RUN_NOT_FOUND',
        `Run ${resolvedRunId} not found in space ${spaceId}.`,
        startTime,
        'validation',
      );
      return;
    }
    if (run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled') {
      await emitStepError(
        args,
        'RUN_NOT_TERMINAL',
        `Run ${resolvedRunId} is "${run.status}" — Coach review only runs against terminal runs (completed/failed/cancelled).`,
        startTime,
        'validation',
      );
      return;
    }
    if (skillSlugInput && skillSlugInput !== run.workflowSlug) {
      await emitStepError(
        args,
        'WORKFLOW_SLUG_MISMATCH',
        `Run ${resolvedRunId} belongs to workflow "${run.workflowSlug}" but caller asserted "${skillSlugInput}".`,
        startTime,
        'validation',
      );
      return;
    }
    workflowSlug = run.workflowSlug;
  }

  if (!workflowSlug) {
    await emitStepError(
      args,
      'SKILL_SLUG_UNRESOLVED',
      'learner.review.request requires either skillSlug or a runId that resolves to one.',
      startTime,
      'validation',
    );
    return;
  }

  if (!resolvedRunId) {
    const recent = await listRecentRuns(db, tenantIdStr, spaceId, workflowSlug, { limit: 20 });
    const mostRecentTerminal = recent.find(
      (r) => r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled',
    );
    if (!mostRecentTerminal) {
      await emitStepError(
        args,
        'NO_TERMINAL_RUN_FOR_SKILL',
        `Cannot review skill "${workflowSlug}" without a runId — no terminal run found in space ${spaceId}. Run the skill once before requesting a Coach review, or pass an explicit runId.`,
        startTime,
        'validation',
      );
      return;
    }
    resolvedRunId = mostRecentTerminal.runId;
  }

  // Resolve directives (best-effort) so the gate's mode × posture policy
  // lookup has the operator-tuned matrix to consult.
  let parsedDirectives: EntityDirectives | undefined;
  try {
    const { spaces, withTenantSchema } = await import('@aflow/database');
    const { eq: eqOp } = await import('drizzle-orm');
    const tenantCtx = createTenantContext(args.context.tenantId);
    const spaceRows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select({ directives: spaces.directives })
        .from(spaces)
        .where(eqOp(spaces.id, spaceId))
        .limit(1),
    );
    if (spaceRows[0]?.directives) {
      parsedDirectives = EntityDirectivesSchema.parse(spaceRows[0].directives);
    }
  } catch {
    // Fall through — gate uses schema defaults.
  }

  // Run statistics feed the existing gate (maturity / score floor).
  const stats = await getRunStatistics(db, tenantIdStr, spaceId, workflowSlug, {
    windowDays: 36500,
  });

  // Reconstruct an evalResult shim from the run record (mirrors retrigger).
  let coachEvalResult: ReturnType<typeof coachEvalResultFromRun>;
  if (resolvedRunId) {
    const run = await loadRunById(db, tenantIdStr, spaceId, resolvedRunId);
    coachEvalResult = coachEvalResultFromRun(run?.evaluationJson);
  }

  const triggerKind =
    input.requestedByKind === 'helmsman'
      ? 'helmsman_requested_review'
      : 'operator_requested_review';

  // Rate-capped like the automatic triggers (no force), but dispatched with
  // a fresh idempotency key: the target run — by default the most recent
  // terminal one — has usually had its post-run review claim the plain run
  // key already, and an explicit request must not dedupe against it. The
  // `reviewContextOverrides` carry the kind + rationale + focus areas into
  // the persisted CoachReviewContext.
  const coachSessionId = await triggerCoachReview({
    tenantId: tenantIdStr,
    spaceId,
    workflowSlug,
    runId: resolvedRunId ?? '',
    totalRuns: stats.totalRuns,
    ...(coachEvalResult ? { evalResult: coachEvalResult } : {}),
    ...(parsedDirectives ? { directives: parsedDirectives } : {}),
    db,
    redis: args.redis,
    payloadStore: args.payloadStore,
    activatedByPerson: attendedAsActingRun(
      await getSessionState(args.redis, tenantIdStr, args.context.runId),
    ),
    freshDispatch: true,
    reviewContextOverrides: {
      triggerKind,
      requestedBy: input.requestedByKind === 'helmsman' ? 'helmsman' : 'operator',
      rationale: input.rationale,
      ...(focusAreasInput.length > 0 ? { focusAreas: focusAreasInput } : {}),
      ...(taskIdInput ? { taskId: taskIdInput } : {}),
    },
  });

  if (!coachSessionId) {
    await emitStepSuccess(
      args,
      {
        coachSessionId: null,
        skillSlug: workflowSlug,
        status: 'skipped',
        reason:
          "Coach dispatch suppressed (rate cap or review-context persistence failure) — the skill's coach activity records the cause.",
        contextId: null,
      },
      startTime,
    );
    return;
  }

  await emitStepSuccess(
    args,
    {
      coachSessionId,
      skillSlug: workflowSlug,
      status: 'dispatched',
      reason: `Coach review dispatched (${triggerKind}).`,
      // The contextId lives inside the persisted /coach/contexts/{coachSessionId}.json
      // document — clients that need it should load by coachSessionId.
      contextId: null,
    },
    startTime,
  );
}

/**
 * `campaignId` routes learner.review.request through the campaign-end
 * synthesis flow — the summon (and re-summon) affordance for a campaign that
 * already ended. The dispatch uses a fresh idempotency key so a re-summon
 * never dedupes against the campaign-keyed synthesis the end transition
 * already produced; the per-skill rate cap still applies (the op is
 * agent-callable, so repeat summons stay bounded).
 */
async function handleCampaignSynthesisRequest(
  args: InlineHandlerArgs,
  input: LearnerReviewRequestInput,
  campaignId: string,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const tenantIdStr = args.context.tenantId as string;
  const db = getDatabase();

  const campaign = await getCampaignById(db, tenantIdStr, campaignId);
  if (campaign?.spaceId !== spaceId) {
    await emitStepError(
      args,
      'CAMPAIGN_NOT_FOUND',
      `Campaign ${campaignId} not found in space ${spaceId}.`,
      startTime,
      'validation',
    );
    return;
  }
  if (campaign.status !== 'ended') {
    await emitStepError(
      args,
      'CAMPAIGN_STILL_ACTIVE',
      `Campaign ${campaignId} is still active — the campaign-end synthesis reviews an ENDED campaign. End it first (workflow.campaign.end) or wait for it to end.`,
      startTime,
      'validation',
    );
    return;
  }
  const skillSlugInput = input.skillSlug ?? undefined;
  if (skillSlugInput && skillSlugInput !== campaign.workflowSlug) {
    await emitStepError(
      args,
      'WORKFLOW_SLUG_MISMATCH',
      `Campaign ${campaignId} belongs to workflow "${campaign.workflowSlug}" but caller asserted "${skillSlugInput}".`,
      startTime,
      'validation',
    );
    return;
  }

  const coachSessionId = await maybeTriggerCampaignEndReview({
    db,
    redis: args.redis,
    payloadStore: args.payloadStore,
    tenantId: tenantIdStr,
    spaceId,
    workflowSlug: campaign.workflowSlug,
    campaignId,
    reason: campaign.endedReason ?? 'explicit',
    activatedByPerson: attendedAsActingRun(
      await getSessionState(args.redis, tenantIdStr, args.context.runId),
    ),
    requestedBy: input.requestedByKind === 'helmsman' ? 'helmsman' : 'operator',
    rationale: input.rationale,
    freshDispatch: true,
  });

  if (!coachSessionId) {
    await emitStepSuccess(
      args,
      {
        coachSessionId: null,
        skillSlug: campaign.workflowSlug,
        status: 'skipped',
        reason:
          'Campaign-end synthesis not dispatched — the campaign has no runs to synthesize, the per-skill rate cap suppressed it, no Coach agent is registered, or the dispatch failed (see orchestrator logs).',
        contextId: null,
      },
      startTime,
    );
    return;
  }

  await emitStepSuccess(
    args,
    {
      coachSessionId,
      skillSlug: campaign.workflowSlug,
      status: 'dispatched',
      reason: `Campaign-end synthesis dispatched for campaign ${campaignId} (campaign_end_review).`,
      contextId: null,
    },
    startTime,
  );
}

// ============================================================================

async function handleResolveLearning(
  args: InlineHandlerArgs,
  input: LearnerLearningResolveInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const db = getDatabase();

  // Attribute the resolution to the operator who initiated the session; the
  // session id is the fallback when hot state is gone (terminal flush).
  let resolvedBy: string = args.context.runId;
  try {
    const { getSessionStateSafe } = await import('@aflow/redis');
    const hot = await getSessionStateSafe(args.redis, args.context.tenantId, args.context.runId);
    if (hot.ok && hot.state.createdBy) {
      resolvedBy = hot.state.createdBy;
    }
  } catch {
    /* fall back to the session id */
  }

  const result = await resolveLearning({
    tenantId: args.context.tenantId as string,
    spaceId,
    learningId: input.learningId,
    action: input.action,
    operatorUserId: resolvedBy,
    db,
  });

  if (!result.ok) {
    await emitStepError(
      args,
      result.status === 404 ? 'LEARNING_NOT_FOUND' : 'LEARNING_NOT_RESOLVABLE',
      result.detail,
      startTime,
      'validation',
      false,
    );
    return;
  }

  await emitStepSuccess(
    args,
    {
      learningId: input.learningId,
      status: input.action === 'ratify' ? ('ratified' as const) : ('rejected' as const),
    },
    startTime,
  );
}

// ============================================================================

async function handleReviewFinalize(
  args: InlineHandlerArgs,
  input: LearnerReviewFinalizeInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const coachSessionId = args.context.runId;
  const tenantIdStr = args.context.tenantId as string;
  const { db, docRepo } = getCoachCrudRepos(args.context.tenantId);

  // 1. Cross-check proposalIds: every cited proposal must exist under
  //    /coach/staged/{id}.json OR /coach/platform-issues/{id}.json
  const PROPOSAL_DIRS = ['/coach/staged', '/coach/platform-issues'] as const;
  async function findProposal(
    proposalId: string,
  ): Promise<Awaited<ReturnType<typeof docRepo.getByPath>> | null> {
    for (const dir of PROPOSAL_DIRS) {
      try {
        const doc = await docRepo.getByPath(`${dir}/${proposalId}.json`, spaceId);
        if (doc) return doc;
      } catch {
        /* try next dir */
      }
    }
    return null;
  }
  const missingProposals: string[] = [];
  const wrongSessionProposals: Array<{ id: string; foundCoachSessionId: string | null }> = [];
  const sessionProposals: StagedChange[] = [];
  // Platform-issue aggregation — a propose in THIS session may have been
  // absorbed into an open doc founded by an EARLIER Coach session (the
  // propose handler returned the existing stagedChangeId and recorded it in
  // this session's ledger). Citing that id at finalize is legitimate; the
  // ledger membership is the ownership proof.
  let ledgerIdSet = new Set<string>();
  try {
    ledgerIdSet = new Set(
      await args.redis.smembers(coachProposalsLedgerKey(tenantIdStr, coachSessionId)),
    );
  } catch {
    /* best-effort — only aggregated citations need the ledger */
  }
  for (const proposalId of input.proposalIds) {
    const doc = await findProposal(proposalId);
    if (!doc) {
      missingProposals.push(proposalId);
      continue;
    }
    const sc = parseStagedChange(doc.inlineContent);
    if (!sc) {
      missingProposals.push(proposalId);
      continue;
    }
    if (sc.coachSessionId !== coachSessionId && !ledgerIdSet.has(proposalId)) {
      wrongSessionProposals.push({
        id: proposalId,
        foundCoachSessionId: (sc.coachSessionId as string | null | undefined) ?? null,
      });
      continue;
    }
    sessionProposals.push(sc);
  }

  // The coherence checks below must see EVERY
  // proposal this session created, not just the cited ones: omitting the
  // superseded refinement from proposalIds must not dodge the check. The
  // session-proposal ledger (written at propose time) supplies the full set.
  // Aggregated platform issues (founded by an earlier session, re-raised by
  // this one) participate too — they still supersede refinements.
  {
    const citedIds = new Set(input.proposalIds);
    for (const ledgerId of ledgerIdSet) {
      if (citedIds.has(ledgerId)) continue;
      const doc = await findProposal(ledgerId);
      const sc = doc ? parseStagedChange(doc.inlineContent) : null;
      if (sc) {
        sessionProposals.push(sc);
      }
    }
  }

  // 2. Cross-check observationId (if present): must exist under
  //    /coach/observations/{id}.json AND have coachSessionId === thisSession.
  let observationMissing = false;
  let observationWrongSession: { id: string; foundCoachSessionId: string | null } | null = null;
  if (input.observationId) {
    const path = `/coach/observations/${input.observationId}.json`;
    let doc: Awaited<ReturnType<typeof docRepo.getByPath>> | null;
    try {
      doc = await docRepo.getByPath(path, spaceId);
    } catch {
      doc = null;
    }
    if (!doc) {
      observationMissing = true;
    } else {
      const obs = parseObservation(doc.inlineContent);
      if (!obs) {
        observationMissing = true;
      } else if (obs.coachSessionId !== coachSessionId) {
        observationWrongSession = {
          id: input.observationId,
          foundCoachSessionId: obs.coachSessionId,
        };
      }
    }
  }

  const missingLearnings: string[] = [];
  const wrongSessionLearnings: Array<{ id: string; foundCoachSessionId: string | null }> = [];
  for (const learningId of input.learningIds) {
    let learning: CoachLearning | null = null;
    try {
      learning = await getCoachLearningById(db, tenantIdStr, spaceId, learningId);
    } catch {
      learning = null;
    }
    if (!learning) {
      missingLearnings.push(learningId);
      continue;
    }
    if (learning.coachSessionId !== coachSessionId) {
      wrongSessionLearnings.push({ id: learningId, foundCoachSessionId: learning.coachSessionId });
    }
  }

  // 3. Build feedback if any check failed; emit step error so onFailure routes
  //    back to the review step. The agent gets state.outcome_feedback set.
  const issues: string[] = [];
  if (missingProposals.length > 0) {
    issues.push(
      `proposalIds reference docs that do not exist or are unreadable: ${missingProposals.join(', ')}`,
    );
  }
  if (wrongSessionProposals.length > 0) {
    issues.push(
      `proposalIds reference docs from a different Coach session (must be from this session ${coachSessionId}): ${wrongSessionProposals
        .map((p) => `${p.id} (found session=${p.foundCoachSessionId ?? 'null'})`)
        .join(', ')}`,
    );
  }
  if (observationMissing) {
    issues.push(
      `observationId ${String(input.observationId)} does not resolve to a /coach/observations/ doc.`,
    );
  }
  if (observationWrongSession) {
    issues.push(
      `observationId ${observationWrongSession.id} belongs to Coach session ${String(observationWrongSession.foundCoachSessionId)}, not this session ${coachSessionId}.`,
    );
  }
  if (missingLearnings.length > 0) {
    issues.push(
      `learningIds reference docs that do not exist or are unreadable: ${missingLearnings.join(', ')}`,
    );
  }
  if (wrongSessionLearnings.length > 0) {
    issues.push(
      `learningIds reference docs from a different Coach session (must be from this session ${coachSessionId}): ${wrongSessionLearnings
        .map((l) => `${l.id} (found session=${l.foundCoachSessionId ?? 'null'})`)
        .join(', ')}`,
    );
  }

  if (input.proposalIds.length > 0) {
    let reads: string[] = [];
    try {
      const ledgerKey = `coach:inspect:ledger:${tenantIdStr}:${coachSessionId}`;
      reads = await args.redis.smembers(ledgerKey);
    } catch {
      reads = [];
    }
    if (reads.length > 0) {
      const ledgerSet = new Set(reads);
      let proposalsWithVerifiedRefs = 0;
      const hallucinatedRefs: string[] = [];
      for (const proposalId of input.proposalIds) {
        // Reuse the same dual-directory lookup as the proposalIds
        // existence check above so platform_issue proposals stored in
        // /coach/platform-issues/ are eligible to satisfy the
        // artifactRefs requirement when their evidence cites a slice.
        const doc = await findProposal(proposalId);
        if (!doc) continue;
        const sc = parseStagedChange(doc.inlineContent);
        const refs = sc?.evidence.artifactRefs ?? [];
        if (refs.length === 0) continue;
        let hasVerified = false;
        for (const r of refs) {
          const member = `${r.targetKind}|${r.targetId}|${r.path}`;
          if (ledgerSet.has(member)) {
            hasVerified = true;
          } else {
            hallucinatedRefs.push(`${proposalId}: ${member}`);
          }
        }
        if (hasVerified) proposalsWithVerifiedRefs += 1;
      }
      if (proposalsWithVerifiedRefs === 0) {
        const hallucinatedDetail =
          hallucinatedRefs.length > 0
            ? ` The following cited refs were NOT in the inspect ledger: ${hallucinatedRefs.slice(0, 10).join('; ')}.`
            : '';
        issues.push(
          `This Coach session called artifact.inspect.read ${String(reads.length)} time(s) but none of the ${String(input.proposalIds.length)} proposalIds cite an artifactRef that matches an actual ledger entry.${hallucinatedDetail} If the inspections materially shaped a proposal, the proposal MUST cite the (targetKind, targetId, path) triple under evidence.artifactRefs using the exact values from a read this session performed. If the reads were exploratory and did not shape any proposal, regenerate without calling artifact.inspect.read.`,
        );
      }
    }
  }

  // 4b. Supersession coherence. If this session filed a
  //     platform_issue for a failing task, an earlier still-open refinement
  //     approximating a fix for the SAME task is superseded: it cannot work
  //     (the gap is the platform's) and standing it confuses the operator.
  //     Structural match only: same targetSlug + a shared cited taskId.
  const superseded = findSupersededRefinements(
    sessionProposals.map((sc) => ({
      id: sc.id,
      kind: sc.kind,
      status: sc.status,
      targetSlug: sc.targetWorkflowSlug ?? '',
      citedTaskIds: (sc.evidence.digestCitations ?? [])
        .map((c) => c.taskId)
        .filter((t): t is string => typeof t === 'string' && t.length > 0),
    })),
  );
  for (const s of superseded) {
    issues.push(
      `Proposal ${s.refinementId} (workflow_refinement on "${s.targetSlug}") is superseded by platform_issue ${s.platformIssueId} — both cite task(s): ${s.sharedTaskIds.join(', ')}. A workflow refinement cannot fix a platform gap. Withdraw it via learner.propose.withdraw (reason: superseded by the platform_issue), then finalize again. If it genuinely addresses a DIFFERENT defect, its evidence citations must not overlap the platform issue's.`,
    );
  }

  try {
    const reviewContext = await loadCoachReviewContext({
      db: getDatabase(),
      tenantId: tenantIdStr,
      spaceId,
      coachSessionId,
    });
    if (reviewContext) {
      const hasCorrectness = input.facets.some((f) => f.facet === 'correctness');
      const hasTrajectory = input.facets.some((f) => f.facet === 'trajectory');
      // A campaign-end review anchors on the campaign's last run without
      // diagnosing it — the mandatory correctness facet applies to genuine
      // run reviews only.
      const isPerformanceRunReview =
        reviewContext.target.runId !== undefined &&
        reviewContext.trigger.kind !== 'campaign_end_review' &&
        (reviewContext.validityDiagnostics?.length ?? 0) === 0;
      if (isPerformanceRunReview && !hasCorrectness) {
        issues.push(
          "facets is missing the 'correctness' section. Every run review carries a correctness facet: " +
            '{ facet: "correctness", summary: <what the per-run evidence showed>, proposalIds/learningIds: <the ids that facet surfaced> }.',
        );
      }
      const trajectoryLegal =
        reviewContext.breadthEvidence?.mode === 'optimization' ||
        reviewContext.trigger.kind === 'iteration_batch_review' ||
        reviewContext.trigger.kind === 'campaign_end_review' ||
        reviewContext.trigger.kind === 'trajectory_signal';
      if (hasTrajectory && !trajectoryLegal) {
        issues.push(
          "facets includes a 'trajectory' section, but this review carries no campaign trajectory " +
            '(the brief had no campaign-trajectory block). The trajectory facet exists only at campaign ' +
            'boundaries — drop it and fold any cross-run observation into the correctness summary or a learning.',
        );
      }
    }
  } catch {
    // Context load failure — facet enforcement degrades gracefully.
  }

  if (issues.length > 0) {
    const feedback = [
      '## VALIDATION FEEDBACK FROM PRIOR ATTEMPT',
      '',
      'Your previous structured outcome failed cross-check. The validator found:',
      ...issues.map((s) => `  - ${s}`),
      '',
      'On this retry: actually call learner.propose.workflow_change for each issue, and learner.observation.record for any observation. Then call complete with the structured outcome containing the IDs those tools returned. Do not invent or copy IDs from prior runs.',
    ].join('\n');

    // Write the feedback into state so the next iteration of `review` sees it
    // through ${state.outcome_feedback} interpolation in its prompt.
    try {
      const { getSessionState, updateSessionState } = await import('@aflow/redis');
      const { writeInlineVar } = await import('../../helpers/runtimeState.js');
      const state = await getSessionState(args.redis, tenantIdStr, coachSessionId);
      if (state?.runtimeState) {
        const newVars = { ...state.runtimeState.variables };
        writeInlineVar(newVars, 'outcome_feedback', feedback, {
          nowMs: Date.now(),
          stepExecutionId: args.stepExecutionId,
          stepId: args.stepDef.stepId,
        });
        await updateSessionState(args.redis, tenantIdStr, coachSessionId, {
          runtimeState: {
            ...state.runtimeState,
            variables: newVars,
            version: state.runtimeState.version + 1,
            updatedAtMs: Date.now(),
          },
        });
      }
    } catch {
      // Best-effort feedback write — the step error message below is the fallback.
    }

    await emitStepError(args, 'COACH_REVIEW_OUTCOME_INVALID', feedback, startTime, 'validation');
    return;
  }

  // 4. All checks pass — emit the review-completed event and return success.
  try {
    const { appendEntityEvent } = await import('@aflow/redis');
    await appendEntityEvent(args.redis, {
      tenantId: tenantIdStr,
      spaceId,
      event: {
        eventId: randomUUID(),
        eventType: 'entity.coach.completed',
        spaceId,
        tenantId: tenantIdStr,
        timestamp: Date.now(),
        causedBySessionId: coachSessionId,
        operatingMode: 'supervisory',
        payload: {
          outcome: input.outcome,
          proposalCount: input.proposalIds.length,
          hasObservation: input.observationId !== undefined,
          learningCount: input.learningIds.length,
          rationale: input.rationale.slice(0, 500),
        },
        summary: `Coach review completed: outcome=${input.outcome} proposals=${String(input.proposalIds.length)} learnings=${String(input.learningIds.length)}`,
      },
    });
  } catch {
    // Best-effort event emission
  }

  try {
    const { loadCoachReviewContext, recordCoachActivity, readPreviewFailedCounter } =
      await import('@aflow/cybernetic-runtime');
    const { getDatabase } = await import('@aflow/database');
    const { coachReviewContextDocPath, coachReviewFactsDocPath } = await import('@aflow/schemas');
    const db = getDatabase();
    const reviewContext = await loadCoachReviewContext({
      db,
      tenantId: tenantIdStr,
      spaceId,
      coachSessionId,
    });
    const previewFailedCount = await readPreviewFailedCounter(
      args.redis,
      tenantIdStr,
      coachSessionId,
    );
    const status =
      previewFailedCount > 0
        ? `completed:preview_failed:${String(previewFailedCount)}`
        : 'completed';
    await recordCoachActivity(
      { tenantId: tenantIdStr, db },
      {
        spaceId,
        coachSessionId,
        ...(reviewContext?.target.skillSlug && { skillSlug: reviewContext.target.skillSlug }),
        triggerKind: reviewContext?.trigger.kind ?? 'unknown',
        ...(reviewContext?.trigger.rationale && {
          triggerCause: reviewContext.trigger.rationale,
        }),
        outcome: input.outcome,
        status,
        proposalCount: input.proposalIds.length,
        observationCount: input.observationId ? 1 : 0,
        learningCount: input.learningIds.length,
        previewFailedCount,
        bypassesGate: reviewContext?.trigger.bypassesGate ?? false,
        durationMs: Date.now() - startTime,
        contextDocPath: coachReviewContextDocPath(coachSessionId),
        factsDocPath: coachReviewFactsDocPath(coachSessionId),
        rationale: input.rationale.slice(0, 1000),
      },
    );
  } catch (err) {
    // Best-effort — the durable activity row must never fail the review,
    // but a silent miss blinds the operator audit trail, so log the cause.
    const logger = await import('../../../../lib/orchestratorLogger.js');
    logger
      .getOrchestratorLogger()
      .error(
        `[learner.review.finalize] coach_activity write failed for coachSessionId=${coachSessionId}`,
        err instanceof Error ? err : new Error(String(err)),
        { coachSessionId, spaceId },
      );
  }

  await emitStepSuccess(
    args,
    {
      finalized: true,
      outcome: input.outcome,
      proposalCount: input.proposalIds.length,
      hasObservation: input.observationId !== undefined,
      learningCount: input.learningIds.length,
    },
    startTime,
  );
}

function parseObservation(content: string | null | undefined): CoachObservation | null {
  if (!content) return null;
  try {
    return JSON.parse(content) as CoachObservation;
  } catch {
    return null;
  }
}
