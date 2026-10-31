/**
 * Local profiles as the API sees them (Plan 335 P1): the session that names
 * one, and whether the install has more than one.
 *
 * A profile is a `users` row with an active membership in the pinned tenant.
 * The session is a signed user id, its issue time and the user's session
 * generation. It holds no state of its own. Removing a profile's membership
 * ends its sessions, through the tenant plugin's membership read. Bumping the
 * user's generation ends every session issued before the bump. Rotating the
 * instance secret ends every session at once.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { tenantMemberships, users } from '@aflow/database';
import type { UserId } from '@aflow/schemas';

const SESSION_VERSION = 'v2';

/** What a session this instance issued says. */
export interface LocalProfileSession {
  userId: UserId;
  /** Unix seconds. Signed, so a later rule can bound a session's age. */
  issuedAt: number;
  /** The user's session generation when the session was issued. */
  generation: number;
}

/**
 * Signs with a key derived from the instance secret rather than the secret
 * itself, so a session value is never a MAC the secret produces for any other
 * purpose.
 */
function sessionMac(payload: string, instanceSecret: string): Buffer {
  const key = createHmac('sha256', instanceSecret).update('aflow-local-profile-session').digest();
  return createHmac('sha256', key).update(payload).digest();
}

const isUuid = (value: string): boolean => z.string().uuid().safeParse(value).success;

/** A non-negative integer with no leading zero, so one value has one spelling. */
const COUNTER = /^(0|[1-9][0-9]{0,14})$/;

/**
 * The session value for one profile. The API issues it when a profile is
 * chosen, and the web process keeps it in the browser's cookie.
 *
 * `generation` must be the user's current one
 * (`readLocalProfileSessionGeneration`), or the session is refused on its
 * first use. A user nothing has bumped is at 0.
 */
export function issueLocalProfileSession(
  userId: string,
  instanceSecret: string,
  opts: { generation?: number; issuedAt?: number } = {},
): string {
  if (instanceSecret === '') throw new Error('A profile session needs the instance secret.');
  if (!isUuid(userId)) throw new Error(`A profile session names a user id. Received "${userId}".`);
  const issuedAt = opts.issuedAt ?? Math.floor(Date.now() / 1000);
  const generation = opts.generation ?? 0;
  for (const [name, value] of [
    ['issue time', issuedAt],
    ['generation', generation],
  ] as const) {
    if (!COUNTER.test(String(value))) {
      throw new Error(`A profile session's ${name} is a whole number. Received ${value}.`);
    }
  }
  const payload = `${SESSION_VERSION}.${userId}.${issuedAt}.${generation}`;
  return `${payload}.${sessionMac(payload, instanceSecret).toString('base64url')}`;
}

/** What a session says, or null for anything this instance did not issue. */
export function readLocalProfileSession(
  value: string,
  instanceSecret: string,
): LocalProfileSession | null {
  if (instanceSecret === '') return null;
  const [version, userId, issuedAt, generation, mac, ...rest] = value.split('.');
  if (rest.length > 0 || version !== SESSION_VERSION) return null;
  if (userId === undefined || mac === undefined || !isUuid(userId)) return null;
  if (issuedAt === undefined || !COUNTER.test(issuedAt)) return null;
  if (generation === undefined || !COUNTER.test(generation)) return null;
  const presented = Buffer.from(mac, 'base64url');
  const expected = sessionMac(
    `${SESSION_VERSION}.${userId}.${issuedAt}.${generation}`,
    instanceSecret,
  );
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  return { userId: userId as UserId, issuedAt: Number(issuedAt), generation: Number(generation) };
}

/** The user's current session generation, or null when no such user exists. */
export async function readLocalProfileSessionGeneration(
  db: PostgresJsDatabase,
  userId: string,
): Promise<number | null> {
  const rows = await db
    .select({ generation: users.profileSessionGeneration })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.generation ?? null;
}

/**
 * Ends every profile session issued to the user so far, and returns the
 * generation a new session must carry.
 *
 * Call it whenever a profile's authentication state changes. Plan 335 P2 calls
 * it before removing a profile, so a session in use is refused from then on.
 */
