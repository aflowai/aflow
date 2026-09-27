import type { LearnerProposeWithdrawInput, StagedChange } from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { getCoachCrudRepos, writeCoachJsonDoc } from './coachCrudMemory.js';

/** Tolerant JSON parse of a persisted StagedChange doc (shared with coachCrud). */
export function parseStagedChange(content: string | null | undefined): StagedChange | null {
  if (!content) return null;
  try {
    return JSON.parse(content) as StagedChange;
  } catch {
    return null;
  }
}

export async function handleWithdrawProposal(
  args: InlineHandlerArgs,
  input: LearnerProposeWithdrawInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const { docRepo, dirRepo } = getCoachCrudRepos(args.context.tenantId);

  const PROPOSAL_DIRS = ['/coach/staged', '/coach/platform-issues'] as const;
  let doc: Awaited<ReturnType<typeof docRepo.getByPath>> | null = null;
  let docDir: (typeof PROPOSAL_DIRS)[number] = PROPOSAL_DIRS[0];
  for (const dir of PROPOSAL_DIRS) {
    try {
      const found = await docRepo.getByPath(`${dir}/${input.stagedChangeId}.json`, spaceId);
      if (found) {
        doc = found;
        docDir = dir;
        break;
      }
    } catch {
      /* try next dir */
    }
  }
  if (!doc) {
    await emitStepError(
      args,
      'PROPOSAL_NOT_FOUND',
      `No staged change ${input.stagedChangeId} exists in this space.`,
      startTime,
      'validation',
    );
    return;
  }
  const sc = parseStagedChange(doc.inlineContent);
  if (!sc) {
    await emitStepError(
      args,
      'PROPOSAL_UNREADABLE',
      `Staged change ${input.stagedChangeId} could not be parsed.`,
      startTime,
      'internal',
    );
    return;
  }
  // Coach-authorship guard: operator-authored StagedChanges — historical
  // directive amendments, written with the zero-sentinel coachSessionId — are
  // operator intent and must never be retractable by an agent. Cross-SESSION
  // Coach withdrawal stays allowed by design: the Coach is one logical entity
  // per space, and boundary reviews clean up stale prior-session proposals.
  const COACH_SESSION_SENTINEL = '00000000-0000-0000-0000-000000000000';
  if (sc.kind === 'directive_amendment' || sc.coachSessionId === COACH_SESSION_SENTINEL) {
    await emitStepError(
      args,
      'PROPOSAL_NOT_WITHDRAWABLE',
      `Staged change ${input.stagedChangeId} is operator-authored (${sc.kind}) — the Coach may only withdraw its own proposals.`,
      startTime,
      'validation',
    );
    return;
  }
  if (sc.status === 'withdrawn') {
    // Idempotent: withdrawing an already-withdrawn proposal is a no-op success.
    await emitStepSuccess(args, { stagedChangeId: sc.id, status: 'withdrawn' }, startTime);
    return;
  }
  if (sc.status !== 'proposed') {
    await emitStepError(
      args,
      'PROPOSAL_NOT_WITHDRAWABLE',
      `Staged change ${input.stagedChangeId} has status '${sc.status}' — only 'proposed' can be withdrawn; operator decisions are immutable.`,
      startTime,
      'validation',
    );
    return;
  }

  const updated: StagedChange = {
    ...sc,
    status: 'withdrawn',
    resolvedAt: new Date().toISOString(),
    resolvedBy: 'coach',
    withdrawReason: input.reason,
  };
  await writeCoachJsonDoc(
    docRepo,
    dirRepo,
    `${docDir}/${sc.id}.json`,
    updated as unknown as Record<string, unknown>,
    'json',
    spaceId,
    'overwrite',
    'staged_change',
  );

  try {
    const { appendEntityEvent } = await import('@aflow/redis');
    const { randomUUID } = await import('node:crypto');
    await appendEntityEvent(args.redis, {
      tenantId: args.context.tenantId,
      spaceId,
      event: {
        eventId: randomUUID(),
        eventType: 'entity.coach.withdrawn',
        spaceId,
        tenantId: args.context.tenantId,
        timestamp: Date.now(),
        causedBySessionId: args.context.runId,
        causedByStepExecutionId: args.stepExecutionId,
        payload: { stagedChangeId: sc.id, reason: input.reason },
        summary: `Coach withdrew a proposal`,
      },
    });
  } catch {
    // Best-effort event emission
  }

  await emitStepSuccess(args, { stagedChangeId: sc.id, status: 'withdrawn' }, startTime);
}
