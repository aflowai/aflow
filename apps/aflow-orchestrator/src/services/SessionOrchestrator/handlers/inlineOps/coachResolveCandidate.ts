import { getDatabase } from '@aflow/database';
import { COACH_LEARNING_STATEMENT_MAX_CHARS } from '@aflow/schemas';
import type {
  CoachLearningKind,
  LearnerLearningResolveCandidateInput,
  LearnerLearningResolveCandidateOutput,
  WorkflowLearning,
  WorkflowLearningKind,
} from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { persistCoachLearning } from './coachRecordLearning.js';

const COACH_KIND_BY_LEARNING_KIND: Record<WorkflowLearningKind, CoachLearningKind> = {
  search_heuristic: 'heuristic',
  constraint: 'constraint',
  observation: 'observation',
  next_direction: 'heuristic',
  objective_semantics: 'observation',
  eval_semantics: 'observation',
  workflow_structure: 'observation',
  capability_scope: 'constraint',
  doctrine: 'heuristic',
};

function deriveStatement(learning: WorkflowLearning): string {
  const statement = learning.recommendation
    ? `${learning.observation} → ${learning.recommendation}`
    : learning.observation;
  return statement.slice(0, COACH_LEARNING_STATEMENT_MAX_CHARS);
}

export async function handleResolveCandidate(
  args: InlineHandlerArgs,
  input: LearnerLearningResolveCandidateInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const db = getDatabase();
  const { resolveCandidateByNaturalKey, findCoachLearningByPromotedFromEntry } =
    await import('@aflow/cybernetic-runtime');

  const results: LearnerLearningResolveCandidateOutput['results'] = [];
  for (const resolution of input.resolutions) {
    const outcome = await resolveCandidateByNaturalKey(db, args.context.tenantId as string, {
      runId: resolution.runId,
      learningId: resolution.learningId,
      status: resolution.resolution,
      spaceId,
      coachSessionId: args.context.runId,
    });

    // The tombstone and the durable write commit separately, so a promote can
    // fail between them; keying off the row's status (not `applied`) lets a
    // retry repair the missing durable learning instead of skipping it.
    if (
      resolution.resolution === 'reviewed-promoted' &&
      outcome.entry?.status === 'reviewed-promoted'
    ) {
      const { entryId, campaignId, skillSlug, learning } = outcome.entry;
      const existing = await findCoachLearningByPromotedFromEntry(
        db,
        args.context.tenantId as string,
        { spaceId, candidateLedgerEntryId: entryId },
      );
      if (!existing) {
        // Campaign candidates auto-record at campaign scope; process
        // candidates stage a skill-scope learning for operator ratification.
        const persisted = await persistCoachLearning(args, {
          spaceId,
          scope:
            campaignId !== undefined
              ? { kind: 'campaign', campaignId, skillSlug }
              : { kind: 'skill', skillSlug },
          kind: COACH_KIND_BY_LEARNING_KIND[learning.kind],
          ...(learning.appliesToTaskIds && learning.appliesToTaskIds.length > 0
            ? { appliesTo: { kind: 'tasks' as const, taskIds: learning.appliesToTaskIds } }
            : {}),
          statement: deriveStatement(learning),
          ...(learning.detailRef ? { detailRef: learning.detailRef } : {}),
          evidence: { citations: [{ runId: resolution.runId }] },
          confidence: learning.confidence,
          runId: resolution.runId,
          promotedFrom: {
            ...(campaignId !== undefined ? { campaignId } : {}),
            candidateLedgerEntryId: entryId,
          },
          authorityLevel: campaignId !== undefined ? 'auto_record' : 'stage_for_review',
          status: campaignId !== undefined ? 'auto_recorded' : 'proposed',
        });
        if (!persisted.ok) {
          throw new Error(
            `promotion of ${resolution.runId}/${resolution.learningId} resolved the candidate but the durable learning failed validation: ${persisted.error}`,
          );
        }
      }
    }

    results.push({
      runId: resolution.runId,
      learningId: resolution.learningId,
      status: resolution.resolution,
      applied: outcome.applied,
    });
  }

  await emitStepSuccess(args, { results }, startTime);
}
