/**
 * The index that answers "was any of this session rehearsed?", and the two
 * expressions it is built from.
 *
 * The reader's WHERE clause and the index's predicate have to be the same
 * expression or Postgres cannot match them, and a mismatch is silent — the
 * query keeps returning the right answer while scanning the session's whole
 * history to find it. They are one string here so the two cannot drift.
 *
 * `envelope` is left unqualified: Postgres normalizes the predicate to a column
 * reference either way, so the same text serves the CREATE INDEX (where the
 * table is implied) and a query that qualifies it.
 */

export const SIMULATED_FULFILLMENT_INDEX_NAME = 'idx_event_log_simulated_binding';

/** Marks an event whose step was answered by a simulation rather than a real party. */
export const SIMULATED_EVENT_PREDICATE = `(envelope->'metadata'->>'simulated') = 'true'`;

/** The binding that answered it — carried in the index so the read skips the heap. */
export const SIMULATED_BINDING_EXPRESSION = `envelope->'metadata'->>'simulatedBindingId'`;

export function simulatedFulfillmentIndexDdl(schemaName: string): string {
  return `
      CREATE INDEX IF NOT EXISTS ${SIMULATED_FULFILLMENT_INDEX_NAME}
        ON "${schemaName}".event_log (session_id, (${SIMULATED_BINDING_EXPRESSION}))
        WHERE ${SIMULATED_EVENT_PREDICATE};
  `;
}
