/**
 * Tenant migration 60 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration060(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".spaces
      SET directives = jsonb_strip_nulls(
        jsonb_build_object(
          'version', 1,
          'responsibility', COALESCE(
            NULLIF(directives->'scope'->>'responsibility', ''),
            NULLIF(directives->>'responsibility', ''),
            'Define what this entity is responsible for.'
          ),
          'priorities', jsonb_path_query_array(
            COALESCE(directives->'domainGuidance'->'priorities', directives->'priorities', '[]'::jsonb),
            '$[0 to 4]'
          ),
          'style', NULLIF(COALESCE(directives->'tone'->>'style', directives->>'style', ''), ''),
          'resourceBudget', directives->'resourceBudget',
          'modelDefaults', directives->'modelDefaults',
          'learningPolicy', directives->'learningPolicy',
          'training', directives->'training'
        )
      )
      WHERE directives IS NOT NULL
        AND (
          directives ? 'scope'
          OR directives ? 'boundaries'
          OR directives ? 'tone'
          OR directives ? 'domainGuidance'
        );
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (60, 'Plan 112 — flatten cybernetic directives (drop scope/boundaries/tone/domainGuidance)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
