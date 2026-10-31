/**
 * A second local user, written straight to the database: a human `users` row
 * with a membership in the pinned tenant.
 *
 * It writes no space and takes any role, which the profile routes of Plan 335
 * P2 do not. A test reaches for it when the membership alone is what it
 * reads, or when it needs a role those routes never give.
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
