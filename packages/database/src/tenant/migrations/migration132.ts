import type postgres from 'postgres';

export async function applyMigration132(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".coach_learnings
        ADD COLUMN IF NOT EXISTS resolution_note TEXT;

      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = COALESCE(
        (
          SELECT jsonb_agg(elem)
          FROM jsonb_array_elements(allowed_capabilities) AS elem
          WHERE elem->>'capabilityGroupId' <> 'learner.scarcity'
        ),
        '[]'::jsonb
      )
      WHERE allowed_capabilities::text LIKE '%learner.scarcity%';

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (132, 'Plan 234 B1 — coach_learnings.resolution_note; drop learner.scarcity capability group from profiles')
      ON CONFLICT (version) DO NOTHING;
    `);
}
