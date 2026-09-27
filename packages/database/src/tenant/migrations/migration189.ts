import type postgres from 'postgres';
import { simulatedFulfillmentIndexDdl } from '../simulatedFulfillmentIndex.js';

/**
 * The index that lets a session answer "was any of this rehearsed?" without
 * reading its own history.
 *
 * A run banner that says the room is a rehearsal has to keep saying it — one
 * fabricated fact makes the whole room one, however long ago it was fabricated.
 * That claim was carried by folding every event the session ever emitted, so
 * the mount paid for the whole log to learn something true of a handful of
 * rows: on an 83,468-event session the scan removed 83,468 rows by filter to
 * return four.
 *
 * Partial on the flag, so it indexes only the events that carry it — measured
 * at 16 kB against a 268 MB table, and 151.9 ms down to 0.07 ms on that
 * session.
 */
export async function applyMigration189(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ${simulatedFulfillmentIndexDdl(schemaName)}

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (189, 'Partial index on simulated fulfillment so a session derives its rehearsed bindings without a full scan')
      ON CONFLICT (version) DO NOTHING;
    `);
}
