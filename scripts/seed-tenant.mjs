#!/usr/bin/env node

/**
 * Seed the default tenant in a fresh database.
 *
 * Creates:
 * 1. The tenant row in public.tenants
 * 2. The tenant schema with all migrations applied
 * 3. A "General" space in the tenant
 * 4. Fixes any orphaned users by adding tenant_memberships
 *
 * Safe to re-run (all operations are idempotent).
 */

import {
  getConnection,
  closeConnection,
  createTenantSchema,
  tenantSchemaExists,
  tenantIdToSchemaName,
} from '@aflow/database';

const TENANT_ID = process.env.DEFAULT_TENANT_ID || 'a0000000-0000-0000-0000-000000000001';
const TENANT_NAME = process.env.TENANT_NAME || 'Aflow';

async function main() {
  console.log(`[seed-tenant] Seeding tenant ${TENANT_ID} (${TENANT_NAME})...\n`);

  const sql = getConnection();
  const schemaName = tenantIdToSchemaName(TENANT_ID);

  // 1. Ensure tenant row exists
  console.log('[seed-tenant] Ensuring tenant row...');
  await sql`
    INSERT INTO public.tenants (tenant_id, schema_name, name, status, plan)
    VALUES (${TENANT_ID}, ${schemaName}, ${TENANT_NAME}, 'active', 'free')
    ON CONFLICT (tenant_id) DO UPDATE SET
      name = EXCLUDED.name,
      updated_at = NOW()
  `;
  console.log(`[seed-tenant] ✓ Tenant row: ${TENANT_ID} → ${schemaName}`);

  // 2. Ensure tenant schema + migrations
  const exists = await tenantSchemaExists(sql, TENANT_ID);
  if (exists) {
    console.log(`[seed-tenant] ✓ Tenant schema already exists: ${schemaName}`);
  } else {
    console.log('[seed-tenant] Creating tenant schema...');
    await createTenantSchema(sql, TENANT_ID);
    console.log(`[seed-tenant] ✓ Created tenant schema: ${schemaName}`);
  }

  // 3. Ensure "General" space exists
  console.log('[seed-tenant] Ensuring General space...');
  await sql.unsafe(`
    INSERT INTO "${schemaName}".spaces (id, name, slug, type, created_at, updated_at)
    VALUES (gen_random_uuid(), 'General', 'general', 'shared', NOW(), NOW())
    ON CONFLICT DO NOTHING
  `);
  console.log('[seed-tenant] ✓ General space ready');

  // 4. Fix orphaned users — add tenant_memberships for any users without one
  console.log('[seed-tenant] Fixing orphaned users...');
  const result = await sql`
    INSERT INTO public.tenant_memberships (tenant_id, user_id, role, status, joined_at)
    SELECT ${TENANT_ID}, u.id, 'member', 'active', NOW()
    FROM public.users u
    WHERE NOT EXISTS (
      SELECT 1 FROM public.tenant_memberships tm
      WHERE tm.user_id = u.id AND tm.tenant_id = ${TENANT_ID}
    )
    RETURNING user_id
  `;
  if (result.length > 0) {
    console.log(`[seed-tenant] ✓ Added ${result.length} user(s) to tenant`);
  } else {
    console.log('[seed-tenant] ✓ No orphaned users');
  }

  // 5. Auto-join orphaned tenant members to General space
  console.log('[seed-tenant] Auto-joining users to General space...');
  const generalSpace = await sql.unsafe(`
    SELECT id FROM "${schemaName}".spaces WHERE slug = 'general' LIMIT 1
  `);
  if (generalSpace.length > 0) {
    const spaceId = generalSpace[0].id;
    const joined = await sql`
      INSERT INTO public.space_memberships (space_id, user_id, role, tenant_id)
      SELECT ${spaceId}, tm.user_id, 'editor', ${TENANT_ID}
      FROM public.tenant_memberships tm
      WHERE tm.tenant_id = ${TENANT_ID}
        AND NOT EXISTS (
          SELECT 1 FROM public.space_memberships sm
          WHERE sm.user_id = tm.user_id AND sm.space_id = ${spaceId}
        )
      RETURNING user_id
    `;
    if (joined.length > 0) {
      console.log(`[seed-tenant] ✓ Added ${joined.length} user(s) to General space`);
    } else {
      console.log('[seed-tenant] ✓ All users already in General space');
    }
  }

  await closeConnection();
  console.log('\n[seed-tenant] Done.');
}

// eslint-disable-next-line @typescript-eslint/use-unknown-in-catch-callback-variable -- .mjs has no type annotations
main().catch((err) => {
  console.error('[seed-tenant] Fatal:', err);
  process.exit(1);
});
