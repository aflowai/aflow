import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createTenantContext,
  notificationOutbox,
  spaceMemberships,
  withTenantSchema,
} from '@aflow/database';
import { deriveResolverPolicy, type PayloadRef, type TenantId } from '@aflow/schemas';
import type { SessionHotState } from '@aflow/redis';

export interface PauseNotificationPayloadRetriever {
  retrieve(payloadRef: PayloadRef): Promise<unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who a pause is waiting on, as people.
 *
 * Derived from the request's own targeting — a name is a person, anything
 * else is a role every holder of which is asked — and never from what an
 * agent said. An untargeted pause falls back to whoever started the run:
 * that is today's solo behaviour, and "not just the initiator" means a
 * targeted request escapes it, not that the solo case grows an audience.
 * Named people are filtered to members: being told means being able to look,
 * and someone outside the space can do neither.
 */
export function deriveRecipients(args: {
  candidateResolvers: string[] | undefined;
  members: ReadonlyArray<{ userId: string; role: string }>;
  createdBy: string | undefined;
}): string[] {
  const memberIds = new Set(args.members.map((m) => m.userId));
  const targeted = args.candidateResolvers ?? [];

  const recipients = new Set<string>();
  for (const entry of targeted) {
    if (UUID_RE.test(entry)) {
      if (memberIds.has(entry)) recipients.add(entry);
    } else {
      for (const m of args.members) {
        if (m.role === entry) recipients.add(m.userId);
      }
    }
  }

  if (recipients.size === 0 && args.createdBy && memberIds.has(args.createdBy)) {
    recipients.add(args.createdBy);
  }
  return [...recipients];
}

/**
 * What a person is being told about: the request, not the step that carries it.
 *
 * A delegated pause is mirrored — the child asks and the parent copies the
 * same `requestedInputRef` onto its own delegate step — so both sessions rest
 * as PAUSED holding one question. Keyed by step, that is two rows and a
 * person told twice for a single request; keyed by the request itself, the
 * dedupe tuple collapses them however deep the chain goes.
 */
export function pauseRequestSubject(runState: Pick<SessionHotState, 'requestedInputRef'>): string {
  return createHash('sha256')
    .update(runState.requestedInputRef ?? '')
    .digest('hex')
    .slice(0, 32);
}

/**
 * Tell the right people a run stopped for one of them.
 *
 * Called from the flush funnel — the one place every pause passes through on
 * its way to being durable — rather than from the ~7 sites that can pause a
 * session. Both flush workers may call it for the same pause: the outbox's
 * (kind, subject, recipient) tuple is the idempotency, so the second write
 * and every later re-flush are silent.
 */
export async function routePauseNotifications(args: {
  db: PostgresJsDatabase;
  payloadStore: PauseNotificationPayloadRetriever | undefined;
  tenantId: string;
  runState: SessionHotState;
}): Promise<void> {
  const { db, payloadStore, tenantId, runState } = args;
  const { spaceId, requestedInputRef } = runState;
  if (runState.status !== 'PAUSED' || !requestedInputRef || !spaceId) return;
  const stepExecutionId = runState.currentStepExecutionId;
  if (!stepExecutionId) return;

  let payload: Record<string, unknown> | null = null;
  if (payloadStore) {
    try {
      const raw = await payloadStore.retrieve(requestedInputRef);
      if (raw && typeof raw === 'object') payload = raw as Record<string, unknown>;
    } catch {
      /* a malformed payload routes like an untargeted pause */
    }
  }

  const members = await db
    .select({ userId: spaceMemberships.userId, role: spaceMemberships.role })
    .from(spaceMemberships)
    .where(and(eq(spaceMemberships.tenantId, tenantId), eq(spaceMemberships.spaceId, spaceId)));

  const recipients = deriveRecipients({
    candidateResolvers: deriveResolverPolicy(payload)?.candidateResolvers,
    members,
    createdBy: runState.createdBy,
  });
  if (recipients.length === 0) return;

  const tenantCtx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    for (const recipientUserId of recipients) {
      await tx
        .insert(notificationOutbox)
        .values({
          spaceId,
          recipientUserId,
          kind: 'pause',
          subjectKind: 'pause_request',
          subjectId: pauseRequestSubject(runState),
          payload: {
            sessionId: runState.sessionId,
            stepExecutionId,
            ...(runState.pauseReason ? { pauseReason: runState.pauseReason } : {}),
          },
        })
        .onConflictDoNothing();
    }
  });
}
