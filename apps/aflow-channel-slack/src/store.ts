/**
 * The app's own records (Plan 327 D6): a local file beside its configuration,
 * mode 0600, which it creates and migrates itself when it starts.
 *
 * Not a Postgres schema. The app runs outside the image as the operator's user,
 * and creating a schema would need a database credential that reaches every
 * tenant schema. One operator and a few small record sets need no shared
 * database, and removing the app and this file leaves nothing in the platform.
 *
 * P0 keeps two record sets: `link`, the one Slack user this app serves, and
 * `sent`, each send's `messageRef` and text, which make a retried step post once
 * and a repeated message fail. A send is keyed on its run and its step, because
 * a workflow task's step carries the same name in every run of it. A code that linked once is kept so it cannot link
 * a second time.
 *
 * Every write replaces the whole file through a rename, and every write is
 * synchronous, so one process never interleaves two of them.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
  /** Null when the post left but Slack's answer never came, so it may have posted. */
  messageRef: z.string().min(1).nullable(),
  sentAt: z.string().min(1),
});
export type SentRecord = z.infer<typeof SentRecordSchema>;

const StoreDataSchema = z.object({
  /** The ledger: every migration id applied, in order. */
  migrations: z.array(z.string()),
  link: LinkRecordSchema.nullable(),
  usedLinkCodes: z.array(z.string()),
  sent: z.array(SentRecordSchema),
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
      this.data.sent.find((record) => record.runId === claim.runId && record.text === claim.text);
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

  private prune(now: Date): void {
    this.data.sent = this.data.sent.filter(
      (record) =>
        this.claims.has(record) || now.getTime() - Date.parse(record.sentAt) < SENT_RETENTION_MS,
    );
  }

  private persist(): void {
    const staging = `${this.path}.${String(process.pid)}.tmp`;
    writeFileSync(staging, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(staging, 0o600);
    renameSync(staging, this.path);
  }
}
