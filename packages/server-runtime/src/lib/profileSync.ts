/**
 * Writing back what a login taught the platform about a user.
 *
 * The learned address is committed **last**, after everything it unlocks has
 * been applied. Committing it first makes the repair one-shot: the next login
 * finds the stored address already matching, so it schedules this path again
 * for nobody, and a redemption that failed in between is retried by nothing —
 * the account stays in exactly the state this path exists to repair.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import { and, eq, or } from 'drizzle-orm';
import { users } from '@aflow/database';
import type { UserId } from '@aflow/schemas';
import { redeemSpaceGrantsForVerifiedEmail } from '../services/spaceGrants.js';

export interface ProfileSyncInput {
  db: PostgresJsDatabase;
  redis: Redis | null;
  log: FastifyBaseLogger;
  userId: UserId;
  /** Redis key holding the identity this sync makes stale. */
  identityCacheKey: string;
  /** Values the IdP asserted. An `email` here has already been verified. */
  profile: { avatarUrl?: string; displayName?: string; email?: string };
}

/**
 * Apply an IdP profile to the user row. The two halves are independent: a
 * failure to fill a default display name must not hold back a learned
 * address, and vice versa.
 */
export async function syncUserProfile(input: ProfileSyncInput): Promise<void> {
  const outcomes = await Promise.allSettled([
    applyLearnedIdentity(input),
    fillDefaultDisplayName(input),
  ]);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      input.log.error({ err: outcome.reason, userId: input.userId }, 'Failed to sync user profile');
    }
  }
}

async function applyLearnedIdentity(input: ProfileSyncInput): Promise<void> {
  const { db, redis, log, userId, profile } = input;

  const updates: Record<string, unknown> = {};
  if (profile.avatarUrl) updates['avatarUrl'] = profile.avatarUrl;
  if (profile.email) updates['email'] = profile.email;
  if (Object.keys(updates).length === 0) return;

  if (profile.email) {
    // An address the platform only learns now leaves behind every grant
    // addressed to it while the account was unreachable by email. No
    // admission path will run for this user again, so this is where those
    // grants become memberships — and it runs before the address is stored,
    // so a failure here is retried by the next login rather than sealed in.
    await redeemSpaceGrantsForVerifiedEmail({ db, redis, userId, email: profile.email, log });
  }

  await db.update(users).set(updates).where(eq(users.id, userId));

  // The cached identity still carries the pre-sync values, and every read of
  // it re-derives the same difference — a stale entry turns one repair into a
  // write on each request until it expires.
  await redis?.del(input.identityCacheKey).catch(() => {});
}

/**
 * The IdP name only fills a profile still wearing its default (empty or the
 * email — Auth0 sets name=email for password accounts). A name the person
 * chose on the profile page must survive every future login; this sync used
 * to clobber it back to the email on refresh.
 */
async function fillDefaultDisplayName(input: ProfileSyncInput): Promise<void> {
  const { db, userId, profile } = input;
  if (!profile.displayName) return;

  await db
    .update(users)
    .set({ displayName: profile.displayName })
    .where(
      and(eq(users.id, userId), or(eq(users.displayName, ''), eq(users.displayName, users.email))),
    );
}
