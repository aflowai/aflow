/**
 * Space model normalization: sharing state derives from membership, not a
 * stored type. Backfills ownership, guarantees the owner's admin membership
 * row, archives orphan spaces, and drops the `type` column together with the
 * one-active-personal-space-per-owner unique index it powered.
 */
import type postgres from 'postgres';
import { schemaNameToTenantId } from '../context.js';

export async function applyMigration142(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  const tenantId = schemaNameToTenantId(schemaName);

  await sqlClient.unsafe(`
      -- Resolve missing ownership from the creator
      UPDATE "${schemaName}".spaces
        SET owner_id = created_by
        WHERE owner_id IS NULL AND created_by IS NOT NULL;

      -- The protected General space is seeded ownerless — adopt it to the
      -- longest-standing active tenant admin instead of treating it as an
      -- orphan below.
      UPDATE "${schemaName}".spaces s
        SET owner_id = (
          SELECT tm.user_id FROM public.tenant_memberships tm
          WHERE tm.tenant_id = '${tenantId}'::uuid
            AND tm.status = 'active'
            AND tm.role IN ('owner', 'admin')
          ORDER BY tm.joined_at ASC NULLS LAST
          LIMIT 1
        )
        WHERE s.slug = 'general' AND s.owner_id IS NULL;

      -- Orphans (no owner, or owner no longer an active tenant member) are
      -- archived; a tenant admin can transfer or purge them from the
      -- Archived list. General is never archived — it stays active even if
      -- no admin could be resolved above.
      UPDATE "${schemaName}".spaces s
        SET archived_at = now()
        WHERE s.archived_at IS NULL
          AND s.slug <> 'general'
          AND (
            s.owner_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM public.tenant_memberships tm
              WHERE tm.tenant_id = '${tenantId}'::uuid
                AND tm.user_id = s.owner_id
                AND tm.status = 'active'
            )
          );

      -- Owner invariant: the owner holds an admin membership row
      UPDATE public.space_memberships m
        SET role = 'admin'
        FROM "${schemaName}".spaces s
        WHERE m.tenant_id = '${tenantId}'::uuid
          AND m.space_id = s.id
          AND m.user_id = s.owner_id
          AND s.archived_at IS NULL
          AND m.role <> 'admin';

      INSERT INTO public.space_memberships (tenant_id, space_id, user_id, role)
        SELECT '${tenantId}'::uuid, s.id, s.owner_id, 'admin'
        FROM "${schemaName}".spaces s
        WHERE s.owner_id IS NOT NULL
          AND s.archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.space_memberships m
            WHERE m.tenant_id = '${tenantId}'::uuid
              AND m.space_id = s.id
              AND m.user_id = s.owner_id
          );

      DROP INDEX IF EXISTS "${schemaName}".idx_spaces_personal_owner;

      ALTER TABLE "${schemaName}".spaces DROP COLUMN IF EXISTS type;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (142, 'Space model: membership-derived sharing state, owner invariant, drop type column')
      ON CONFLICT (version) DO NOTHING;
    `);
}
