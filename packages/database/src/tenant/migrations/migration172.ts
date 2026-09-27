import type postgres from 'postgres';

/**
 * The durable-event flush cursor: the Redis stream id of the last session
 * event the projection flush persisted to event_log.
 *
 * It lives on the session row because that is the one home that cannot desync
 * from the events it accounts for — the flush advances it in the same
 * transaction as its inserts. Every Redis-side home resets underneath a
 * cursor: the session hash is deleted-then-rewritten under a TTL, and the
 * stream itself is trimmed and eventually deleted. Deriving it from event_log
 * is unsound too — room messages are inserted there directly, out of stream
 * order, and the bigserial has been restarted before.
 *
 * NULL means the flush starts from the head of whatever the stream still
 * holds, deduplicating on event_id. Events evicted before this column existed
 * are gone; no backfill can claim them back.
 */
export async function applyMigration172(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".sessions
        ADD COLUMN IF NOT EXISTS last_flushed_event_stream_id TEXT;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (172, 'Per-session durable-event flush cursor (Redis stream id)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
