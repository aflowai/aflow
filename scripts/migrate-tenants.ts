/**
 * Apply tenant schema migrations to all existing tenants.
 * Run with: npx tsx scripts/migrate-tenants.ts
 *
 * Requires DATABASE_URL environment variable (or .env file via dotenv).
 */
import 'dotenv/config';
import { getConnection, closeConnection, applyMigrationsToAllTenants } from '@aflow/database';

async function main() {
  console.log('Applying tenant schema migrations...\n');

  const sql = getConnection();
  const results = await applyMigrationsToAllTenants(sql);

  for (const schema of results.success) {
    console.log(`  ✓ ${schema}`);
  }
  for (const { schema, error } of results.failed) {
    console.error(
      `  ✗ ${schema}: ${error instanceof Error ? error.message : typeof error === 'object' ? JSON.stringify(error) : String(error as string | number | boolean | null | undefined)}`,
    );
  }

  console.log(
    `\nDone: ${String(results.success.length)} succeeded, ${String(results.failed.length)} failed.`,
  );

  await closeConnection();
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
