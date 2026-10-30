/**
 * Local profiles as the API sees them (Plan 335 P1): the session that names
 * one, and whether the install has more than one.
 *
 * A profile is a `users` row with an active membership in the pinned tenant.
 * The session is a signed user id and nothing more. It holds no state, so
 * removing a profile's membership is what ends its sessions, and the tenant
 * plugin's membership read is where that lands. Rotating the instance secret
 * ends every session at once.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { tenantMemberships, users } from '@aflow/database';
import type { UserId } from '@aflow/schemas';

const SESSION_VERSION = 'v1';

/**
 * Signs with a key derived from the instance secret rather than the secret
 * itself, so a session value is never a MAC the secret produces for any other
 * purpose.
 */
function sessionMac(userId: string, instanceSecret: string): Buffer {
  const key = createHmac('sha256', instanceSecret).update('aflow-local-profile-session').digest();
  return createHmac('sha256', key).update(`${SESSION_VERSION}.${userId}`).digest();
}

const isUuid = (value: string): boolean => z.string().uuid().safeParse(value).success;

/**
 * The session value for one profile. The API issues it when a profile is
 * chosen, and the web process keeps it in the browser's cookie.
 */
export function issueLocalProfileSession(userId: string, instanceSecret: string): string {
  if (instanceSecret === '') throw new Error('A profile session needs the instance secret.');
  if (!isUuid(userId)) throw new Error(`A profile session names a user id. Received "${userId}".`);
  return `${SESSION_VERSION}.${userId}.${sessionMac(userId, instanceSecret).toString('base64url')}`;
}

/** The user a session names, or null for anything this instance did not issue. */
export function readLocalProfileSession(value: string, instanceSecret: string): UserId | null {
  if (instanceSecret === '') return null;
  const [version, userId, mac, ...rest] = value.split('.');
  if (rest.length > 0 || version !== SESSION_VERSION) return null;
  if (userId === undefined || mac === undefined || !isUuid(userId)) return null;
  const presented = Buffer.from(mac, 'base64url');
  const expected = sessionMac(userId, instanceSecret);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  return userId as UserId;
}

/**
 * Whether the pinned tenant has two or more profiles.
 *
 * Reads at most two rows, because the rule this feeds asks only that. A
 * service principal is not a profile, so only human users count.
 */
export async function hasSeveralLocalProfiles(
  db: PostgresJsDatabase,
  tenantId: string,
): Promise<boolean> {
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
  return rows.length > 1;
}
