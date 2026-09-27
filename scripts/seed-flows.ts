/**
 * Seed script: seeds capability flows directly into the database (local dev).
 *
 * Uses `seedCapabilityFlows()` to insert rows with `created_by = 'system'` and
 * `metadata.system: true`. **Production `release.mjs` does not run this** (Plan
 * 106); platform agent definitions are served from `packages/platform-artifacts`
 * at runtime. Use this script when you need DB rows in a dev database for
 * flows that still have a local seed path, or to align with pre-registry data.
 *
 * Usage:
 *   yarn db:seed                          # local dev (default DATABASE_URL)
 *   DATABASE_URL=... yarn db:seed         # against a specific database
 */

import { seedCapabilityFlows, getConnection, closeConnection } from '@aflow/database';

async function seed() {
  console.log('Seeding capability flows directly into the database...\n');

  const sql = getConnection();
  try {
    const results = await seedCapabilityFlows(sql);

    if (results.success.length > 0) {
      console.log(`  ✓ Seeded ${results.success.length} tenant(s): ${results.success.join(', ')}`);
    }
    if (results.skipped.length > 0) {
      console.log(`  ⊘ Skipped ${results.skipped.length} tenant(s): ${results.skipped.join(', ')}`);
    }
    if (results.failed.length > 0) {
      for (const f of results.failed) {
        console.error(`  ✗ ${f.schema}:`, f.error);
      }
    }

    console.log('\nDone.');
  } finally {
    await closeConnection();
  }
}

seed().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
