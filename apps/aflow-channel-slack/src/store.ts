/**
 * The app's own records (Plan 327 D6): a local file beside its configuration,
 * mode 0600, which it creates and migrates itself when it starts.
 *
 * Not a Postgres schema. The app runs outside the image as the operator's user,
 * and creating a schema would need a database credential that reaches every
 * tenant schema. One operator and a few small record sets need no shared
 * database, and removing the app and this file leaves nothing in the platform.
 *
 * It keeps five record sets. `link` is the one Slack user this app serves.
 * `sent` holds each send's `messageRef`, text and item, which make a retried
 * step post once and a repeated message fail. A send is keyed on its run and
 * its step, because a workflow task's step carries the same name in every run
 * of it. `card` holds each card posted, the item it shows and the controls it
 * offered, which is all a tap may resolve. `inbound` holds each Slack event
 * the operator sent, so a redelivered one does nothing, with when it was sent,
 * when it arrived and what came of it. `thread` holds each Slack thread and the
 * Helmsman session it continues. A code that linked once is kept so it cannot
 * link a second time.
 *
 * Every write replaces the whole file through a rename, and every write is
 * synchronous, so one process never interleaves two of them.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ActionCenterResolutionSchema } from '@aflow/schemas';
import { z } from 'zod';

export const LinkRecordSchema = z.object({
  slackUserId: z.string().min(1),
  slackTeamId: z.string().min(1).optional(),
  aflowUserId: z.string().min(1),
  tenantId: z.string().min(1),
  linkedAt: z.string().min(1),
});
export type LinkRecord = z.infer<typeof LinkRecordSchema>;

export const SentRecordSchema = z.object({
  /**
   * The step's logical execution, stable across its retries. On the workflow
   * path it names the task and not the run, so a send is keyed on both.
   */
  executionId: z.string().min(1),
  runId: z.string().min(1),
  text: z.string(),
  /** The Action Center item sent as a card with the text. Part of what a repeat matches. */
  itemId: z.string().min(1).optional(),
  /** Null when the post left but Slack's answer never came, so it may have posted. */
  messageRef: z.string().min(1).nullable(),
  sentAt: z.string().min(1),
});
export type SentRecord = z.infer<typeof SentRecordSchema>;

export const CardControlSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  style: z.enum(['primary', 'danger']).optional(),
  resolution: ActionCenterResolutionSchema,
  decided: z.string().min(1),
});

/**
 * A card the app posted (Plan 327 D6), and the only source of what a tap on it
 * may do. A tap names a control by id, and the resolution comes from here, so
 * a tap can never ask for more than the card offered when it was posted.
 */
export const CardRecordSchema = z.object({
  channel: z.string().min(1),
  ts: z.string().min(1),
  itemId: z.string().min(1),
  spaceId: z.string().min(1),
  /** The item's origin as the app read it, which the resolve compares. */
  origin: z.record(z.unknown()),
  title: z.string(),
  row: z.enum(['choices', 'text_reply', 'approval', 'write_approval', 'at_aflow']),
  controls: z.array(CardControlSchema),
  /** The card's blocks above its controls, which an edit keeps. */
  head: z.array(z.record(z.unknown())),
  text: z.string(),
  postedAt: z.string().min(1),
  /** What the card says once it is decided, or once a tap learned it was. */
  outcome: z
    .object({
      note: z.string().min(1),
      at: z.string().min(1),
      /** True when the card went out of date while its item stayed open at Aflow. */
      stillOpen: z.boolean().optional(),
    })
    .nullable(),
});
export type CardRecord = z.infer<typeof CardRecordSchema>;

/**
 * One Slack event from the linked operator (Plan 327 D4, D6). Its id is unique,
 * so a redelivered event finds its record and does nothing. Only the
 * operator's own events are recorded, and a stranger's leave no record.
 */
