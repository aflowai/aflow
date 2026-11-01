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
  /**
   * The connected folder the publication pushed from, which a shepherd pass is
   * aimed with. Kept in the holder record, with the owner.
   */
  bindingId: z.string().min(1).optional(),
  /**
   * The pull request's owner (Plan 339 D4): the Helmsman conversation whose
   * publication of the branch holds it. Absent where none does, or once its
   * owner has ended. Kept in the holder record, apart from what the polls
   * save, so a save never changes who owns the pull request.
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

/**
 * Who holds one pull request: a hash of `sessionId`, its owner, and
 * `bindingId`, its folder. Arms and disowns change it in one script each. A
 * poll's save only renews it, so a poll cannot put back an owner a disown
 * cleared or drop one an arm named.
 */
export function PULL_REQUEST_WATCH_HOLDER_KEY(ref: WatchRef): string {
  return `pr_watch:holder:${ref.tenantId}:${ref.spaceId}:${ref.subject}`;
}

export function PULL_REQUEST_WATCH_LEASE_KEY(ref: WatchRef): string {
  return `pr_watch:lease:${ref.tenantId}:${ref.spaceId}:${ref.subject}`;
}

/**
 * One space's watched pull requests by subject, scored by when each was armed.
 * The shepherd sweep's due check reads it, so a firing in a space with no loop
 * pull request open reads one empty range. Every arm and every saved poll
 * renews it, so it lives as long as the newest watch in the space.
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

function parseWatch(raw: string | null, holder: Record<string, string>): PullRequestWatch | null {
  if (raw === null) return null;
  try {
    const parsed = PullRequestWatchSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const { ownerSessionId: _owner, bindingId: _binding, ...polled } = parsed.data;
    const sessionId = holder['sessionId'];
    const bindingId = holder['bindingId'];
    return {
      ...polled,
      ...(bindingId !== undefined && bindingId.length > 0 ? { bindingId } : {}),
      ...(sessionId !== undefined && sessionId.length > 0 ? { ownerSessionId: sessionId } : {}),
    };
  } catch {
    return null;
  }
}

/** The record as the polls own it. Who holds the pull request lives in its holder record. */
function polledRecord(watch: PullRequestWatch): string {
  const { ownerSessionId: _owner, bindingId: _binding, ...polled } = watch;
  return JSON.stringify(polled);
}

async function readWatch(redis: Redis, ref: WatchRef): Promise<PullRequestWatch | null> {
  const read = await redis
    .multi()
    .get(PULL_REQUEST_WATCH_KEY(ref))
    .hgetall(PULL_REQUEST_WATCH_HOLDER_KEY(ref))
    .exec();
  const raw: unknown = read?.[0]?.[1];
  const holder: unknown = read?.[1]?.[1];
  return parseWatch(
    typeof raw === 'string' ? raw : null,
    holder !== null && typeof holder === 'object' ? (holder as Record<string, string>) : {},
  );
}

/**
 * Name `ARGV[1]` the owner where no owner is recorded, or where the one
 * recorded is `ARGV[2]`, an owner the caller read as unable to act. Record the
 * folder `ARGV[3]` where none is. Returns the owner after it, `''` for none.
 */
const HOLD_PULL_REQUEST_SCRIPT = `
local current = redis.call('HGET', KEYS[1], 'sessionId')
if ARGV[1] ~= '' and ((not current) or (ARGV[2] ~= '' and current == ARGV[2])) then
  redis.call('HSET', KEYS[1], 'sessionId', ARGV[1])
  current = ARGV[1]
end
if ARGV[3] ~= '' then
  redis.call('HSETNX', KEYS[1], 'bindingId', ARGV[3])
end
redis.call('EXPIRE', KEYS[1], ARGV[4])
return current or ''
`;

/** Forget the owner only where it is still `ARGV[1]`. */
const DISOWN_PULL_REQUEST_SCRIPT = `
if redis.call('HGET', KEYS[1], 'sessionId') == ARGV[1] then
  redis.call('HDEL', KEYS[1], 'sessionId')
  return 1
end
return 0
`;