export async function bumpLocalProfileSessionGeneration(
  db: PostgresJsDatabase,
  userId: string,
): Promise<number> {
  const rows = await db
    .update(users)
    .set({ profileSessionGeneration: sql`${users.profileSessionGeneration} + 1` })
    .where(eq(users.id, userId))
    .returning({ generation: users.profileSessionGeneration });
  const generation = rows[0]?.generation;
  if (generation === undefined) throw new Error(`No user ${userId} to end the sessions of.`);
  return generation;
}

/** What a read of the pinned tenant's profiles answers: one, or two and more. */
export type ReadLocalProfileCount = 'one' | 'several';

/**
 * How many profiles the pinned tenant has.
 *
 * Reads at most two rows, because the rule this feeds asks only that. A
 * service principal is not a profile, so only human users count. No row at
 * all answers `one`.
 */
export async function readLocalProfileCount(
  db: PostgresJsDatabase,
  tenantId: string,
): Promise<ReadLocalProfileCount> {
  const rows = await db
    .select({ userId: tenantMemberships.userId })
    .from(tenantMemberships)
    .innerJoin(users, eq(users.id, tenantMemberships.userId))
    .where(
      and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.status, 'active'),
        eq(users.kind, 'human'),
      ),
    )
    .limit(2);
  return rows.length > 1 ? 'several' : 'one';
}

/** How long a profile count answers before the next request reads it again. */
export const LOCAL_PROFILE_COUNT_TTL_MS = 5_000;

/**
 * What the auth plugin knows of the profile count. `unread` means no read has
 * succeeded within the lifetime, and no earlier read saw two profiles.
 */
export type LocalProfileCount = ReadLocalProfileCount | 'unread';

/** The cached count, and the hook that forgets it. */
export type CachedLocalProfileCount = (() => Promise<LocalProfileCount>) & {
  drop: () => void;
};

/**
 * `read`, answered from memory between reads.
 *
 * Every browser request without a profile session asks the count, so an
 * uncached read would put Postgres on the path of each one. A fresh count
 * answers with no read. A stale or absent one triggers a single read that
 * concurrent callers share.
 *
 * The returned function never rejects. When a read fails, a count last read
 * as two or more still answers `several`, which refuses a browser and grants
 * nothing. Anything else answers `unread`: no count since the process started,
 * or a stale count of one. A second profile may exist in either case, so
 * neither may grant the sole-profile owner (Plan 335 §10). The failure is not
 * cached, so the next request reads again.
 *
 * `drop` forgets the count, so the next request reads it again. A read already
 * in flight still answers its callers but no longer fills the cache, because
 * it may have started before the change that prompted the drop.
 */
export function cacheLocalProfileCount(
  read: () => Promise<ReadLocalProfileCount>,
  opts: {
    ttlMs?: number | undefined;
    now?: () => number;
    onReadError?: (err: unknown) => void;
  } = {},
): CachedLocalProfileCount {
  const ttlMs = opts.ttlMs ?? LOCAL_PROFILE_COUNT_TTL_MS;
  const now = opts.now ?? Date.now;
  let cached: { count: ReadLocalProfileCount; readAt: number } | undefined;
  let inFlight: Promise<LocalProfileCount> | undefined;
  let epoch = 0;

  const count = () => {
    if (cached !== undefined && now() - cached.readAt < ttlMs) {
      return Promise.resolve<LocalProfileCount>(cached.count);
    }
    if (inFlight !== undefined) return inFlight;
    const readEpoch = epoch;
    const pending = (async (): Promise<LocalProfileCount> => {
      try {
        const answer = await read();
        if (readEpoch === epoch) cached = { count: answer, readAt: now() };
        return answer;
      } catch (err) {
        opts.onReadError?.(err);
        return cached?.count === 'several' ? 'several' : 'unread';
      }
    })();
    inFlight = pending;
    void pending.then(() => {
      if (inFlight === pending) inFlight = undefined;
    });
    return pending;
  };

  return Object.assign(count, {
    drop: (): void => {
      epoch += 1;
      cached = undefined;
      inFlight = undefined;
    },
  });
}
