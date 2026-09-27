/**
 * Naming conversations, and keeping their summaries current.
 *
 * Hosted on the orchestrator because that is where the Coach and the eval
 * judges already run their model calls — the BYOK client factory, the space
 * directives and the durable event log are all reachable here, and the work
 * needs none of the executor lane's containment. It is a background runner,
 * not the single-writer loop: a slow provider delays a title and nothing else.
 *
 * Nothing in this path can fail, pause, resume, or consume a turn of the
 * conversation it is describing. Every failure mode ends at a diagnostic and a
 * deterministic fallback.
 */
import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import {
  claimSessionMetadataCandidates,
  getSessionState,
  settleSessionMetadata,
  sessionMetadataLeaseHeld,
  appendEntityEvent,
  type SessionMetadataCandidate,
} from '@aflow/redis';
import {
  applyGeneratedSessionMetadata,
  readSessionEvidence,
  readSessionMetadata,
  recordSessionMetadataDiagnostic,
  type StoredSessionMetadata,
} from '@aflow/database';
import {
  backgroundTaskControlPlane,
  conversationSummariesEnabled,
  deriveFallbackSessionTitle,
  evaluateSessionMetadataEligibility,
  isSubstantiveRequest,
  resolveClerkReasoning,
  SESSION_METADATA_DEBOUNCE_MS,
  SESSION_METADATA_PROJECTION_GRACE_MS,
  SESSION_METADATA_RETRY_BACKOFF_MS,
  type EntityDirectives,
  type SessionMetadataDiagnostic,
} from '@aflow/schemas';
import {
  createBackgroundTaskRunner,
  type BackgroundTaskCycleResult,
  type BackgroundTaskLogger,
  type BackgroundTaskRunner,
} from '@aflow/lib';
import {
  decideSessionMetadataWork,
  generateSessionMetadata,
  loadSpaceDirectives,
  loadTenantAgentModelAllowlist,
  nextSessionTitleState,
  resolveClerkModel,
  SESSION_METADATA_MAX_TURNS,
  SESSION_METADATA_PROMPT_VERSION,
  type ClerkModelResolution,
} from '@aflow/cybernetic-runtime';
import {
  ByokCredentialError,
  createByokAiClientFactory,
  type ByokAiClientFactory,
} from '@aflow/credential-resolver';
import { ExecutionAuthoritySnapshotSchema } from '@aflow/schemas';

export const SESSION_METADATA_TASK_ID = 'orchestrator.session_metadata';

export interface SessionMetadataTaskDeps {
  redis: Redis;
  db: PostgresJsDatabase;
  logger: BackgroundTaskLogger;
}

