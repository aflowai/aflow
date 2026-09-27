/**
 * Apply tenant schema migrations in canonical order.
 *
 * Each migration's version is parsed from its function name (`applyMigration043`
 * → 43). Before running, we read the tenant's `schema_migrations` table and
 * skip any migration whose version is already recorded — this makes the
 * full migration set safely idempotent at the runner level and means
 * individual migration files don't need top-level skip-if-applied guards.
 *
 * Each migration is still expected to `INSERT INTO schema_migrations ...
 * ON CONFLICT DO NOTHING` at the end of its body to record itself; the
 * runner reads back the table once and uses that to gate subsequent calls.
 */
import type postgres from 'postgres';
import { isValidSchemaName } from '../context.js';
import { PRE_TAXONOMY_MIGRATIONS, POST_TAXONOMY_MIGRATIONS } from './index.js';
import type { TenantMigrationFn } from './types.js';

function migrationVersion(fn: TenantMigrationFn): number | null {
  // Function names follow `applyMigration043`. Strip the prefix and parse.
  const match = /applyMigration0*(\d+)/.exec(fn.name);
  if (!match) return null;
  const v = parseInt(match[1]!, 10);
  return Number.isFinite(v) ? v : null;
}

async function readAppliedVersions(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<Set<number>> {
  try {
    const rows = await sqlClient.unsafe(`SELECT version FROM "${schemaName}".schema_migrations`);
    const set = new Set<number>();
    for (const row of rows as unknown as Array<{ version: number }>) {
      set.add(row.version);
    }
    return set;
  } catch {
    // schema_migrations doesn't exist (fresh tenant) — empty set, run everything.
    return new Set<number>();
  }
}

export async function applyTenantMigrations(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  if (!isValidSchemaName(schemaName)) {
    throw new Error(`Invalid tenant schema name: ${schemaName}`);
  }

  const applied = await readAppliedVersions(sqlClient, schemaName);
  const migration34Applied = applied.has(34);

  const runIfNew = async (migration: TenantMigrationFn): Promise<void> => {
    const v = migrationVersion(migration);
    if (v !== null && applied.has(v)) {
      // Already recorded — skip. The migration's own INSERT-ON-CONFLICT
      // would be a no-op anyway, but skipping avoids re-running DDL that
      // may not be idempotent on its own.
      return;
    }
    await migration(sqlClient, schemaName);
    if (v !== null) applied.add(v);
  };

  if (!migration34Applied) {
    for (const migration of PRE_TAXONOMY_MIGRATIONS) {
      await runIfNew(migration);
    }
  }

  for (const migration of POST_TAXONOMY_MIGRATIONS) {
    await runIfNew(migration);
  }
}
