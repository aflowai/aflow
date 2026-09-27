import type postgres from 'postgres';

/**
 * Remove what the withdrawn public concierge lane left on the sessions table.
 *
 * The lane was built, never enabled, and removed; its own migrations were
 * deleted with it, so a database created from scratch never gains these. The
 * ones already migrated still carry them, and a column nothing reads is worse
 * than absent — it reads as a feature to whoever finds it next.
 *
 * Nothing is lost: `public_subject` and `context_policy` were only ever written
 * for anonymous visitor sessions, of which production had none, and
 * `last_activity_at` existed solely as that lane's retention clock.
 */
export async function applyMigration167(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      -- No explicit index drops: Postgres removes an index with the column it
      -- covers, and both of these were partial indexes on the columns below.
      ALTER TABLE "${schemaName}".sessions
        DROP COLUMN IF EXISTS public_subject,
        DROP COLUMN IF EXISTS context_policy,
        DROP COLUMN IF EXISTS last_activity_at;

      -- Seeded for the lane's service principal, and assignable to nothing else.
      -- Matched on is_system_profile as well as the name, exactly as the seeding
      -- migration did: an operator is free to have named their own profile
      -- 'Concierge', and this must not be what removes it.
      DELETE FROM "${schemaName}".space_capability_assignments
        WHERE profile_id IN (
          SELECT id FROM "${schemaName}".capability_profiles
          WHERE name = 'Concierge' AND is_system_profile = true
        );
      DELETE FROM "${schemaName}".capability_profiles
        WHERE name = 'Concierge' AND is_system_profile = true;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (167, 'Drop the withdrawn public concierge lane: session identity columns and the Concierge capability profile')
      ON CONFLICT (version) DO NOTHING;
    `);
}
