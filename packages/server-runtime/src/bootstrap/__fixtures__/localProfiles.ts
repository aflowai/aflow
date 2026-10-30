/**
 * A second local user, as the profile routes of Plan 335 P2 will add one.
 *
 * Until those routes exist this is the only way a local install gains a second
 * profile: a human `users` row with a membership in the pinned tenant. It
 * writes no space, because P1's rule reads the membership alone.
 */
import { randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { tenantMemberships, users } from '@aflow/database';

export async function seedLocalProfile(
  db: PostgresJsDatabase,
  options: {
    tenantId: string;
    displayName: string;
    role?: 'admin' | 'member' | 'viewer';
    membership?: 'active' | 'pending';
  },
): Promise<string> {
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    displayName: options.displayName,
    kind: 'human',
    status: 'active',
  });
  await db.insert(tenantMemberships).values({
    tenantId: options.tenantId,
    userId,
    role: options.role ?? 'member',
    status: options.membership ?? 'active',
  });
  return userId;
}
