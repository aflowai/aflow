/**
 * Tell an exact retry apart from a different action reusing a key.
 *
 * Idempotency keys recorded that an action had been seen, but not what it
 * said. Replaying a key is only safe when the payload is identical — two
 * different answers sent under one key are two actions, and treating the
 * second as a replay of the first would apply the wrong answer while
 * reporting success.
 */
import type postgres from 'postgres';

export async function applyMigration147(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".idempotency_keys
        ADD COLUMN IF NOT EXISTS payload_hash text;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (147, 'Idempotency keys record the payload they were claimed for')
      ON CONFLICT (version) DO NOTHING;
    `);
}
