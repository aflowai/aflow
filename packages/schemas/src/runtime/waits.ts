import { z } from 'zod';
import type { EntityEventEnvelope } from './entityEvents.js';

// ============================================================================
// The wait primitive (Plan 339 D1)
// ============================================================================

/**
 * What a waiter may wait on. A waiter names a kind and a subject, never a
 * cadence: the event wakes it, and a window bounds how long it waits.
 *
 * - `run.ended`: a run reached a terminal status. Subject: the run id.
 * - `plan.node.status_changed`: a plan node's status changed. Subject: the node id.
 * - `pull_request.changed`: a loop pull request changed. Subject: `owner/repo#number`.
 * - `gate.resolved`: an Action Center item was resolved. Subject: the item id.
 */
export const WAIT_EVENT_KINDS = [
  'run.ended',
  'plan.node.status_changed',
  'pull_request.changed',
  'gate.resolved',
] as const;
export const WaitEventKindSchema = z.enum(WAIT_EVENT_KINDS);
export type WaitEventKind = z.infer<typeof WaitEventKindSchema>;

/**
 * Which change a `pull_request.changed` event names. `checks_failed` fires
 * when a check run on a head concludes failure, once while the head stays red.
 * A stopped run or a failed commit status fires nothing: a shepherd pass waits
 * on both. `closed`
 * is a close without a merge: like `merged`, it ends the loop's watch on the
 * pull request.
 */
export const PULL_REQUEST_CHANGES = [
  'checks_green',
  'checks_failed',
  'merged',
  'conflicting',
  'changes_requested',
  'closed',
] as const;
export const PullRequestChangeSchema = z.enum(PULL_REQUEST_CHANGES);
export type PullRequestChange = z.infer<typeof PullRequestChangeSchema>;

export const WaitSubjectSchema = z.string().trim().min(1).max(512);

/** The shortest and longest window a waiter may ask for, in seconds. */
export const WAIT_WINDOW_MIN_SECONDS = 10;
export const WAIT_WINDOW_MAX_SECONDS = 24 * 60 * 60;

/**
 * How long a fired event stays recorded for a waiter that registers after
 * it, matching the entity event stream's own retention.
 */
export const WAIT_EVENT_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/**
 * How many recent events a subject keeps recorded, so events that fire close
 * together all reach the waiter they end.
 */
export const WAIT_EVENTS_KEPT_PER_SUBJECT = 32;

/** One event a waiter may be woken by. `detail` is kind-specific and small. */
export const WaitEventSchema = z.object({
  kind: WaitEventKindSchema,
  subject: WaitSubjectSchema,
  /** Epoch ms when the event fired. */
  firedAt: z.number().int().nonnegative(),
  detail: z.record(z.unknown()).default({}),
});
export type WaitEvent = z.infer<typeof WaitEventSchema>;

/** A wait as it is stored: who waits, on what, and until when. */
export const WaitRegistrationSchema = z.object({
  waitId: z.string().uuid(),
  tenantId: z.string().min(1),
  spaceId: z.string().uuid(),
  kind: WaitEventKindSchema,
  subject: WaitSubjectSchema,
  /** The conversation the wait wakes. */
  sessionId: z.string().min(1),
  /** Epoch ms. */
  declaredAt: z.number().int().nonnegative(),
  /** Epoch ms when the window closes. */
  closesAt: z.number().int().nonnegative(),
  /**
   * Epoch ms. An event recorded at or after it ends the wait, one recorded
   * before already included. Without it, the wait counts from `declaredAt`.
   */
  since: z.number().int().nonnegative().optional(),
  /**
   * Set where the platform declared the wait for the subject's owner, and the
   * conversation did not declare it itself (Plan 339 D4). Its delivery
   * declares the next one, and a window that closes on it tells the owner
   * nothing.
   */
  owner: z
    .object({
      /**
       * Why the platform declared the wait for this conversation, as the room
       * message leads with it. Without it, the message says the conversation
       * owns the subject.
       */
      lead: z.string().min(1).max(500).optional(),
      /** What the owner does on the event, as the room message tells it. */
      onEvent: z.string().min(1).max(2000),
    })
    .optional(),
});
export type WaitRegistration = z.infer<typeof WaitRegistrationSchema>;

/**
 * A wait the platform holds for the conversation that made a write, as the
 * write's result names it: the event that ends it, on what, and until when.
 */
export const HeldWaitSchema = z.object({
  waitId: z.string().uuid(),
  kind: WaitEventKindSchema,
  subject: WaitSubjectSchema,
  windowSeconds: z.number().int().min(WAIT_WINDOW_MIN_SECONDS).max(WAIT_WINDOW_MAX_SECONDS),
  closesAt: z.string().datetime(),
});
export type HeldWait = z.infer<typeof HeldWaitSchema>;

/**
 * The plan node statuses a write sets that hold a `plan.node.status_changed`
 * wait for the writing conversation: the node waits on someone else, and its
 * writer is woken when its status changes.
 */
export const PLAN_NODE_HELD_STATUSES = ['blocked', 'waiting'] as const;

export function holdsPlanNodeWait(status: string): boolean {
  return (PLAN_NODE_HELD_STATUSES as readonly string[]).includes(status);
}

