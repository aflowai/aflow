import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { createTenantContext, idempotencyKeys, withTenantSchema } from '@aflow/database';
import { addControlMessage } from '@aflow/redis';
import type {
  ActorContext,
  IdempotencyKey,
  SessionId,
  StepExecutionId,
  TenantId,
  TraceId,
} from '@aflow/schemas';

/**
 * What a resume is actually saying — the pause it targets and the answer it
 * carries. Two sends agree only if both agree.
 */
function hashResumePayload(stepExecutionId: string, inputRef: string): string {
  return createHash('sha256')
    .update(stepExecutionId)
    .update(' ')
    .update(inputRef)
    .digest('hex')
    .slice(0, 32);
}

export class IdempotencyReuseError extends Error {
  readonly statusCode = 409;

  constructor() {
    super(
      'This idempotency key was already used for a different answer. ' +
        'Send a new key to submit a different response.',
    );
    this.name = 'IdempotencyReuseError';
  }
}

/**
 * Claim the right to dispatch this resume.
 *
 * Three outcomes, and the middle one is why the payload is hashed: an exact
 * retry replays (a flaky network resending the same answer must not act
 * twice), a key reused for a *different* answer is refused rather than
 * silently replaying the first, and anything else is a fresh action.
 */
export async function claimResumeIdempotency(
  db: PostgresJsDatabase,
  params: {
    tenantId: string;
    sessionId: string;
    stepExecutionId: string;
    inputRef: string;
    idempotencyKey: string;
  },
): Promise<{ firstSeen: boolean }> {
  const tenantContext = createTenantContext(params.tenantId as TenantId);
  const payloadHash = hashResumePayload(params.stepExecutionId, params.inputRef);
  let firstSeen = true;

  await withTenantSchema(db, tenantContext, async (tx: PostgresJsDatabase) => {
    try {
      await tx.insert(idempotencyKeys).values({
        idempotencyKey: params.idempotencyKey,
        scope: `resume_run:${params.sessionId}`,
        sessionId: params.sessionId,
        stepExecutionId: params.stepExecutionId,
        payloadHash,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
    } catch {
      firstSeen = false;
    }
  });

  if (!firstSeen) {
    const claimed = await withTenantSchema(db, tenantContext, async (tx: PostgresJsDatabase) =>
      tx
        .select({ payloadHash: idempotencyKeys.payloadHash })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.idempotencyKey, params.idempotencyKey))
        .limit(1),
    );
    const claimedHash = claimed[0]?.payloadHash;
    if (claimedHash && claimedHash !== payloadHash) throw new IdempotencyReuseError();
  }

  return { firstSeen };
}

const RESUME_CLAIMS_READ_LIMIT = 16;

/**
 * The keys under which a resume of this exact paused step is already claimed —
 * by a human, an approval, or an earlier wake. A boundary can only be advanced
 * once, so a wake finding a claim coalesces instead of piling a second resume
 * onto the control stream; the next pause is a new stepExecutionId, so a spent
 * claim never suppresses a future wake.
 */
export async function resumeClaimsForStep(
  db: PostgresJsDatabase,
  params: { tenantId: string; sessionId: string; stepExecutionId: string },
): Promise<string[]> {
  const tenantContext = createTenantContext(params.tenantId as TenantId);
  const rows = await withTenantSchema(db, tenantContext, async (tx: PostgresJsDatabase) =>
    tx
      .select({ idempotencyKey: idempotencyKeys.idempotencyKey })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.scope, `resume_run:${params.sessionId}`),
          eq(idempotencyKeys.stepExecutionId, params.stepExecutionId),
        ),
      )
      .limit(RESUME_CLAIMS_READ_LIMIT),
  );
  return rows.map((row) => row.idempotencyKey);
}

export interface DispatchResumeRequest {
  tenantId: TenantId;
  sessionId: SessionId;
  stepExecutionId: StepExecutionId;
  inputRef: string;
  idempotencyKey: string;
  traceId: TraceId;
  actorContext?: ActorContext;
  voiceMode?: boolean;
  clientMessageId?: string;
  /** Decided by whoever dispatches: only a request authenticated as an interactive user is a person. */
  activatedByPerson: boolean;
}

/**
 * Claim a resume durably, then send it to the session's orchestrator.
 *
 * The claim and the control message are two stores: a crash between them
 * leaves a claim that proves nothing was dispatched. An exact retry
 * (`firstSeen: false`, same payload) therefore RE-SENDS — the orchestrator's
 * not-paused guard drops a duplicate harmlessly, while skipping the send would
 * mark the wake delivered and park the session forever. Claim ⇒ eventual
 * dispatch is what makes outbox coalescing sound.
 */
export async function dispatchResume(
  db: PostgresJsDatabase,
  redis: Redis,
  request: DispatchResumeRequest,
): Promise<{ firstSeen: boolean }> {
  const claim = await claimResumeIdempotency(db, {
    tenantId: request.tenantId,
    sessionId: request.sessionId,
    stepExecutionId: request.stepExecutionId,
    inputRef: request.inputRef,
    idempotencyKey: request.idempotencyKey,
  });
  await addControlMessage(redis, {
    messageVersion: 1,
    type: 'resume_run',
    tenantId: request.tenantId,
    runId: request.sessionId,
    stepExecutionId: request.stepExecutionId,
    inputRef: request.inputRef,
    traceId: request.traceId,
    idempotencyKey: request.idempotencyKey as IdempotencyKey,
    requestedAtMs: Date.now(),
    ...(request.actorContext ? { actorContext: request.actorContext } : {}),
    ...(request.voiceMode !== undefined ? { voiceMode: request.voiceMode } : {}),
    ...(request.clientMessageId ? { clientMessageId: request.clientMessageId } : {}),
    activatedByPerson: request.activatedByPerson,
  });
  return claim;
}
