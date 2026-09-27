import type postgres from 'postgres';

/**
 * Clear `egress_hosts` on every repo designation.
 *
 * The field was judged against the tenant host allowlist at write, stored, and
 * rendered back — and never read at execution, so it constrained no run. The
 * write boundary now refuses a non-empty value, which would leave existing rows
 * as the only ones carrying a restriction nothing applies.
 *
 * Cleared rather than refused at execution, because every stored value came from
 * a form that prefilled it from the repo the operator typed: the values are not
 * decisions anyone made, so refusing a run over one would explain an intent that
 * never existed. The execution-side refusal stays for the genuine case — a row
 * written between this migration and the deploy that added the refusal.
 */
export async function applyMigration180(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".repo_bindings
        SET egress_hosts = '[]'::jsonb,
            updated_at = NOW()
        WHERE egress_hosts IS NOT NULL
          AND egress_hosts <> '[]'::jsonb;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (180, 'Plan 286 Phase 1b — clear unenforced repo-designation egress hosts')
      ON CONFLICT (version) DO NOTHING;
    `);
}
