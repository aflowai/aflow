import { and, eq } from 'drizzle-orm';
import { type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { capabilityProfiles } from '../schema/tenant.js';

/**
 * The system profile a newly provisioned space wears when no explicit choice
 * exists: `Personal Safe` under a member-safe default, otherwise the tenant's
 * admin role default. One resolver for every space-creation path — the REST
 * route and the agent inline op must assign the same profile for the same
 * creator. Runs on the caller's tenant-schema transaction.
 */
export async function findDefaultCapabilityProfileId(
  tx: PostgresJsDatabase,
  opts: { memberSafeDefault: boolean },
): Promise<string | undefined> {
  const rows = await tx
    .select({ id: capabilityProfiles.id })
    .from(capabilityProfiles)
    .where(
      opts.memberSafeDefault
        ? and(
            eq(capabilityProfiles.isSystemProfile, true),
            eq(capabilityProfiles.name, 'Personal Safe'),
          )
        : and(
            eq(capabilityProfiles.isSystemProfile, true),
            eq(capabilityProfiles.defaultForRole, 'admin'),
          ),
    )
    .limit(1);
  return rows[0]?.id;
}
