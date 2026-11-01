/**
 * The candidates of the pull request event source (Plan 339 D2): the pull
 * requests the loop has open, each with what its last poll read and the ETag
 * of each answer.
 *
 * The publication that opens a pull request arms it. Its merge or its close
 * clears it. The source reads one due set and nothing else, so with no loop
 * pull request open a cycle is one empty range read and no GitHub request.
 */
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { PullRequestChangeSchema } from '@aflow/schemas';

/** Watched pull requests by when each is next polled, across every space. */
export const PULL_REQUEST_WATCH_DUE_KEY = 'pr_watch:due';

/**
 * A watch outlives no pull request by long: one left behind by a lost clear is
 * dropped after this many seconds without a poll that saved it.
 */
export const PULL_REQUEST_WATCH_TTL_SECONDS = 14 * 24 * 60 * 60;

/**
 * One answer as the source last read it: its ETag and the part it keeps. An
 * empty ETag is an answer GitHub sent none for, so the next read of it is not
 * conditional.
 */
const ConditionalReadSchema = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ etag: z.string(), value });

export const PullRequestReadStateSchema = z.object({
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  /** GitHub's `mergeable_state`; `dirty` is a conflict. Null while GitHub computes it. */
  mergeableState: z.string().nullable(),
  headSha: z.string().min(1),
});
export type PullRequestReadState = z.infer<typeof PullRequestReadStateSchema>;

export const PullRequestChecksStateSchema = z.enum(['green', 'red', 'pending', 'none']);
export type PullRequestChecksState = z.infer<typeof PullRequestChecksStateSchema>;

