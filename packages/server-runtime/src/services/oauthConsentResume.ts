import type { Redis } from 'ioredis';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createTenantContext, sessions, withTenantSchema } from '@aflow/database';
import { getSessionState } from '@aflow/redis';
import { loadRunById } from '@aflow/cybernetic-runtime';
import {
  OAuthConsentRequestPayloadSchema,
  type SessionId,
  type StepExecutionId,
  type TenantId,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import type { SessionService } from './sessions.js';

/**
 * Run-plane resume authority (Plan 185 §9.3 Plane B). Injected so this hook
 * stays decoupled from the harness wiring in `workflowRunOperatorResume`. A
 * consent-blocked Runner step parks its run via `pauseRunForTask`; only this
 * authority (`executeOperatorWorkflowRunResume`) clears the paused run row AND
 * re-dispatches the step — a bare `sessionService.resumeSession` cannot.
 */
export type ResumeRunPlane = (args: {
  tenantId: TenantId;
  spaceId: string;
  userId: string;
  runId: string;
  pauseVersion: number;
}) => Promise<{ ok: boolean }>;

/**
 * Identity of a just-completed OAuth consent, as returned by
 * `completeConsent`. Sessions parked on a `needs_oauth_consent` pause that
 * match this identity become resumable.
 */
export interface CompletedConsentIdentity {
  tenantId: string;
  spaceId: string;
  integrationKind: 'mcp' | 'api';
  resourceKey: string;
  bindingId: string;
  ownerScope: 'user' | 'space' | 'tenant';
  /** The pinned owner the token was stored under (userId for `user` scope). */
  ownerId: string;
}

export interface OAuthConsentResumeDeps {
  db: PostgresJsDatabase;
  redis: Redis;
  payloadStore: PayloadStore;
  sessionService: SessionService;
  /** Run-plane resume authority for harness-routed (`workflowExecution`) sessions. */
  resumeRunPlane: ResumeRunPlane;
}

export interface OAuthConsentResumeResult {
  /** Step-plane sessions resumed by this callback. */
  resumedSessionIds: string[];
  /** Run ids un-paused on the run plane via the run-resume authority. */
  resumedRunIds: string[];
}

interface PausedConsentRow {
  sessionId: string;
  currentStepExecutionId: string | null;
  requestedInputRef: string | null;
  createdBy: string | null;
  hotStateSnapshot: unknown;
}

/**
 * The harness-routed run id off a parked session, read from the SAME source the
 * surfacing plane reads (Plane A's `isHarnessRoutedRun` in `pausedStepSource`):
 * the durable `hot_state_snapshot.runHotState.workflowExecution` that
 * The projection worker writes it atomically with `status='PAUSED'`. Redis hot
 * state is a fast path only — its key TTLs (24h) while a session rests on a
 * consent pause that a human can easily exceed, so the durable snapshot is the
 * authority. Reading both planes from the same durable field eliminates the
 * window where the run-plane card surfaces (durable, robust) but the resume
 * routes to the dead-end step plane (Redis-gone) and strands the run.
 */
function harnessRunIdFromSnapshot(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  const runHotState = (snapshot as { runHotState?: unknown }).runHotState;
  if (!runHotState || typeof runHotState !== 'object') return undefined;
  const workflowExecution = (runHotState as { workflowExecution?: unknown }).workflowExecution;
  if (!workflowExecution || typeof workflowExecution !== 'object') return undefined;
  const runId = (workflowExecution as { runId?: unknown }).runId;
  return typeof runId === 'string' && runId.length > 0 ? runId : undefined;
}

/**
 * Resume step-plane sessions parked on a `needs_oauth_consent` pause that the
 * just-completed consent satisfies (Plan 185 §9.3 Plane A).
 *
 * Matching: a paused session's `requestedInputRef` carries an
 * `OAuthConsentRequestPayload`; it matches when (integrationKind, resourceKey,
 * bindingId, ownerScope) line up. For `user` scope we additionally require the
 * session's owner to be the consenting `ownerId` — a different user's parked
 * session must wait for its own consent.
 *
 * Plane routing: sessions WITHOUT `workflowExecution` (direct, non-Runner
 * callers) resume here via `sessionService.resumeSession`. Harness-routed runs
 * (`workflowExecution` set) resume on the RUN plane — a step-plane resume never
 * clears the paused run row (only the run-resume authority does). The
 * harness-routed signal is read from the durable `hot_state_snapshot`, the SAME
 * source the surfacing plane (`isHarnessRoutedRun`) reads, so a consent that
 * completes after the worker sub-session's Redis hot state TTLs out still routes
 * to the run plane instead of dead-ending on the step plane. We confirm the run
 * is paused with `needs_oauth_consent`, then drive the run-resume authority
 * (`executeOperatorWorkflowRunResume` via `deps.resumeRunPlane`) with
 * `re_execute` — un-pausing the run AND re-dispatching the consent-blocked
 * Runner step. A token becoming available unblocks every matching run.
 */
export async function resumeSessionsForCompletedConsent(
  deps: OAuthConsentResumeDeps,
  consent: CompletedConsentIdentity,
): Promise<OAuthConsentResumeResult> {
  const tenantCtx = createTenantContext(consent.tenantId as TenantId);

  const rows = (await withTenantSchema(deps.db, tenantCtx, async (tx) =>
    tx
      .select({
        sessionId: sessions.sessionId,
        currentStepExecutionId: sessions.currentStepExecutionId,
        requestedInputRef: sessions.requestedInputRef,
        createdBy: sessions.createdBy,
        hotStateSnapshot: sessions.hotStateSnapshot,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.spaceId, consent.spaceId),
          eq(sessions.status, 'PAUSED'),
          isNotNull(sessions.requestedInputRef),
          isNotNull(sessions.currentStepExecutionId),
        ),
      ),
  )) as PausedConsentRow[];

  const resumedSessionIds: string[] = [];
  const resumedRunIds: string[] = [];
  const seenRunIds = new Set<string>();

  for (const row of rows) {
    if (!row.currentStepExecutionId || !row.requestedInputRef) continue;

    const payload = await loadConsentPayload(deps.payloadStore, row.requestedInputRef);
    if (!payload) continue;

    if (
      payload.integrationKind !== consent.integrationKind ||
      payload.resourceKey !== consent.resourceKey ||
      payload.bindingId !== consent.bindingId ||
      payload.ownerScope !== consent.ownerScope
    ) {
      continue;
    }

    // `user`-scoped consent only un-blocks the consenting user's sessions.
    if (consent.ownerScope === 'user' && !ownerMatches(row, consent.ownerId)) {
      continue;
    }

    // ── Plane B — workflow-run resume ────────────────────────────────────────
    // Harness-routed runs surface the pause as a workflow-run pause; only the
    // run-resume authority can un-stall them. A bare `sessionService.resumeSession`
    // here would enqueue a resume the paused run row ignores. Read the run id off
    // the parked session, confirm it's paused on this consent, and drive the
    // authority with `re_execute` (un-pause + re-dispatch the blocked step).
    //
    // Plane-routing source: the durable DB snapshot, identical to the surfacing
    // plane (`isHarnessRoutedRun`). Redis hot state is a fast path only — it
    // TTLs out from under a consent pause a human can leave for days, after
    // which routing on Redis alone would dead-end the resume on the step plane
    // and strand the still-surfaced run forever.
    const hotState = await getSessionState(deps.redis, consent.tenantId, row.sessionId);
    const workflowRunId =
      hotState?.workflowExecution?.runId ?? harnessRunIdFromSnapshot(row.hotStateSnapshot);
    if (workflowRunId) {
      if (seenRunIds.has(workflowRunId)) continue;
      seenRunIds.add(workflowRunId);
      const resumed = await resumeBlockedRun(deps, consent, workflowRunId, row.createdBy);
      if (resumed) resumedRunIds.push(workflowRunId);
      continue;
    }

    try {
      await deps.sessionService.resumeSession({
        tenantId: consent.tenantId as TenantId,
        sessionId: row.sessionId as SessionId,
        stepExecutionId: row.currentStepExecutionId as StepExecutionId,
        input: { consentCompleted: true, completedAt: new Date().toISOString() },
        // No `activatedByPerson`: the provider's redirect is not a request
        // authenticated as anyone, so the session stays as attended as it was.
      });
      resumedSessionIds.push(row.sessionId);
    } catch {
      // Best-effort: a session that moved on (re-paused on a different step,
      // completed, cancelled) between the query and the resume just won't
      // resume. The callback's success page is unaffected.
    }
  }

  return { resumedSessionIds, resumedRunIds };
}

