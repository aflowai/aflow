import type postgres from 'postgres';

/**
 * Keep a label-queue item's exchange with the item.
 *
 * A queue item is a durable row pointing at a trial run inside a throwaway
 * fixture space. The space is collected at expiry, so the evidence the item
 * exists to have reviewed disappears out from under it and the item becomes
 * unreviewable — silently, and with no deadline shown anywhere. A queue that
 * decays this way under-samples judge calibration by construction.
 *
 * The exchange is two strings and is snapshotted when the item is minted, so
 * an item stays reviewable for as long as it is pending.
 */
export async function applyMigration200(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".eval_label_queue
        ADD COLUMN IF NOT EXISTS conversation_json jsonb;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (200, 'eval_label_queue.conversation_json — the exchange survives its fixture space')
      ON CONFLICT (version) DO NOTHING;
    `);
}
