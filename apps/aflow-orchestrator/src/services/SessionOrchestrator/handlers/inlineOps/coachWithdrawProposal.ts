import { getDatabase } from '@aflow/database';
import {
  isProposalOfConversation,
  loadConversationLookup,
  proposalAuthorIds,
} from '@aflow/cybernetic-runtime';
import { agentRoleName } from '@aflow/schemas';
import type { LearnerProposeWithdrawInput, StagedChange } from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { getCoachCrudRepos, writeCoachJsonDoc } from './coachCrudMemory.js';
import { logOrchestratorError } from '../../../../lib/orchestratorLogger.js';

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
      `Staged change ${input.stagedChangeId} is operator-authored (${sc.kind}). No agent may withdraw it.`,
      startTime,
      'validation',
    );
    return;
  }
  // Any other agent is one conversation, not a standing entity: it withdraws
  // only what that conversation proposed, the conversation the card names.
  const byCoach = args.context.agentDefinition.systemRole === 'cybernetic-coach';
  const ownership = byCoach ? 'own' : await proposedInCallersConversation(args, spaceId, sc);
  if (ownership === 'unknown') {
    await emitStepError(
      args,
      'PROPOSAL_OWNER_UNREADABLE',
      `The conversations behind staged change ${input.stagedChangeId} could not be read, so whether this conversation proposed it is unknown. Nothing was withdrawn. Retry the call.`,
      startTime,
      'transient',
      true,
    );
    return;
  }
  if (ownership === 'other') {
    await emitStepError(
      args,
      'PROPOSAL_NOT_WITHDRAWABLE',
      `Staged change ${input.stagedChangeId} was proposed by another conversation. You may withdraw only the proposals this conversation made, and the operator decides this one.`,
      startTime,
      'permission',
      false,
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

  const resolvedBy = byCoach
    ? 'coach'
    : args.context.agentDefinition.systemRole === 'cybernetic-helmsman'
      ? 'helmsman'
      : 'agent';
  const updated: StagedChange = {
    ...sc,
    status: 'withdrawn',
    resolvedAt: new Date().toISOString(),
    resolvedBy,
    withdrawReason: input.reason,
    withdrawnBy: agentRoleName(args.context.agentDefinition),
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
        summary: byCoach
          ? 'Coach withdrew a proposal'
          : 'The conversation that proposed a change withdrew it',
      },
    });
  } catch {
    // Best-effort event emission
  }

  await emitStepSuccess(args, { stagedChangeId: sc.id, status: 'withdrawn' }, startTime);
}

/**
 * Whether the caller's session belongs to the conversation the proposal came
 * from. A delegated session counts as its top conversation, as on the card.
 * When the sessions cannot be read and the recorded session is not the
 * caller's, ownership is unknown: the caller is told to retry, not refused.
 */
async function proposedInCallersConversation(
  args: InlineHandlerArgs,
  spaceId: string,
  sc: StagedChange,
): Promise<'own' | 'other' | 'unknown'> {
  const sessionId = args.context.runId as string;
  if (sc.coachSessionId === sessionId) return 'own';
  try {
    const lookup = await loadConversationLookup(
      getDatabase(),
      args.context.tenantId as string,
      spaceId,
      [...proposalAuthorIds(sc), sessionId],
    );
    return isProposalOfConversation(sc, sessionId, lookup) ? 'own' : 'other';
  } catch (err) {
    logOrchestratorError(
      '[learner.propose.withdraw] Could not load the conversations behind a proposal',
      err,
      {
        tenantId: args.context.tenantId,
        spaceId,
        sessionId,
        stagedChangeId: sc.id,
      },
    );
    return 'unknown';
  }
}
