import type postgres from 'postgres';

/**
 * The API executor no longer files a receipt per successful call under
 * `/coach/evidence/`: nothing read one back, so the subtree was a write per
 * call that only grew. Its documents and directories go; their chunks,
 * versions and links cascade.
 */
export async function applyMigration223(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      DELETE FROM "${schemaName}".memory_docs
      WHERE path LIKE '/coach/evidence/%';

      DELETE FROM "${schemaName}".memory_dirs
      WHERE path = '/coach/evidence' OR path LIKE '/coach/evidence/%';

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (223, 'Remove the unread /coach/evidence API-call receipts')
      ON CONFLICT (version) DO NOTHING;
  `);
}
