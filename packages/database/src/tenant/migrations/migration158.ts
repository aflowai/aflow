import type postgres from 'postgres';

export async function applyMigration158(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      DROP TABLE IF EXISTS "${schemaName}".eval_runs;
      DROP TABLE IF EXISTS "${schemaName}".eval_suites;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (158, 'Drop eval_suites and eval_runs — the standalone eval stack is replaced by the cybernetic eval plane')
      ON CONFLICT (version) DO NOTHING;
    `);
}