export const PullRequestWatchSchema = z.object({
  tenantId: z.string().min(1),
  spaceId: z.string().uuid(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  /** `owner/repo#number`, the wait subject. */
  subject: z.string().min(1),
  url: z.string().min(1),
  /** Epoch ms. */
  armedAt: z.number().int().nonnegative(),
  /** The connected folder the publication pushed from, which a shepherd pass is aimed with. */
  bindingId: z.string().min(1).optional(),
  /**
   * The Helmsman conversation that started the publication that opened the
   * pull request: its owner (Plan 339 D4). Absent where no conversation
   * started it, or once its owner has ended.
   */
  ownerSessionId: z.string().min(1).optional(),
  pull: ConditionalReadSchema(PullRequestReadStateSchema).optional(),
  /** Keyed by the head it was read for: a new head is a new check-runs resource. */
  checks: ConditionalReadSchema(
    z.object({
      headSha: z.string().min(1),
      state: PullRequestChecksStateSchema,
      /** The answer held fewer check runs than the head has: past the first page. */
      truncated: z.boolean().optional(),
    }),
  ).optional(),
  /**
   * The head's combined commit status, read where the check runs do not say
   * green or not: none of them, or more than one page.
   */
  statuses: ConditionalReadSchema(
    z.object({ headSha: z.string().min(1), state: PullRequestChecksStateSchema }),
  ).optional(),
  reviews: ConditionalReadSchema(z.object({ changesRequested: z.boolean() })).optional(),
  /**
   * Changes a poll found whose event did not land. The poll's reads are saved
   * with them, so the next poll sends these again and not the ones that landed.
   */
  unsent: z.array(PullRequestChangeSchema).optional(),
});
export type PullRequestWatch = z.infer<typeof PullRequestWatchSchema>;

type WatchRef = Pick<PullRequestWatch, 'tenantId' | 'spaceId' | 'subject'>;

export function PULL_REQUEST_WATCH_KEY(ref: WatchRef): string {
  return `pr_watch:state:${ref.tenantId}:${ref.spaceId}:${ref.subject}`;
}

export function PULL_REQUEST_WATCH_LEASE_KEY(ref: WatchRef): string {
  return `pr_watch:lease:${ref.tenantId}:${ref.spaceId}:${ref.subject}`;
}

/**
 * One space's watched pull requests by subject, scored by when each was armed.
 * The shepherd sweep's due check reads it, so a firing in a space with no loop
 * pull request open reads one empty range.
 */
export function PULL_REQUEST_WATCH_SPACE_KEY(ref: Pick<WatchRef, 'tenantId' | 'spaceId'>): string {
  return `pr_watch:space:${ref.tenantId}:${ref.spaceId}`;
}

function dueMember(ref: WatchRef): string {
  return JSON.stringify([ref.tenantId, ref.spaceId, ref.subject]);
}

function parseDueMember(member: string): WatchRef | null {
  try {
    const parsed: unknown = JSON.parse(member);
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [tenantId, spaceId, subject] = parsed as unknown[];
    if (typeof tenantId !== 'string' || typeof spaceId !== 'string' || typeof subject !== 'string')
      return null;
    return { tenantId, spaceId, subject };
  } catch {
    return null;
  }
}

function parseWatch(raw: string | null): PullRequestWatch | null {
  if (raw === null) return null;
  try {
    const parsed = PullRequestWatchSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Arm a pull request as a candidate, due at once. Arming one already watched
 * keeps what its polls read, so a second publication of the branch costs no
 * fresh, unconditional read.
 */
export async function armPullRequestWatch(
  redis: Redis,
  watch: Pick<
    PullRequestWatch,
    'tenantId' | 'spaceId' | 'owner' | 'repo' | 'number' | 'subject' | 'url' | 'armedAt'
  > &
    Partial<Pick<PullRequestWatch, 'bindingId' | 'ownerSessionId'>>,
): Promise<PullRequestWatch> {
  const key = PULL_REQUEST_WATCH_KEY(watch);
  const existing = parseWatch(await redis.get(key));
  // The owner is the conversation whose publication opened the pull request.
  // A later publication of the branch — a shepherd's fix among them — names
  // an owner only where none is recorded.
  const record: PullRequestWatch = existing
    ? {
        ...existing,
        url: watch.url,
        ...(existing.bindingId === undefined && watch.bindingId !== undefined
          ? { bindingId: watch.bindingId }
          : {}),
        ...(existing.ownerSessionId === undefined && watch.ownerSessionId !== undefined
          ? { ownerSessionId: watch.ownerSessionId }
          : {}),
      }
    : { ...watch };
  await redis
    .multi()
    .set(key, JSON.stringify(record), 'EX', PULL_REQUEST_WATCH_TTL_SECONDS)
    .zadd(PULL_REQUEST_WATCH_DUE_KEY, String(watch.armedAt), dueMember(watch))
    .zadd(PULL_REQUEST_WATCH_SPACE_KEY(watch), String(watch.armedAt), watch.subject)
    .expire(PULL_REQUEST_WATCH_SPACE_KEY(watch), PULL_REQUEST_WATCH_TTL_SECONDS)
    .exec();
  return record;
}

/** The watch of one pull request, or null where the loop does not watch it. */
export async function readPullRequestWatch(
  redis: Redis,
  ref: WatchRef,
): Promise<PullRequestWatch | null> {
  return parseWatch(await redis.get(PULL_REQUEST_WATCH_KEY(ref)));
}

/**
 * Forget the owner of a pull request where it is still `sessionId`: that
 * conversation has ended, so the pull request is no conversation's and the
 * fallback sweep tends it. The record keeps its lifetime.
 */
export async function disownPullRequestWatch(
  redis: Redis,
  ref: WatchRef,
  sessionId: string,
): Promise<void> {
  const key = PULL_REQUEST_WATCH_KEY(ref);
  const watch = parseWatch(await redis.get(key));
  if (watch?.ownerSessionId !== sessionId) return;
  const { ownerSessionId: _ended, ...rest } = watch;
  const leftMs = await redis.pttl(key);
  if (leftMs <= 0) return;
  await redis.set(key, JSON.stringify(rest), 'PX', leftMs);
}

/**
 * The subjects of the pull requests one space's loop has open, oldest armed
 * first, at most `limit`. A subject whose watch lapsed is read as gone by
 * whoever reads its watch, and its member lapses with the space's index.
 */
export async function listSpacePullRequestSubjects(
  redis: Redis,
  ref: Pick<WatchRef, 'tenantId' | 'spaceId'>,
  limit: number,
): Promise<string[]> {
  return redis.zrangebyscore(PULL_REQUEST_WATCH_SPACE_KEY(ref), '-inf', '+inf', 'LIMIT', 0, limit);
}

/** Stop watching a pull request: it merged or closed. */
export async function clearPullRequestWatch(redis: Redis, ref: WatchRef): Promise<void> {
  await redis
    .multi()
    .del(PULL_REQUEST_WATCH_KEY(ref))
    .del(PULL_REQUEST_WATCH_LEASE_KEY(ref))
    .zrem(PULL_REQUEST_WATCH_DUE_KEY, dueMember(ref))
    .zrem(PULL_REQUEST_WATCH_SPACE_KEY(ref), ref.subject)
    .exec();
}

/** Save what a poll read and when the pull request is next due, and give up the claim on it. */
export async function savePullRequestWatch(
  redis: Redis,
  watch: PullRequestWatch,
  nextPollAtMs: number,
): Promise<void> {
  await redis
    .multi()
    .set(PULL_REQUEST_WATCH_KEY(watch), JSON.stringify(watch), 'EX', PULL_REQUEST_WATCH_TTL_SECONDS)
    .zadd(PULL_REQUEST_WATCH_DUE_KEY, String(nextPollAtMs), dueMember(watch))
    .del(PULL_REQUEST_WATCH_LEASE_KEY(watch))
    .exec();
}

/**
 * Set when a pull request is next due and give up the claim on it, keeping its
 * record as it stands. A poll that failed calls this rather than save: saving
 * would renew the record's lifetime, and a watch whose polls keep failing must
 * still lapse after it.
 */
export async function reschedulePullRequestWatch(
  redis: Redis,
  ref: WatchRef,
  nextPollAtMs: number,
): Promise<void> {
  await redis
    .multi()
    .zadd(PULL_REQUEST_WATCH_DUE_KEY, String(nextPollAtMs), dueMember(ref))
    .del(PULL_REQUEST_WATCH_LEASE_KEY(ref))
    .exec();
}

/**
 * Claim the pull requests due by `nowMs`. A claim is a lease for `leaseMs`, so
 * two orchestrators never poll one pull request at once. Saving the watch gives
 * the claim up; a claimer that dies holds it no longer than `leaseMs`. A due
 * member whose record is gone is dropped.
 */
export async function claimDuePullRequestWatches(
  redis: Redis,
  nowMs: number,
  limit: number,
  leaseMs: number,
): Promise<PullRequestWatch[]> {
  const members = await redis.zrangebyscore(
    PULL_REQUEST_WATCH_DUE_KEY,
    '-inf',
    String(nowMs),
    'LIMIT',
    0,
    limit,
  );
  const claimed: PullRequestWatch[] = [];
  for (const member of members) {
    const ref = parseDueMember(member);
    if (ref === null) {
      await redis.zrem(PULL_REQUEST_WATCH_DUE_KEY, member);
      continue;
    }
    const lease = await redis.set(PULL_REQUEST_WATCH_LEASE_KEY(ref), '1', 'PX', leaseMs, 'NX');
    if (lease !== 'OK') continue;
    const watch = parseWatch(await redis.get(PULL_REQUEST_WATCH_KEY(ref)));
    if (watch === null) {
      await redis
        .multi()
        .zrem(PULL_REQUEST_WATCH_DUE_KEY, member)
        .zrem(PULL_REQUEST_WATCH_SPACE_KEY(ref), ref.subject)
        .exec();
      continue;
    }
    claimed.push(watch);
  }
  return claimed;
}

/** How many pull requests the loop watches. One read, for metrics and tests. */
export async function countPullRequestWatches(redis: Redis): Promise<number> {
  return redis.zcard(PULL_REQUEST_WATCH_DUE_KEY);
}
