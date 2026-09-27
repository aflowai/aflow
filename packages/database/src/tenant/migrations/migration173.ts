import type postgres from 'postgres';

/**
 * The hot-state clock of the last projection that wrote this session row.
 *
 * Every orchestrator runs a projection worker, and a claim's exclusivity ends
 * at its Redis lease: a worker that stalls past it can wake and write a state
 * a peer has already superseded. The upserts fence on this column — a write
 * whose hot-state clock is older than the row's is skipped whole — so a stale
 * projector cannot regress the durable status or clear the completion mark.
 *
 * NULL accepts any write: rows from before the column, and the first
 * projection of a new session.
 */
export async function applyMigration173(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".sessions
        ADD COLUMN IF NOT EXISTS hot_state_updated_at TIMESTAMPTZ;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (173, 'Hot-state clock fence for the sessions projection upserts')
      ON CONFLICT (version) DO NOTHING;
    `);
}
