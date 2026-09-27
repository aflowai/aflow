import { randomUUID } from 'node:crypto';
import { CoachLearningSchema } from '@aflow/schemas';
import type { LearnerLearningRecordInput, CoachLearning } from '@aflow/schemas';
import { loadCoachReviewContext, insertCoachLearning } from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { getCoachCrudRepos } from './coachCrudMemory.js';

export interface PersistCoachLearningParams {
  spaceId: string;
  scope: CoachLearning['scope'];
  kind: CoachLearning['kind'];
  appliesTo?: NonNullable<CoachLearning['appliesTo']>;
  statement: string;
  detailRef?: string;
  evidence: CoachLearning['evidence'];
  confidence: CoachLearning['confidence'];
  supersedes?: string[];
  runId?: string;
  promotedFrom?: NonNullable<CoachLearning['promotedFrom']>;
  authorityLevel: CoachLearning['authorityLevel'];
  status: CoachLearning['status'];
}

export type PersistCoachLearningResult =
  { ok: true; learningId: string } | { ok: false; error: string };

export async function persistCoachLearning(
  args: InlineHandlerArgs,
  params: PersistCoachLearningParams,
): Promise<PersistCoachLearningResult> {
  const { db } = getCoachCrudRepos(args.context.tenantId);
  const { spaceId } = params;

  const learningId = randomUUID();
  const candidate: CoachLearning = {
    learningId,
    coachSessionId: args.context.runId,
    ...(params.runId ? { runId: params.runId } : {}),
    scope: params.scope,
    kind: params.kind,
    ...(params.appliesTo ? { appliesTo: params.appliesTo } : {}),
    statement: params.statement,
    ...(params.detailRef ? { detailRef: params.detailRef } : {}),
    evidence: params.evidence,
    confidence: params.confidence,
    supersedes: params.supersedes ?? [],
    authorityLevel: params.authorityLevel,
    status: params.status,
    ...(params.promotedFrom ? { promotedFrom: params.promotedFrom } : {}),
    createdAt: new Date().toISOString(),
  };

  const parsed = CoachLearningSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }

  await insertCoachLearning(db, args.context.tenantId as string, {
    spaceId,
    learning: parsed.data,
  });

  try {
    const { appendEntityEvent } = await import('@aflow/redis');
    await appendEntityEvent(args.redis, {
      tenantId: args.context.tenantId,
      spaceId,
      event: {
        eventId: randomUUID(),
        eventType: 'entity.coach.promotion',
        spaceId,
        tenantId: args.context.tenantId,
        timestamp: Date.now(),
        causedBySessionId: args.context.runId,
        causedByStepExecutionId: args.stepExecutionId,
        operatingMode: 'supervisory',
        payload: {
          learningId,
          scope: parsed.data.scope.kind,
          kind: parsed.data.kind,
          authorityLevel: parsed.data.authorityLevel,
          status: parsed.data.status,
          ...(parsed.data.scope.kind === 'campaign'
            ? { campaignId: parsed.data.scope.campaignId, skillSlug: parsed.data.scope.skillSlug }
            : parsed.data.scope.kind === 'skill'
              ? { skillSlug: parsed.data.scope.skillSlug }
              : {}),
        },
        summary: `Coach learning recorded (${parsed.data.kind}, ${parsed.data.scope.kind}-scope, status=${parsed.data.status})`,
      },
    });
  } catch {
    // best-effort
  }

  return { ok: true, learningId };
}

export async function handleRecordLearning(
  args: InlineHandlerArgs,
  input: LearnerLearningRecordInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const { db } = getCoachCrudRepos(args.context.tenantId);

  if (input.scope.kind === 'campaign') {
    const reviewContext = await loadCoachReviewContext({
      db,
      tenantId: args.context.tenantId as string,
      spaceId,
      coachSessionId: args.context.runId,
    });
    if (!reviewContext) {
      await emitStepError(
        args,
        'CAMPAIGN_LEARNING_REQUIRES_REVIEW_CONTEXT',
        'campaign-scope learnings can only be auto-recorded inside a Coach review (Plan 163 §6.1 CoachReviewContext missing).',
        startTime,
        'validation',
      );
      return;
    }
    if (
      reviewContext.target.skillSlug &&
      reviewContext.target.skillSlug !== input.scope.skillSlug
    ) {
      await emitStepError(
        args,
        'CAMPAIGN_LEARNING_SKILL_MISMATCH',
        `campaign-scope learning skillSlug='${input.scope.skillSlug}' does not match the review's target skill '${reviewContext.target.skillSlug}'.`,
        startTime,
        'validation',
      );
      return;
    }
    const allowedTriggers = new Set([
      'iteration_batch_review',
      'campaign_end_review',
      'training_review',
      'regression_review',
      'eval_signal',
      'maturity_signal',
      'operator_requested_review',
      'trajectory_signal',
    ]);
    if (!allowedTriggers.has(reviewContext.trigger.kind)) {
      await emitStepError(
        args,
        'CAMPAIGN_LEARNING_TRIGGER_DISALLOWED',
        `campaign-scope auto-record is not allowed for trigger.kind='${reviewContext.trigger.kind}'. Use 'skill' or 'space' scope (which stages for review) instead.`,
        startTime,
        'validation',
      );
      return;
    }
  }

  const authorityLevel: 'auto_record' | 'stage_for_review' =
    input.scope.kind === 'campaign' ? 'auto_record' : 'stage_for_review';
  const status: 'auto_recorded' | 'proposed' =
    authorityLevel === 'auto_record' ? 'auto_recorded' : 'proposed';

  const persisted = await persistCoachLearning(args, {
    spaceId,
    scope: input.scope,
    kind: input.kind,
    ...(input.appliesTo ? { appliesTo: input.appliesTo } : {}),
    statement: input.statement,
    evidence: input.evidence,
    confidence: input.confidence,
    supersedes: input.supersedes ?? [],
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.promotedFrom ? { promotedFrom: input.promotedFrom } : {}),
    authorityLevel,
    status,
  });
  if (!persisted.ok) {
    await emitStepError(
      args,
      'LEARNING_VALIDATION_FAILED',
      persisted.error,
      startTime,
      'validation',
    );
    return;
  }

  if (input.promotedFrom) {
    try {
      const { resolveCandidate } = await import('@aflow/cybernetic-runtime');
      await resolveCandidate(db, args.context.tenantId as string, {
        entryId: input.promotedFrom.candidateLedgerEntryId,
        status: 'reviewed-promoted',
        spaceId,
        coachSessionId: args.context.runId,
      });
    } catch {
      // best-effort — candidate resolution failure does not invalidate the learning.
    }
  }

  await emitStepSuccess(
    args,
    { learningId: persisted.learningId, authorityLevel, status },
    startTime,
  );
}