export const InboundRecordSchema = z.object({
  eventId: z.string().min(1),
  channel: z.string().min(1),
  /** The message's own Slack timestamp. */
  ts: z.string().min(1),
  /** The thread the message opened or replied in. */
  threadTs: z.string().min(1),
  sentAt: z.string().min(1),
  arrivedAt: z.string().min(1),
  ageMs: z.number().int().nonnegative(),
  outcome: z.enum([
    'received',
    'linked',
    'code_used',
    'card_reply',
    'started',
    'continued',
    'busy',
    'ended',
    'held_late',
    'ran_late',
    'discarded',
    'not_sent',
    'outcome_unknown',
    'refused',
  ]),
  /** The "Run it now?" question a late message got. */
  promptTs: z.string().min(1).optional(),
  /** A late message's text, kept only until the operator runs or discards it. */
  heldText: z.string().optional(),
  decidedAt: z.string().min(1).optional(),
});
export type InboundRecord = z.infer<typeof InboundRecordSchema>;
export type InboundOutcome = InboundRecord['outcome'];

/** A Slack thread and the Helmsman session it continues (Plan 327 D4). */
export const ThreadRecordSchema = z.object({
  channel: z.string().min(1),
  threadTs: z.string().min(1),
  sessionId: z.string().min(1),
  spaceId: z.string().min(1),
  /**
   * `answering` while the app waits for the Helmsman's reply, `waiting` once it
   * paused for the operator, `ended` once the session finished.
   */
  status: z.enum(['answering', 'waiting', 'ended']),
  /**
   * The paused step the last `SessionPaused` named, which a reply resumes.
   * Null while the Helmsman answers, or when the app does not know the pause.
   */
  pausedStepExecutionId: z.string().min(1).nullable(),
  /**
   * The pause whose answer the app last posted. A pause counts as the next
   * answer only when it names another step, so a watch that starts again after
   * a restart never posts one answer twice.
   */
  relayedStepExecutionId: z.string().min(1).nullable(),
  /**
   * The pause a reply last resumed, or the one a resume found closed with a
   * 409. The session's events name it as the newest pause until the Helmsman
   * answers, so a reply that reads the pause from them skips this one rather
   * than resume it a second time.
   */
  resumedStepExecutionId: z.string().min(1).nullable(),
  startedAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type ThreadRecord = z.infer<typeof ThreadRecordSchema>;

const StoreDataSchema = z.object({
  /** The ledger: every migration id applied, in order. */
  migrations: z.array(z.string()),
  link: LinkRecordSchema.nullable(),
  usedLinkCodes: z.array(z.string()),
  sent: z.array(SentRecordSchema),
  cards: z.array(CardRecordSchema),
  inbound: z.array(InboundRecordSchema),
  threads: z.array(ThreadRecordSchema),
});
type StoreData = z.infer<typeof StoreDataSchema>;

interface Migration {
  id: string;
  apply: (data: Record<string, unknown>) => Record<string, unknown>;
}

/** Append-only. A migration once released is never edited, only followed. */
const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001-link-and-sent',
    apply: (data) => ({ ...data, link: null, usedLinkCodes: [], sent: [] }),
  },
  {
    id: '0002-cards',
    apply: (data) => ({ ...data, cards: [] }),
  },
  {
    id: '0003-conversations',
    apply: (data) => ({ ...data, inbound: [], threads: [] }),
  },
];

/**
 * How long a sent record is kept. A retry or a repeat arrives within its run,
 * and a run that lasts a month is not one this rule has to serve. Applied when
 * the store opens and on every claimed send, so an app that runs for months
 * keeps a bounded file.
 */
export const SENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class ChannelStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelStoreError';
  }
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export type SendClaim =
  { claimed: true; record: SentRecord } | { claimed: false; prior: SentRecord };

export class ChannelStore {
  private data: StoreData;
  /** Sends claimed and not yet settled. Process memory: a restart settles none. */
  private readonly claims = new Set<SentRecord>();
  /** Cards with a tap or reply at the API. Process memory, as the send claims are. */
  private readonly cardClaims = new Set<string>();
  /** Late messages whose question has a tap at work. Process memory, as above. */
  private readonly lateClaims = new Set<string>();
  /** New threads whose conversation is starting. Process memory, as above. */
  private readonly threadClaims = new Set<string>();

  private constructor(
    private readonly path: string,
    data: StoreData,
  ) {
    this.data = data;
  }

