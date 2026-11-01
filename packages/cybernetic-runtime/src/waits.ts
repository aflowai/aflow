/**
 * The wait primitive (Plan 339 D1): a Helmsman, a Runner or a skill waits on
 * a declared event, and the event wakes it.
 *
 * A wait names a kind, a subject and a window, never a cadence. It ends when
 * a matching event arrives or the window closes, whichever comes first, and
 * the waiter learns which of the two ended it. A wait waits for an event after
 * its declaration. One declared with `since` catches up: an event recorded at or
 * after that time ends it at once. The wait delivers the event and decides nothing:
 * a woken waiter acts on it by its own rules.
 *
 * The events reach it on the space's entity event stream: `appendEntityEvent`
 * records every wait event in the transaction that appends it.
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  claimClosedWindows,
  claimDueDeliveries,
  claimFiredWaits,
  registerWait,
  type EndedWait,
} from '@aflow/redis';
import {
  WAIT_WINDOW_MAX_SECONDS,
  WAIT_WINDOW_MIN_SECONDS,
  WaitEventKindSchema,
  WaitSubjectSchema,
  type WaitEvent,
  type WaitEventKind,
  type WaitOutcome,
  type WaitRegistration,
} from '@aflow/schemas';

export interface DeclareWaitInput {
  tenantId: string;
  spaceId: string;
  /** The conversation the wait wakes. */
  sessionId: string;
  kind: WaitEventKind;
  subject: string;
  windowSeconds: number;
  /**
   * Epoch ms. Catch up: an event recorded at or after it ends the wait at
   * once. Without it, only an event after the declaration ends the wait.
   */
  since?: number;
  /** Set where the platform declares the wait for the subject's owner (Plan 339 D4). */
  owner?: { onEvent: string };
}

export type DeclaredWait =
  | { waitId: string; closesAt: number; state: 'waiting' }
  | { waitId: string; closesAt: number; state: 'ended'; outcome: WaitOutcome };

export class WaitDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WaitDeclarationError';
  }
}

/**
 * Declare a wait. Where an event it catches up on was recorded already, the wait ends here
 * and the caller has the outcome at once; otherwise the waiter is woken later
 * by the event or by its window closing.
 */
export async function declareWait(
  redis: Redis,
  input: DeclareWaitInput,
  nowMs: number = Date.now(),
): Promise<DeclaredWait> {
  const kind = WaitEventKindSchema.safeParse(input.kind);
  if (!kind.success) {
    throw new WaitDeclarationError(
      `"${input.kind}" is no wait kind. Wait on one of: ${WaitEventKindSchema.options.join(', ')}.`,
    );
  }
  const subject = WaitSubjectSchema.safeParse(input.subject);
  if (!subject.success) {
    throw new WaitDeclarationError(
      'A wait names its subject: the run, node, pull request or item it waits on.',
    );
  }
  if (
    !Number.isInteger(input.windowSeconds) ||
    input.windowSeconds < WAIT_WINDOW_MIN_SECONDS ||
    input.windowSeconds > WAIT_WINDOW_MAX_SECONDS
  ) {
    throw new WaitDeclarationError(
      `A wait's window is a whole number of seconds from ${String(WAIT_WINDOW_MIN_SECONDS)} to ${String(WAIT_WINDOW_MAX_SECONDS)}.`,
    );
  }
  const registration: WaitRegistration = {
    waitId: randomUUID(),
    tenantId: input.tenantId,
    spaceId: input.spaceId,
    kind: kind.data,
    subject: subject.data,
    sessionId: input.sessionId,
    declaredAt: nowMs,
    closesAt: nowMs + input.windowSeconds * 1000,
    ...(input.since !== undefined ? { since: input.since } : {}),
    ...(input.owner !== undefined ? { owner: input.owner } : {}),
  };
  const registered = await registerWait(redis, registration);
  return registered.state === 'woken'
    ? {
        waitId: registration.waitId,
        closesAt: registration.closesAt,
        state: 'ended',
        outcome: registered.outcome,
      }
    : { waitId: registration.waitId, closesAt: registration.closesAt, state: 'waiting' };
}

/**
 * Claim every wait that is due for delivery: those put back or left by a
 * deliverer that died, then those an event ended, then those whose window
 * closed by `nowMs`. Each is claimed under a lease by one caller only, and
 * stays claimed until `settleEndedWait` forgets it.
 */
export async function claimEndedWaits(
  redis: Redis,
  nowMs: number,
  limit: number,
): Promise<EndedWait[]> {
  const due = await claimDueDeliveries(redis, nowMs, limit);
  const fired = due.length < limit ? await claimFiredWaits(redis, limit - due.length, nowMs) : [];
  const taken = due.length + fired.length;
  const closed = taken < limit ? await claimClosedWindows(redis, nowMs, limit - taken) : [];
  return [...due, ...fired, ...closed];
}

/** The words a woken waiter reads: what ended its wait, and what it should do next. */
export function describeWaitOutcome(registration: WaitRegistration, outcome: WaitOutcome): string {
  const what = `${registration.kind} on ${registration.subject}`;
  if (outcome.endedBy === 'event') {
    const describe = (event: WaitEvent) => {
      const detail = Object.entries(event.detail)
        .map(
          ([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
        )
        .join(', ');
      return `${new Date(event.firedAt).toISOString()}${detail ? ` (${detail})` : ''}`;
    };
    const later = outcome.laterEvents ?? [];
    return (
      `Your wait ${registration.waitId} on ${what} has ended: the event arrived at ` +
      `${describe(outcome.event)}. ` +
      (later.length > 0
        ? `Later events on the subject before you were told: ${later.map(describe).join('; ')}. `
        : '') +
      (registration.owner !== undefined
        ? `You own the subject, so the platform declared this wait for you. ${registration.owner.onEvent}`
        : 'Act on it by your own rules.')
    );
  }
  return (
    `Your wait ${registration.waitId} on ${what} has ended: its window closed at ` +
    `${new Date(outcome.closedAt).toISOString()} with no event. Read the subject yourself before you act.`
  );
}
