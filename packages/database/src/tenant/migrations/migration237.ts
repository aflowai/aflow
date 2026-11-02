import type postgres from 'postgres';

/**
 * Plan 339 D6: a card's `waitsOn.reason` names no `design_document`. A stored
 * card that does waits on the operator's design decision, so it now says
 * `design_decision`. Its decision text and the rail's Approve stay.
 */
export async function applyMigration237(client: postgres.Sql, schema: string): Promise<void> {
  await client.unsafe(`
    UPDATE "${schema}".plan_nodes
      SET card = jsonb_set(card, '{waitsOn,reason}', '"design_decision"'::jsonb)
      WHERE card -> 'waitsOn' ->> 'reason' = 'design_document';
    INSERT INTO "${schema}".schema_migrations (version, description)
    VALUES (237, 'Plan 339 — a card that waits on design_document waits on design_decision')
    ON CONFLICT (version) DO NOTHING;
  `);
}
