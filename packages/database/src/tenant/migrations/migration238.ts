import type postgres from 'postgres';

/**
 * An OAuth token row says which account it connects and since when.
 * `account_identity` is what the provider reported at consent, and NULL when
 * it reported none. `connected_at` is the consent time, which a refresh leaves
 * alone. `obtained_at` moves on every refresh, so it cannot answer "since
 * when". Rows written before this carry NULL in both, because nothing knows
 * them.
 */
export async function applyMigration238(client: postgres.Sql, schema: string): Promise<void> {
  await client.unsafe(`
    ALTER TABLE "${schema}".oauth_tokens
      ADD COLUMN IF NOT EXISTS account_identity text,
      ADD COLUMN IF NOT EXISTS connected_at timestamptz;
    INSERT INTO "${schema}".schema_migrations (version, description)
    VALUES (238, 'OAuth tokens record the connected account and the consent time')
    ON CONFLICT (version) DO NOTHING;
  `);
}
