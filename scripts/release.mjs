#!/usr/bin/env node

/**
 * Brings a database up to date before the services that use it start: the
 * appliance's migrate service and the hosted deploy both run it.
 *
 * 1. Apply public-schema migrations (tenants table, catalogs, etc.)
 * 2. Apply tenant-schema migrations to all existing tenants
 * 3. Seed the model catalog
 *
 * All migrations use IF NOT EXISTS / ON CONFLICT, so they're safe to re-run.
 */

import {
  getConnection,
  getDatabaseConfig,
  closeConnection,
  applyPublicMigrations,
  applyIdentityMigrations,
  applyRecoveryMigrations,
  applyOnboardingMigrations,
  applyErrorReportsMigration,
  applyInviteHardeningMigrations,
  applyOAuthOwnershipMigrations,
  applyStoreGovernanceMigrations,
  applyCapabilityGovernanceMigrations,
  applyInviteRequestMigrations,
  applySpaceGrantMigrations,
  applyWorkflowRunDueMigrations,
  applyTenantDuePointerMigrations,
  applyScheduleDispatchOutboxMigration,
  applyProjectionFailuresMigration,
  applyTimerDeadLettersMigration,
  applyConciergeConfigRemovalMigration,
  applyIdentityProviderKeyMigration,
  applyAgentModelAllowlistMigration,
  seedPublicTenantFreemiumDefaults,
  seedModelCatalog,
  applyMigrationsToAllTenants,
  createTenantSchema,
  tenantSchemaExists,
} from '@aflow/database';

/** @param {unknown} e */
function errToStr(e) {
  if (e == null) return '';
  if (typeof e === 'object') return JSON.stringify(e);
  if (typeof e === 'string') return e;
  if (typeof e === 'number' || typeof e === 'boolean' || typeof e === 'bigint') return String(e);
  return '[unknown error]';
}