  /** Opens the store at `path`, creating it and applying any migration it lacks. */
  static open(path: string, now: Date = new Date()): ChannelStore {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let raw: Record<string, unknown> = { migrations: [] };
    if (existsSync(path)) {
      try {
        raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      } catch {
        throw new ChannelStoreError(
          `${path} is not readable as the channel app's store. Move it aside and link again with \`yarn channel:slack setup\`.`,
        );
      }
    }
    const applied = Array.isArray(raw['migrations']) ? (raw['migrations'] as string[]) : [];
    let migrated = { ...raw, migrations: [...applied] };
    for (const migration of MIGRATIONS) {
      if (migrated.migrations.includes(migration.id)) continue;
      migrated = {
        ...migration.apply(migrated),
        migrations: [...migrated.migrations, migration.id],
      } as typeof migrated;
    }
    const parsed = StoreDataSchema.safeParse(migrated);
    if (!parsed.success) {
      throw new ChannelStoreError(
        `${path} does not hold the records this version of the channel app reads. Move it aside and link again.`,
      );
    }
    const store = new ChannelStore(path, parsed.data);
    store.prune(now);
    store.persist();
    return store;
  }

  link(): LinkRecord | null {
    return this.data.link;
  }

  /**
   * Links `link` with the code whose hash is given, once. False when that code
   * has already linked someone, so a code read over a shoulder cannot relink.
   */
  linkWithCode(codeSha256: string, link: LinkRecord): boolean {
    if (this.data.usedLinkCodes.includes(codeSha256)) return false;
    this.data.link = link;
    this.data.usedLinkCodes.push(codeSha256);
    this.persist();
    return true;
  }

  sentFor(runId: string, executionId: string): SentRecord | undefined {
    return this.data.sent.find(
      (record) => record.runId === runId && record.executionId === executionId,
    );
  }

  /** True while the send that wrote `record` has not settled in this process. */
  inFlight(record: SentRecord): boolean {
    return this.claims.has(record);
  }

  /**
   * Claims a send before it leaves, in one synchronous step, so of two sends
   * that arrive together the second finds the first. Returns the record that
   * stands in the way: one for this step, or one for the same text in the run.
   *
   * The claim is written with no `messageRef`, so a process that dies during
   * the post leaves a send that may have posted, which is what it is.
   */
  claimSend(claim: Omit<SentRecord, 'messageRef'>, now: Date = new Date()): SendClaim {
    const prior =
      this.sentFor(claim.runId, claim.executionId) ??
      this.data.sent.find(
        (record) =>
          record.runId === claim.runId &&
          record.text === claim.text &&
          record.itemId === claim.itemId,
      );
    if (prior !== undefined) return { claimed: false, prior };
    const record: SentRecord = { ...claim, messageRef: null };
    this.prune(now);
    this.data.sent.push(record);
    this.claims.add(record);
    this.persist();
    return { claimed: true, record };
  }

  /**
   * Settles a claimed send: `messageRef` once Slack named the message, null
   * when the post may have landed and no answer said so.
   */
  settleSend(record: SentRecord, messageRef: string | null): void {
    this.claims.delete(record);
    record.messageRef = messageRef;
    this.persist();
  }

  /** Drops a claimed send that posted nothing, so a retry may post. */
  releaseSend(record: SentRecord): void {
    this.claims.delete(record);
    this.data.sent = this.data.sent.filter((entry) => entry !== record);
    this.persist();
  }

  addCard(card: CardRecord): void {
    this.data.cards.push(card);
    this.persist();
  }

  /** The card posted as this Slack message, if the app posted one. */
  cardAt(channel: string, ts: string): CardRecord | undefined {
    return this.data.cards.find((card) => card.channel === channel && card.ts === ts);
  }

  /** Records what the card now says, so a later tap or reply reads it. */
  settleCard(card: CardRecord, note: string, at: Date, stillOpen = false): void {
    card.outcome = { note, at: at.toISOString(), ...(stillOpen ? { stillOpen } : {}) };
    this.persist();
  }

  /**
   * Takes the card for one tap or reply at a time, in one synchronous step. A
   * second tap that lands while the first is with the API is not sent.
   */
  claimCard(card: CardRecord): boolean {
    const key = `${card.channel}:${card.ts}`;
    if (this.cardClaims.has(key)) return false;
    this.cardClaims.add(key);
    return true;
  }

