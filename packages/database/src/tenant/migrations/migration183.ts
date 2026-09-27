import type postgres from 'postgres';

/**
 * Drop the capability entries left behind by the deleted standalone eval stack.
 *
 * `eval.analysis`, `eval.manage`, `eval.read` and `eval.run` covered operations
 * that no longer exist, so the entries authorize nothing wherever they are
 * stored and removing them cannot widen or narrow a profile. The eval plane's
 * live groups are `eval.dataset`, `eval.case` and `eval.batch`, granted
 * separately — a profile that keeps a dead entry reads as holding eval
 * authority it does not have, which is the kind of gap nothing later surfaces.
 */
const DEAD_EVAL_GROUPS = ['eval.analysis', 'eval.manage', 'eval.read', 'eval.run'];

export async function applyMigration183(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  const deadGroupsLiteral = DEAD_EVAL_GROUPS.map((g) => `'${g}'`).join(', ');
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = COALESCE((
          SELECT jsonb_agg(e)
          FROM jsonb_array_elements(allowed_capabilities) AS e
          WHERE e->>'capabilityGroupId' NOT IN (${deadGroupsLiteral})
        ), '[]'::jsonb)
      WHERE EXISTS (
        SELECT 1
        FROM jsonb_array_elements(allowed_capabilities) AS e
        WHERE e->>'capabilityGroupId' IN (${deadGroupsLiteral})
      );

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (183, 'Drop dead capability entries from the deleted standalone eval stack')
      ON CONFLICT (version) DO NOTHING;
    `);
}