/**
 * Arm a pull request as a candidate, due at once. Arming one already watched
 * keeps what its polls read, so a second publication of the branch costs no
 * fresh, unconditional read: the record is written only where none exists.
 *
 * A pull request has one owner (Plan 339 D4). The arm names `ownerSessionId`
 * where no owner is recorded, or where the one recorded is `replacingOwner`,
 * an owner the caller read as unable to act. Any other owner stays.
 */
export async function armPullRequestWatch(
  redis: Redis,
  watch: Pick<
    PullRequestWatch,
    'tenantId' | 'spaceId' | 'owner' | 'repo' | 'number' | 'subject' | 'url' | 'armedAt'
  > &
    Partial<Pick<PullRequestWatch, 'bindingId' | 'ownerSessionId'>>,
  options: { replacingOwner?: string } = {},
): Promise<PullRequestWatch> {
  const key = PULL_REQUEST_WATCH_KEY(watch);
  await redis
    .multi()
    .set(key, polledRecord(watch), 'EX', PULL_REQUEST_WATCH_TTL_SECONDS, 'NX')
    .expire(key, PULL_REQUEST_WATCH_TTL_SECONDS)
    .zadd(PULL_REQUEST_WATCH_DUE_KEY, String(watch.armedAt), dueMember(watch))
    .zadd(PULL_REQUEST_WATCH_SPACE_KEY(watch), String(watch.armedAt), watch.subject)
    .expire(PULL_REQUEST_WATCH_SPACE_KEY(watch), PULL_REQUEST_WATCH_TTL_SECONDS)
    .exec();
  await redis.eval(
    HOLD_PULL_REQUEST_SCRIPT,
    1,
    PULL_REQUEST_WATCH_HOLDER_KEY(watch),
    watch.ownerSessionId ?? '',
    options.replacingOwner ?? '',
    watch.bindingId ?? '',
    String(PULL_REQUEST_WATCH_TTL_SECONDS),
  );
  return (await readWatch(redis, watch)) ?? { ...watch };
}

/** The watch of one pull request, or null where the loop does not watch it. */
export async function readPullRequestWatch(
  redis: Redis,
  ref: WatchRef,
): Promise<PullRequestWatch | null> {
  return readWatch(redis, ref);
}

/**
 * Forget the owner of a pull request where it is still `sessionId`: that
 * conversation has ended, so the pull request is no conversation's and the
 * fallback sweep tends it. One script, so an owner an arm named meanwhile
 * stays, and what the polls saved is left alone.
 */
export async function disownPullRequestWatch(
  redis: Redis,
  ref: WatchRef,
  sessionId: string,
): Promise<void> {
  await redis.eval(DISOWN_PULL_REQUEST_SCRIPT, 1, PULL_REQUEST_WATCH_HOLDER_KEY(ref), sessionId);
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
    .del(PULL_REQUEST_WATCH_HOLDER_KEY(ref))
    .del(PULL_REQUEST_WATCH_LEASE_KEY(ref))
    .zrem(PULL_REQUEST_WATCH_DUE_KEY, dueMember(ref))
    .zrem(PULL_REQUEST_WATCH_SPACE_KEY(ref), ref.subject)
    .exec();
}

/**
 * Save what a poll read and when the pull request is next due, and give up the
 * claim on it. The space's index is renewed with the watch, and holds its
 * member again where it had none, so the sweep's due check sees every watch a
 * poll keeps alive. Who holds the pull request is renewed and never written:
 * the copy a poll claimed may name an owner changed since.
 */
export async function savePullRequestWatch(
  redis: Redis,
  watch: PullRequestWatch,
  nextPollAtMs: number,
): Promise<void> {
  await redis
    .multi()
    .set(PULL_REQUEST_WATCH_KEY(watch), polledRecord(watch), 'EX', PULL_REQUEST_WATCH_TTL_SECONDS)
    .expire(PULL_REQUEST_WATCH_HOLDER_KEY(watch), PULL_REQUEST_WATCH_TTL_SECONDS)
    .zadd(PULL_REQUEST_WATCH_DUE_KEY, String(nextPollAtMs), dueMember(watch))
    .zadd(PULL_REQUEST_WATCH_SPACE_KEY(watch), String(watch.armedAt), watch.subject)
    .expire(PULL_REQUEST_WATCH_SPACE_KEY(watch), PULL_REQUEST_WATCH_TTL_SECONDS)
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
    const watch = await readWatch(redis, ref);
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
