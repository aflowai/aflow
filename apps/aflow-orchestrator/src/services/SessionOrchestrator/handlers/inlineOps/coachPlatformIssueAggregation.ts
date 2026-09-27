import { randomUUID } from 'node:crypto';
import type { LearnerProposeWorkflowChangeInput, PlatformIssueOccurrence } from '@aflow/schemas';
import type { createMemoryDocRepository, createMemoryDirRepository } from '@aflow/database';
import {
  extractPlatformIssueSubject,
  findOpenPlatformIssueForSubject,
  appendPlatformIssueOccurrence,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess } from './helpers.js';
import { writeCoachJsonDoc } from './coachCrudMemory.js';

/** Redis set of proposal ids a Coach session created (24h TTL, inspect-ledger pattern). */
export function coachProposalsLedgerKey(tenantId: string, coachSessionId: string): string {
  return `coach:proposals:ledger:${tenantId}:${coachSessionId}`;
}

const SESSION_PROPOSAL_LEDGER_TTL_SECONDS = 24 * 60 * 60;

/** Best-effort sadd+expire into the session-proposal ledger. */
export async function recordProposalInSessionLedger(
  args: InlineHandlerArgs,
  proposalId: string,
): Promise<void> {
  try {
    const ledgerKey = coachProposalsLedgerKey(args.context.tenantId as string, args.context.runId);
    await args.redis.sadd(ledgerKey, proposalId);
    await args.redis.expire(ledgerKey, SESSION_PROPOSAL_LEDGER_TTL_SECONDS);
  } catch {
    /* best-effort — the cited-id path still covers the common case */
  }
}

export type PlatformIssueAggregationResult =
  { handled: true } | { handled: false; foundingOccurrence: PlatformIssueOccurrence };

/**
 * Run the aggregation decision for a platform_issue-routed proposal.
 *
 * Returns `{ handled: true }` when the report was absorbed into an existing
 * open document (the step result has already been emitted with the existing
 * `stagedChangeId` + `aggregated: true`). Otherwise returns the founding
 * occurrence the caller stamps onto the new document.
 */
export async function tryAggregatePlatformIssue(
  args: InlineHandlerArgs,
  input: LearnerProposeWorkflowChangeInput,
  deps: {
    docRepo: ReturnType<typeof createMemoryDocRepository>;
    dirRepo: ReturnType<typeof createMemoryDirRepository>;
    spaceId: string;
    /** Proposal-creation timestamp (ISO) — shared with the caller's record. */
    now: string;
    startTime: number;
    /** The run this Coach session reviewed (review-context target). */
    reviewTargetRunId?: string;
  },
): Promise<PlatformIssueAggregationResult> {
  const issueOp = input.ops.find((op) => op.op === 'platform_issue');
  const occurrence: PlatformIssueOccurrence = {
    ...(deps.reviewTargetRunId ? { runId: deps.reviewTargetRunId } : {}),
    observedAt: deps.now,
    summary: issueOp?.summary ?? input.rationale.slice(0, 1000),
  };

  const subject = extractPlatformIssueSubject(input.ops, input.targetSlug);
  if (!subject) {
    return { handled: false, foundingOccurrence: occurrence };
  }

  const existing = await findOpenPlatformIssueForSubject({
    docRepo: deps.docRepo,
    tenantId: args.context.tenantId,
    spaceId: deps.spaceId,
    subject,
  });
  if (!existing) {
    return { handled: false, foundingOccurrence: occurrence };
  }

  const updated = appendPlatformIssueOccurrence(existing.staged, occurrence);
  await writeCoachJsonDoc(
    deps.docRepo,
    deps.dirRepo,
    existing.docPath,
    updated as unknown as Record<string, unknown>,
    'json',
    deps.spaceId,
    'upsert',
    'staged_change',
  );

  // Record the aggregated doc in THIS session's proposal ledger so the
  // finalize cross-checks (session ownership + supersession coherence)
  // accept the returned id even though the doc was founded by an earlier
  // Coach session.
  await recordProposalInSessionLedger(args, existing.staged.id);

  try {
    const { appendEntityEvent } = await import('@aflow/redis');
    await appendEntityEvent(args.redis, {
      tenantId: args.context.tenantId,
      spaceId: deps.spaceId,
      event: {
        eventId: randomUUID(),
        eventType: 'entity.coach.proposal',
        spaceId: deps.spaceId,
        tenantId: args.context.tenantId,
        timestamp: Date.now(),
        causedBySessionId: args.context.runId,
        causedByStepExecutionId: args.stepExecutionId,
        workflowSlug: input.targetSlug,
        payload: {
          stagedChangeId: existing.staged.id,
          targetSlug: input.targetSlug,
          resolutionRoute: 'platform_issue',
          source: 'coach',
          aggregated: true,
          occurrenceCount: updated.occurrences?.length ?? 0,
        },
        summary: `Coach re-raised platform issue ${existing.staged.id} for "${input.targetSlug}" (occurrence ${String(updated.occurrences?.length ?? 0)})`,
      },
    });
  } catch {
    /* best-effort event emission */
  }

  await emitStepSuccess(
    args,
    {
      stagedChangeId: existing.staged.id,
      authorityLevel: existing.staged.authorityLevel,
      resolutionRoute: 'platform_issue',
      status: existing.staged.status,
      aggregated: true,
      occurrenceCount: updated.occurrences?.length ?? 0,
    },
    deps.startTime,
  );
  return { handled: true };
}
