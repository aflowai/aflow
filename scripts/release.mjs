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

let stepsApplied = 0;

/**
 * Runs one migration step, naming it only if it fails.
 *
 * Every step is idempotent and nearly every run finds nothing to do, so a line
 * per step reported the same thirty successes on every start and hid the one
 * that mattered. The failure carries the step's name; success is a count.
 *
 * @param {string} name
 * @param {() => Promise<unknown>} run
 */
async function step(name, run) {
  try {
    await run();
    stepsApplied += 1;
  } catch (err) {
    console.error(`[release] ✗ ${name}`);
    throw err;
  }
}

async function main() {
  console.log('[release] Applying database migrations...');

  // One connection: applying tenant migrations issues its own transactions,
  // which a pooled client refuses with UNSAFE_TRANSACTION.
  const sql = getConnection({ ...getDatabaseConfig(), maxConnections: 1 });

  await step('public schema', () => applyPublicMigrations(sql));
  await step('identity', () => applyIdentityMigrations(sql));
  await step('recovery', () => applyRecoveryMigrations(sql));
  await step('onboarding', () => applyOnboardingMigrations(sql));
  await step('invite hardening', () => applyInviteHardeningMigrations(sql));
  await step('OAuth ownership policy', () => applyOAuthOwnershipMigrations(sql));
  await step('error reports', () => applyErrorReportsMigration(sql));
  await step('store governance', () => applyStoreGovernanceMigrations(sql));
  await step('capability governance', () => applyCapabilityGovernanceMigrations(sql));
  await step('invite requests', () => applyInviteRequestMigrations(sql));
  await step('space grants', () => applySpaceGrantMigrations(sql));
  await step('workflow run due pointers', () => applyWorkflowRunDueMigrations(sql));
  await step('tenant due pointers', () => applyTenantDuePointerMigrations(sql));
  await step('schedule dispatch outbox', () => applyScheduleDispatchOutboxMigration(sql));
  await step('projection failures', () => applyProjectionFailuresMigration(sql));
  await step('timer dead letters', () => applyTimerDeadLettersMigration(sql));
  await step('identity provider key', () => applyIdentityProviderKeyMigration(sql));
  await step('concierge config removal', () => applyConciergeConfigRemovalMigration(sql));
  await step('agent-model allowlist', () => applyAgentModelAllowlistMigration(sql));

  // 6b. Freemium spend bounds on the public tenant (generous but bounded).
  const publicTenantId = process.env['DEFAULT_TENANT_ID'];
  if (publicTenantId) {
    await seedPublicTenantFreemiumDefaults(sql, publicTenantId);
  }

  await step('model catalog', () => seedModelCatalog(sql));
  console.log(`[release] ✓ public schema: ${String(stepsApplied)} steps`);

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
  const results = await applyMigrationsToAllTenants(sql);

  for (const { schema, error } of results.failed) {
    console.error(
      `[release]   ✗ ${schema}: ${error instanceof Error ? error.message : errToStr(error)}`,
    );
  }

  if (results.failed.length === 0) {
    console.log(`[release] ✓ tenant schemas: ${String(results.success.length)}`);
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
      if (relabel.streamsRewritten > 0) {
        console.log(
          `[release] 104a entity event relabel: streams=${String(relabel.streamsRewritten)} entries=${String(relabel.entriesReplayed)}`,
        );
      }
      await quitRedisWithTimeout(redis, 5000);
    } else {
      console.log('[release] ⊘ Redis not configured — skipping 104a entity event relabel');
    }
  } catch (err) {
    console.warn('[release] WARNING — 104a entity event relabel failed:', errToStr(err));
  }

  await closeConnection();

  console.log('[release] Done.');
}

// eslint-disable-next-line @typescript-eslint/use-unknown-in-catch-callback-variable -- .mjs has no type annotations
main().catch((err) => {
  console.error('[release] Fatal:', err);
  process.exit(1);
});