  releaseCard(card: CardRecord): void {
    this.cardClaims.delete(`${card.channel}:${card.ts}`);
  }

  /**
   * Records an event from the operator before anything acts on it, in one
   * synchronous step. False when the event, or the same Slack message under
   * another event id, is already recorded: a redelivery does nothing.
   */
  claimInbound(record: InboundRecord, now: Date = new Date()): boolean {
    const seen = this.data.inbound.some(
      (entry) =>
        entry.eventId === record.eventId ||
        (entry.channel === record.channel && entry.ts === record.ts),
    );
    if (seen) return false;
    this.prune(now);
    this.data.inbound.push(record);
    this.persist();
    return true;
  }

  /** Records what came of an event. A held text is dropped unless the patch keeps it. */
  settleInbound(
    record: InboundRecord,
    patch: Pick<InboundRecord, 'outcome'> & Partial<InboundRecord>,
  ): void {
    if (!('heldText' in patch)) delete record.heldText;
    Object.assign(record, patch);
    this.persist();
  }

  /** The late message whose "Run it now?" question is this Slack message. */
  inboundAtPrompt(channel: string, promptTs: string): InboundRecord | undefined {
    return this.data.inbound.find(
      (entry) => entry.channel === channel && entry.promptTs === promptTs,
    );
  }

  /** Takes a late message for one tap at a time, as `claimCard` takes a card. */
  claimLate(record: InboundRecord): boolean {
    if (this.lateClaims.has(record.eventId)) return false;
    this.lateClaims.add(record.eventId);
    return true;
  }

  releaseLate(record: InboundRecord): void {
    this.lateClaims.delete(record.eventId);
  }

  threadAt(channel: string, threadTs: string): ThreadRecord | undefined {
    return this.data.threads.find(
      (thread) => thread.channel === channel && thread.threadTs === threadTs,
    );
  }

  /**
   * Takes a thread with no conversation for the one message that starts it, in
   * one synchronous step. False when the thread has a conversation, or another
   * message is starting one, so one thread never maps to two sessions.
   */
  claimThread(channel: string, threadTs: string): boolean {
    const key = `${channel}:${threadTs}`;
    if (this.threadAt(channel, threadTs) !== undefined || this.threadClaims.has(key)) return false;
    this.threadClaims.add(key);
    return true;
  }

  releaseThread(channel: string, threadTs: string): void {
    this.threadClaims.delete(`${channel}:${threadTs}`);
  }

  addThread(thread: ThreadRecord): void {
    this.data.threads.push(thread);
    this.persist();
  }

  updateThread(
    thread: ThreadRecord,
    patch: Partial<
      Pick<
        ThreadRecord,
        'status' | 'pausedStepExecutionId' | 'relayedStepExecutionId' | 'resumedStepExecutionId'
      >
    >,
    at: Date,
  ): void {
    Object.assign(thread, patch, { updatedAt: at.toISOString() });
    this.persist();
  }

  /** Threads whose answer the app was waiting on, so a restart watches them again. */
  threadsAnswering(): ThreadRecord[] {
    return this.data.threads.filter((thread) => thread.status === 'answering');
  }

  private prune(now: Date): void {
    this.data.sent = this.data.sent.filter(
      (record) =>
        this.claims.has(record) || now.getTime() - Date.parse(record.sentAt) < SENT_RETENTION_MS,
    );
    this.data.cards = this.data.cards.filter(
      (card) => now.getTime() - Date.parse(card.postedAt) < SENT_RETENTION_MS,
    );
    this.data.inbound = this.data.inbound.filter(
      (entry) => now.getTime() - Date.parse(entry.arrivedAt) < SENT_RETENTION_MS,
    );
    this.data.threads = this.data.threads.filter(
      (thread) =>
        thread.status === 'answering' ||
        now.getTime() - Date.parse(thread.updatedAt) < SENT_RETENTION_MS,
    );
  }

  private persist(): void {
    const staging = `${this.path}.${String(process.pid)}.tmp`;
    writeFileSync(staging, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(staging, 0o600);
    renameSync(staging, this.path);
  }
}