/**
 * Drive the run-resume authority for a single consent-blocked run. Best-effort:
 * a run that already moved on (resumed, completed, cancelled, or re-paused on a
 * different cause) between the query and the resume simply isn't resumed.
 *
 * The actor is the consenting owner (`createdBy` for `user` scope) so the
 * resume is attributed to the user who supplied the token; falls back to the
 * pinned `ownerId` when the parked session carries no creator.
 */
async function resumeBlockedRun(
  deps: OAuthConsentResumeDeps,
  consent: CompletedConsentIdentity,
  runId: string,
  createdBy: string | null,
): Promise<boolean> {
  try {
    const run = await loadRunById(deps.db, consent.tenantId, consent.spaceId, runId);
    if (run?.status !== 'paused' || run.pausedReason !== 'needs_oauth_consent') {
      return false;
    }
    const result = await deps.resumeRunPlane({
      tenantId: consent.tenantId as TenantId,
      spaceId: consent.spaceId,
      userId: createdBy ?? consent.ownerId,
      runId,
      pauseVersion: run.pauseVersion,
    });
    return result.ok;
  } catch {
    return false;
  }
}

async function loadConsentPayload(
  payloadStore: PayloadStore,
  ref: string,
): Promise<{
  integrationKind: 'mcp' | 'api';
  resourceKey: string;
  bindingId: string;
  ownerScope: 'user' | 'space' | 'tenant';
} | null> {
  try {
    const raw = await payloadStore.retrieve(ref as never);
    const parsed = OAuthConsentRequestPayloadSchema.safeParse(raw);
    if (!parsed.success) return null;
    return {
      integrationKind: parsed.data.integrationKind,
      resourceKey: parsed.data.resourceKey,
      bindingId: parsed.data.bindingId,
      ownerScope: parsed.data.ownerScope,
    };
  } catch {
    return null;
  }
}

function ownerMatches(row: PausedConsentRow, ownerId: string): boolean {
  if (row.createdBy && row.createdBy === ownerId) return true;
  return false;
}