/** What ended a wait: the event it waited on, or its window closing first. */
export const WaitOutcomeSchema = z.discriminatedUnion('endedBy', [
  z.object({
    endedBy: z.literal('event'),
    /** The event that ended the wait. */
    event: WaitEventSchema,
    /**
     * Events on the subject after that one and before the wait was claimed,
     * oldest first. Absent where none fired.
     */
    laterEvents: z.array(WaitEventSchema).optional(),
  }),
  z.object({
    endedBy: z.literal('window_closed'),
    /** Epoch ms. */
    closedAt: z.number().int().nonnegative(),
  }),
]);
export type WaitOutcome = z.infer<typeof WaitOutcomeSchema>;

/**
 * The author of a wait's outcome in a conversation's room. A room message
 * names its author by a uuid, and this one is no person: it is the platform
 * telling a waiter what ended its wait.
 */
export const WAIT_OUTCOME_ACTOR_ID = '00000000-0000-4000-8000-000000000339';

/**
 * What a wait's room message names, read back from its words so the chat can
 * fold it to one line for a person. The agent reads the message whole.
 */
export interface WaitOutcomeMessage {
  kind: WaitEventKind;
  subject: string;
  endedBy: WaitOutcome['endedBy'];
  /** The first event's `change`, `status` and `resolution`, where it names them. */
  detail: Partial<Record<'change' | 'status' | 'resolution', string>>;
  /** The plan node's title, where the message names the node. */
  planNodeTitle?: string;
}

const WAIT_OUTCOME_HEAD =
  /^Your wait \S+ on ([a-z_.]+) on (.+?) has ended: (the event arrived|its window closed) at /;

/**
 * Read a wait's room message as `describeWaitOutcome` (`@aflow/cybernetic-runtime`)
 * words it. Null for words it does not recognise.
 */
export function readWaitOutcomeMessage(body: string): WaitOutcomeMessage | null {
  const head = WAIT_OUTCOME_HEAD.exec(body);
  if (head === null) return null;
  const kind = WaitEventKindSchema.safeParse(head[1]);
  const subject = head[2];
  if (!kind.success || subject === undefined) return null;
  const endedBy = head[3] === 'the event arrived' ? 'event' : 'window_closed';
  const detail: WaitOutcomeMessage['detail'] = {};
  if (endedBy === 'event') {
    for (const key of ['change', 'status', 'resolution'] as const) {
      // The first match is the first event's: later events follow it.
      const value = new RegExp(`[(,] ?${key}: ([a-z_]+)(?=[,)])`).exec(body)?.[1];
      if (value !== undefined) detail[key] = value;
    }
  }
  const planNodeTitle = /^Plan node "(.+)" \(\S+\) is now /m.exec(body)?.[1];
  return {
    kind: kind.data,
    subject,
    endedBy,
    detail,
    ...(planNodeTitle !== undefined ? { planNodeTitle } : {}),
  };
}

/** The subject of a pull request: `owner/repo#number`, owner and repo lower-cased. */
export function pullRequestSubject(owner: string, repo: string, number: number): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${String(number)}`;
}

/** A pull request's owner, repository and number, read from its subject or its GitHub link. */
export function parsePullRequestRef(
  ref: string,
): { owner: string; repo: string; number: number } | null {
  const trimmed = ref.trim();
  const match =
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(trimmed) ??
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/.exec(
      trimmed,
    );
  if (!match) return null;
  const [, owner, repo, number] = match;
  if (owner === undefined || repo === undefined || number === undefined) return null;
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase(), number: Number(number) };
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

const WAIT_KIND_OF_ENTITY_EVENT = {
  'entity.pull_request.changed': 'pull_request.changed',
  'entity.gate.resolved': 'gate.resolved',
} as const satisfies Partial<Record<EntityEventEnvelope['eventType'], WaitEventKind>>;

/**
 * The wait event an entity event carries, if any. The two entity events that
 * existed before the primitive feed it: a run's terminal update is
 * `run.ended`, and a plan write that changed a node's status is
 * `plan.node.status_changed`. The kinds added for it carry their subject in
 * their payload.
 */
export function waitEventOfEntityEvent(event: EntityEventEnvelope): WaitEvent | null {
  const payload = event.payload;
  const text = (key: string): string | undefined => {
    const value = payload[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  if (event.eventType === 'entity.run.updated') {
    const runId = text('runId');
    const status = text('status');
    if (runId === undefined || status === undefined || !TERMINAL_RUN_STATUSES.has(status)) {
      return null;
    }
    return { kind: 'run.ended', subject: runId, firedAt: event.timestamp, detail: { status } };
  }
  if (event.eventType === 'entity.plan.updated') {
    const nodeId = text('nodeId');
    const status = text('status');
    const previousStatus = text('previousStatus');
    if (nodeId === undefined || status === undefined || previousStatus === undefined) return null;
    if (status === previousStatus) return null;
    return {
      kind: 'plan.node.status_changed',
      subject: nodeId,
      firedAt: event.timestamp,
      detail: { status, previousStatus },
    };
  }
  if (
    event.eventType === 'entity.pull_request.changed' ||
    event.eventType === 'entity.gate.resolved'
  ) {
    const subject = text('subject');
    if (subject === undefined) return null;
    const detail = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'subject'));
    return {
      kind: WAIT_KIND_OF_ENTITY_EVENT[event.eventType],
      subject,
      firedAt: event.timestamp,
      detail,
    };
  }
  return null;
}
