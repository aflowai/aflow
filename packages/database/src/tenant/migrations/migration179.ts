import type postgres from 'postgres';

/**
 * Media generation spends real money per call, so `ai.media` is a write
 * capability. The profiles that gain it already authorize comparable spend
 * through `ai.agent` and `api.http`; the viewer profile deliberately does not.
 *
 * The dead `ai.media:read` is dropped from every profile, operator-authored
 * ones included. The group has no read mode left, so the entry authorizes
 * nothing wherever it is stored — removing it cannot widen or narrow a profile.
 * Left in place it would keep reading as a media grant on a profile that can no
 * longer generate media, which is the same loss with no way to notice it. An
 * operator-authored profile that held it is named in a NOTICE so the deploy log
 * records who has to re-grant `ai.media:write` deliberately.
 */
export async function applyMigration179(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"ai.media","accessMode":"write"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name IN ('Full Access', 'Standard', 'Personal Safe')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"ai.media","accessMode":"write"}]'::jsonb);

      DO $migration179$
      DECLARE
        orphaned text;
      BEGIN
        SELECT string_agg(quote_literal(name), ', ' ORDER BY name) INTO orphaned
        FROM "${schemaName}".capability_profiles
        WHERE is_system_profile = false
          AND allowed_capabilities @> '[{"capabilityGroupId":"ai.media","accessMode":"read"}]'::jsonb
          AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"ai.media","accessMode":"write"}]'::jsonb);

        IF orphaned IS NOT NULL THEN
          RAISE NOTICE 'schema %: capability profiles % held ai.media:read, which no longer authorizes any operation. Grant ai.media:write to restore media generation.', '${schemaName}', orphaned;
        END IF;
      END
      $migration179$;

      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = COALESCE((
          SELECT jsonb_agg(e)
          FROM jsonb_array_elements(allowed_capabilities) AS e
          WHERE NOT (e @> '{"capabilityGroupId":"ai.media","accessMode":"read"}'::jsonb)
        ), '[]'::jsonb)
      WHERE allowed_capabilities @> '[{"capabilityGroupId":"ai.media","accessMode":"read"}]'::jsonb;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (179, 'Paid media generation is a write capability (ai.media)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