export function createSessionMetadataTask(deps: SessionMetadataTaskDeps): BackgroundTaskRunner {
  const runtime = backgroundTaskControlPlane().resolve(SESSION_METADATA_TASK_ID);
  let byokFactory: ByokAiClientFactory | undefined;

  return createBackgroundTaskRunner(
    {
      taskId: SESSION_METADATA_TASK_ID,
      scope: runtime.scope,
      intervalMs: runtime.intervalMs ?? 5_000,
      maxBatch: runtime.maxBatch,
      maxCycleMs: runtime.maxCycleMs,
      mode: runtime.mode,
      logger: deps.logger,
    },
    async (ctx): Promise<BackgroundTaskCycleResult> => {
      // Observe reads nothing: claiming leases the conversation away from
      // whichever instance would otherwise have named it, which is a side
      // effect however little the cycle then does with it.
      if (ctx.mode === 'observe') return { candidates: 0 };

      const claimed = await claimSessionMetadataCandidates(deps.redis, ctx.maxBatch);
      if (claimed.length === 0) return { candidates: 0 };

      byokFactory ??= createByokAiClientFactory(deps.db);

      let processed = 0;
      let failed = 0;
      for (const candidate of claimed) {
        if (ctx.budgetExhausted() || ctx.signal.aborted) {
          // Releasing without progress: the lease is the only thing held, and
          // the next cycle finds the conversation exactly as due as it was.
          await settleSessionMetadata(
            deps.redis,
            candidate,
            'release',
            candidate.evidenceRevision,
            0,
          );
          continue;
        }
        try {
          const outcome = await nameOneConversation(deps, byokFactory, candidate, ctx.signal);
          if (outcome === 'retry') failed++;
          else if (outcome !== 'deferred') processed++;
        } catch (err) {
          failed++;
          deps.logger.warn('[session-metadata] generation failed', {
            sessionId: candidate.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          await scheduleRetry(deps, candidate, {
            code: 'generation_failed',
            message: err instanceof Error ? err.message : String(err),
            at: new Date().toISOString(),
            retryable: true,
            attempts: candidate.attempts + 1,
          });
        }
      }

      return {
        candidates: claimed.length,
        processed,
        failed,
        hasMore: claimed.length >= ctx.maxBatch,
      };
    },
  );
}

type CycleOutcome = 'done' | 'retry' | 'retired' | 'deferred';

async function nameOneConversation(
  deps: SessionMetadataTaskDeps,
  byokFactory: ByokAiClientFactory,
  candidate: SessionMetadataCandidate,
  signal: AbortSignal,
): Promise<CycleOutcome> {
  const { redis, db } = deps;
  const stored = await readSessionMetadata(db, candidate.tenantId, candidate.sessionId);

  // Postgres trails Redis, so a conversation armed moments ago may have no row
  // yet. That is lateness, not absence — come back for it rather than
  // retiring a conversation that is about to exist.
  if (!stored) {
    await settleSessionMetadata(redis, candidate, 'retry', candidate.evidenceRevision, backoff(0));
    return 'retry';
  }

  const eligibility = evaluateSessionMetadataEligibility({
    spaceId: stored.spaceId,
    lastActivityAt: stored.lastActivityAt,
  });
  if (!eligibility.eligible) {
    await settleSessionMetadata(redis, candidate, 'retire', candidate.evidenceRevision, 0);
    return 'retired';
  }

  // Read before deciding, so the projection check below has something to
  // check. One bounded indexed query, the same cost as the metadata read
  // above it.
  const evidence = await readSessionEvidence(
    db,
    candidate.tenantId,
    candidate.sessionId,
    SESSION_METADATA_MAX_TURNS,
  );

  // The reply that armed this conversation was written to Redis; the evidence
  // is read from Postgres, which the projection reaches a moment later.
  // Generating before it lands produces a summary of the turn BEFORE the one
  // on screen — every time, not occasionally.
  if (await isWaitingForProjection(redis, candidate, stored, evidence)) {
    await settleSessionMetadata(
      redis,
      candidate,
      'release',
      candidate.evidenceRevision,
      SESSION_METADATA_DEBOUNCE_MS,
    );
    // Neither processed nor failed: nothing was attempted, and counting a wait
    // as a failure would report a healthy cycle as a broken one.
    return 'deferred';
  }

  const clerk = await resolveClerkForSpace(db, candidate.tenantId, stored.spaceId!);

  const work = decideSessionMetadataWork(stored, {
    summariesEnabled: conversationSummariesEnabled(clerk.directives),
  });
  if (work === null) {
    await settleSessionMetadata(
      redis,
      candidate,
      'done',
      candidate.evidenceRevision,
      SESSION_METADATA_DEBOUNCE_MS,
    );
    return 'done';
  }

  if (!isSubstantiveRequest(evidence.openingRequest) && evidence.exchanges.length === 0) {
    await recordSessionMetadataDiagnostic(db, candidate.tenantId, candidate.sessionId, {
      code: 'no_evidence',
      message: 'Nothing has been said in this conversation yet.',
      at: new Date().toISOString(),
      retryable: true,
      attempts: 0,
    });
    await settleSessionMetadata(
      redis,
      candidate,
      'done',
      candidate.evidenceRevision,
      SESSION_METADATA_DEBOUNCE_MS,
    );
    return 'done';
  }

  // The deterministic name lands first and unconditionally. A conversation
  // gets a usable label within the debounce whether or not a model ever
  // answers — and if one never can, this is the label it keeps.
  const fallback = deriveFallbackSessionTitle(evidence.openingRequest);
  if (fallback && stored.title === null) {
    await applyGeneratedSessionMetadata(db, candidate.tenantId, candidate.sessionId, {
      title: fallback,
      titleState: 'fallback',
      evidenceRevision: candidate.evidenceRevision,
    });
    await publishMetadataChanged(deps, stored.spaceId!, candidate);
  }

  if (!clerk.resolution.resolved) {
    await recordSessionMetadataDiagnostic(
      db,
      candidate.tenantId,
      candidate.sessionId,
      clerkDiagnostic(clerk.resolution),
    );
    // Not a retry: nothing about waiting changes an unassignable model. The
    // next activity boundary re-arms the conversation, which is also when an
    // operator's fix would take effect.
    await settleSessionMetadata(
      redis,
      candidate,
      'done',
      candidate.evidenceRevision,
      SESSION_METADATA_DEBOUNCE_MS,
    );
    return 'done';
  }

  let client;
  try {
    ({ client } = await byokFactory.getClientForModel(clerk.resolution.modelRef, {
      tenantId: candidate.tenantId,
      spaceId: stored.spaceId!,
      ...(credentialOwnerFor(stored) ? { credentialOwnerId: credentialOwnerFor(stored)! } : {}),
    }));
  } catch (err) {
    const message =
      err instanceof ByokCredentialError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    await recordSessionMetadataDiagnostic(db, candidate.tenantId, candidate.sessionId, {
      code: 'no_credential',
      message,
      at: new Date().toISOString(),
      retryable: true,
      attempts: 0,
    });
    await settleSessionMetadata(
      redis,
      candidate,
      'done',
      candidate.evidenceRevision,
      SESSION_METADATA_DEBOUNCE_MS,
    );
    return 'done';
  }

  const generated = await generateSessionMetadata({
    client,
    modelRef: clerk.resolution.modelRef,
    reasoning: resolveClerkReasoning(clerk.directives?.reasoningDefaults),
    tenantId: candidate.tenantId,
    sessionId: candidate.sessionId,
    want: work,
    evidence: {
      openingRequest: evidence.openingRequest,
      turns: evidence.exchanges.map((e) => ({ speaker: e.speaker, text: e.text })),
      complete: evidence.complete,
    },
    signal,
  });

  // Generation can outlive its own lease when a provider stalls, and whoever
  // claimed the conversation next may already have written a newer name from
  // newer evidence. The durable write is keyed on the session alone, so
  // landing this one would replace that with the older one — permanently, for
  // a title, which is never revisited once established. Dropping the result
  // costs one regeneration; the owner still holds the work.
  if (!(await sessionMetadataLeaseHeld(redis, candidate))) return 'deferred';

  const titleState = nextSessionTitleState(evidence.exchanges.length);
  const applied = await applyGeneratedSessionMetadata(db, candidate.tenantId, candidate.sessionId, {
    ...(work.title && generated.proposal.title
      ? { title: generated.proposal.title, titleState }
      : {}),
    ...(work.summary && generated.proposal.summary
      ? {
          summary: generated.proposal.summary,
          summaryCoverage: evidence.complete ? ('full' as const) : ('partial' as const),
        }
      : {}),
    evidenceRevision: candidate.evidenceRevision,
    provenance: {
      modelRef: clerk.resolution.modelRef,
      modelId: clerk.resolution.modelId,
      providerId: clerk.resolution.providerId,
      resolution: clerk.resolution.mode,
      promptVersion: SESSION_METADATA_PROMPT_VERSION,
      generatedAt: new Date().toISOString(),
      evidenceRevision: candidate.evidenceRevision,
      coverage: evidence.complete ? 'full' : 'partial',
      exchangeCount: evidence.exchanges.length,
      promptTokens: generated.promptTokens,
      completionTokens: generated.completionTokens,
      ...(generated.costCents !== undefined ? { costCents: generated.costCents } : {}),
    },
  });

  await settleSessionMetadata(
    deps.redis,
    candidate,
    'done',
    candidate.evidenceRevision,
    SESSION_METADATA_DEBOUNCE_MS,
  );
  if (applied) await publishMetadataChanged(deps, stored.spaceId!, candidate);
  return 'done';
}

/**
 * Whether the conversation's latest reply has reached the durable log yet.
 *
 * The clock is read from Redis, not from the session row. Both the row's
 * `last_activity_at` and the event log are written by the same projection, so
 * they lag together and always agree — comparing them finds nothing, which is
 * exactly what an earlier version of this check did. Redis has the reply the
 * moment it is committed, which is the whole point of asking it.
 *
 * Past the grace window the answer is no longer "wait" but "this is what there
 * is": a conversation whose projection is genuinely stuck still deserves a
 * name, and the summary records the coverage it actually had. A session whose
 * hot state has aged out is settled by definition and never waits.
 */
async function isWaitingForProjection(
  redis: Redis,
  candidate: SessionMetadataCandidate,
  stored: StoredSessionMetadata,
  evidence: { exchanges: Array<{ at: number }> },
): Promise<boolean> {
  const hot = await getSessionState(redis, candidate.tenantId, candidate.sessionId);
  const activityAt = hot?.lastActivityAt ?? stored.lastActivityAt?.getTime();
  if (activityAt === undefined) return false;
  const newestRead = evidence.exchanges.at(-1)?.at ?? 0;
  if (newestRead >= activityAt) return false;
  return Date.now() - activityAt < SESSION_METADATA_PROJECTION_GRACE_MS;
}

interface ResolvedClerk {
  resolution: ClerkModelResolution;
  directives: EntityDirectives | null;
}

async function resolveClerkForSpace(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<ResolvedClerk> {
  const [directives, allowlist] = await Promise.all([
    loadSpaceDirectives(db, tenantId, spaceId),
    loadTenantAgentModelAllowlist(db, tenantId),
  ]);
  return { resolution: resolveClerkModel(directives?.modelDefaults, allowlist), directives };
}

function clerkDiagnostic(resolution: ClerkModelResolution): SessionMetadataDiagnostic {
  const message = resolution.resolved
    ? ''
    : resolution.reason === 'unknown_model'
      ? `The Clerk is assigned "${resolution.requestedRef ?? ''}", which the model catalog no longer carries. Pick another model for the Clerk.`
      : resolution.reason === 'not_permitted'
        ? `No model your organization permits is suitable for background summaries on ${resolution.providerId ?? 'this provider'}. Permit one, or assign the Clerk a model explicitly.`
        : `No economical model is available for ${resolution.providerId ?? "this space's provider"}. Assign the Clerk a model explicitly.`;
  return {
    code: resolution.resolved ? 'generation_failed' : 'no_clerk_model',
    message,
    at: new Date().toISOString(),
    retryable: false,
    attempts: 0,
  };
}

/** Whose credentials this conversation's background work may spend. */
function credentialOwnerFor(stored: StoredSessionMetadata): string | undefined {
  const authority = ExecutionAuthoritySnapshotSchema.safeParse(stored.executionAuthority);
  if (authority.success) {
    // Personal keys stay personal unless their owner extended them to this
    // run. Without that grant the chain starts at space scope, exactly as it
    // does for the eval judges.
    return authority.data.personalCredentialsGranted ? authority.data.principalUserId : undefined;
  }
  return undefined;
}

function backoff(attempts: number): number {
  return (
    SESSION_METADATA_RETRY_BACKOFF_MS[
      Math.min(attempts, SESSION_METADATA_RETRY_BACKOFF_MS.length - 1)
    ] ?? SESSION_METADATA_RETRY_BACKOFF_MS[SESSION_METADATA_RETRY_BACKOFF_MS.length - 1]!
  );
}

async function scheduleRetry(
  deps: SessionMetadataTaskDeps,
  candidate: SessionMetadataCandidate,
  diagnostic: SessionMetadataDiagnostic,
): Promise<void> {
  // Reached from the outer catch, so the failure may be a model call that
  // outlived the lease. The settle below is fenced on its own; this write is
  // not, and a stale error recorded over a successful generation's provenance
  // shows the operator a failure that did not happen.
  if (!(await sessionMetadataLeaseHeld(deps.redis, candidate))) return;

  const attempts = candidate.attempts + 1;
  const exhausted = attempts >= SESSION_METADATA_RETRY_BACKOFF_MS.length;
  await recordSessionMetadataDiagnostic(deps.db, candidate.tenantId, candidate.sessionId, {
    ...diagnostic,
    attempts,
    retryable: !exhausted,
  });
  await settleSessionMetadata(
    deps.redis,
    candidate,
    exhausted ? 'retire' : 'retry',
    candidate.evidenceRevision,
    backoff(candidate.attempts),
  );
}

/**
 * Tell the space its conversation list changed.
 *
 * A space-wide channel rather than the session's own event stream: the
 * conversation being named is usually not the one anyone has open, and a row
 * in a list nobody is subscribed to would otherwise stay stale until the next
 * refetch. Carries no message content, so it cannot be mistaken for something
 * unread.
 */
async function publishMetadataChanged(
  deps: SessionMetadataTaskDeps,
  spaceId: string,
  candidate: SessionMetadataCandidate,
): Promise<void> {
  try {
    await appendEntityEvent(deps.redis, {
      tenantId: candidate.tenantId,
      spaceId,
      event: {
        eventId: randomUUID(),
        eventType: 'entity.session.described',
        spaceId,
        tenantId: candidate.tenantId,
        timestamp: Date.now(),
        causedBySessionId: candidate.sessionId,
        payload: { sessionId: candidate.sessionId },
        summary: 'Conversation metadata updated',
      },
    });
  } catch {
    // Best-effort: the list refetches on its own staleness anyway.
  }
}