async function main() {
  console.log('[release] Starting database migrations...\n');

  // One connection: applying tenant migrations issues its own transactions,
  // which a pooled client refuses with UNSAFE_TRANSACTION.
  const sql = getConnection({ ...getDatabaseConfig(), maxConnections: 1 });

  // 1. Public schema
  console.log('[release] Applying public schema migrations...');
  await applyPublicMigrations(sql);
  console.log('[release] ✓ Public schema ready');

  // 2. Identity & auth tables
  console.log('[release] Applying identity migrations...');
  await applyIdentityMigrations(sql);
  console.log('[release] ✓ Identity schema ready');

  console.log('[release] Applying recovery migrations...');
  await applyRecoveryMigrations(sql);
  console.log('[release] ✓ Recovery schema ready');

  console.log('[release] Applying onboarding migrations...');
  await applyOnboardingMigrations(sql);
  console.log('[release] ✓ Onboarding schema ready');

  console.log('[release] Applying invite hardening migrations...');
  await applyInviteHardeningMigrations(sql);
  console.log('[release] ✓ Invite hardening ready');

  console.log('[release] Applying OAuth ownership policy migrations...');
  await applyOAuthOwnershipMigrations(sql);
  console.log('[release] ✓ OAuth ownership policy ready');

  console.log('[release] Applying error reports migration...');
  await applyErrorReportsMigration(sql);
  console.log('[release] ✓ Error reports schema ready');

  console.log('[release] Applying store governance migrations...');
  await applyStoreGovernanceMigrations(sql);
  await applyCapabilityGovernanceMigrations(sql);
  console.log('[release] ✓ Store governance policy ready');

  console.log('[release] Applying invite request migrations...');
  await applyInviteRequestMigrations(sql);
  await applySpaceGrantMigrations(sql);
  console.log('[release] ✓ Invite requests ready');

  console.log('[release] Applying due pointer migrations...');
  await applyWorkflowRunDueMigrations(sql);
  await applyTenantDuePointerMigrations(sql);
  await applyScheduleDispatchOutboxMigration(sql);
  await applyProjectionFailuresMigration(sql);
  await applyTimerDeadLettersMigration(sql);
  console.log('[release] ✓ Due pointers ready');

  console.log('[release] Applying identity provider key migration...');
  await applyIdentityProviderKeyMigration(sql);
  console.log('[release] ✓ Identity provider key normalised');

  console.log('[release] Removing the withdrawn concierge lane config column...');
  await applyConciergeConfigRemovalMigration(sql);
  console.log('[release] ✓ Concierge config column removed');

  console.log('[release] Applying tenant agent-model allowlist migration...');
  await applyAgentModelAllowlistMigration(sql);
  console.log('[release] ✓ Tenant agent-model allowlist ready');

  // 6b. Freemium spend bounds on the public tenant (generous but bounded).
  const publicTenantId = process.env['DEFAULT_TENANT_ID'];
  if (publicTenantId) {
    await seedPublicTenantFreemiumDefaults(sql, publicTenantId);
    console.log(`[release] ✓ Freemium defaults ensured on public tenant ${publicTenantId}`);
  }

  // 7. Seed model catalog
  console.log('[release] Seeding model catalog...');
  await seedModelCatalog(sql);
  console.log('[release] ✓ Model catalog seeded');

  // 8. Create missing tenant schemas (e.g., after infra:reset or fresh setup)
  const tenantRows = await sql`SELECT tenant_id FROM public.tenants WHERE status = 'active'`;
  for (const row of tenantRows) {
    const tenantId = /** @type {string} */ (row.tenant_id);
    const exists = await tenantSchemaExists(sql, tenantId);
    if (!exists) {
      console.log(`[release] Creating tenant schema for ${tenantId}...`);
      await createTenantSchema(sql, tenantId);
      console.log(`[release]   ✓ Created`);
    }
  }

  // 9. Tenant schema migrations (for all existing tenants)
  console.log('[release] Applying tenant schema migrations...');
  const results = await applyMigrationsToAllTenants(sql);

  for (const schema of results.success) {
    console.log(`[release]   ✓ ${schema}`);
  }
  for (const { schema, error } of results.failed) {
    console.error(
      `[release]   ✗ ${schema}: ${error instanceof Error ? error.message : errToStr(error)}`,
    );
  }

  if (results.success.length > 0 || results.failed.length > 0) {
    console.log(
      `[release] Tenants: ${String(results.success.length)} succeeded, ${String(results.failed.length)} failed`,
    );
  } else {
    console.log('[release] No existing tenants to migrate');
  }

  if (results.failed.length > 0) {
    await closeConnection();
    console.error(
      `\n[release] FAILED — ${String(results.failed.length)} tenant migration(s) failed`,
    );
    process.exit(1);
  }

  try {
    const {
      getRedisConfig,
      createRedisConnection,
      relabelEntityEventStreams104a,
      quitRedisWithTimeout,
    } = await import('@aflow/redis');
    if (process.env['REDIS_URL'] || process.env['REDIS_HOST']) {
      const redis = createRedisConnection(getRedisConfig());
      const relabel = await relabelEntityEventStreams104a(redis);
      console.log(
        `[release] 104a entity event relabel: streams=${String(relabel.streamsRewritten)} entries=${String(relabel.entriesReplayed)}`,
      );
      await quitRedisWithTimeout(redis, 5000);
    } else {
      console.log('[release] ⊘ Redis not configured — skipping 104a entity event relabel');
    }
  } catch (err) {
    console.warn('[release] WARNING — 104a entity event relabel failed:', errToStr(err));
  }

  await closeConnection();

  console.log('\n[release] Done.');
}

// eslint-disable-next-line @typescript-eslint/use-unknown-in-catch-callback-variable -- .mjs has no type annotations
main().catch((err) => {
  console.error('[release] Fatal:', err);
  process.exit(1);
});
