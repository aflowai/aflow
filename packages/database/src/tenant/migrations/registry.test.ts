import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRE_TAXONOMY_MIGRATIONS, POST_TAXONOMY_MIGRATIONS, applyMigration115 } from './index.js';

const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));

const BURNED_VERSIONS = new Set(['041', '109', '110', '113', '114']);

/** Plan 314 §3.5 — the private distribution's band; the core keeps 001–899. */
const CLOUD_BAND_START = 900;

describe('tenant migration registry', () => {
  it('registers every migrationNNN.ts file present in the directory', () => {
    const fileVersions = readdirSync(MIGRATIONS_DIR)
      .map((f) => /^migration(\d{3})\.ts$/.exec(f)?.[1])
      .filter((v): v is string => v !== undefined && !BURNED_VERSIONS.has(v));

    const registeredNames = new Set(
      [...PRE_TAXONOMY_MIGRATIONS, ...POST_TAXONOMY_MIGRATIONS].map((fn) => fn.name),
    );

    const unregistered = fileVersions.filter((v) => !registeredNames.has(`applyMigration${v}`));
    expect(unregistered).toEqual([]);
  });

  // After the repository split neither half can see the other's numbers, and a
  // collision applies one migration and silently skips the other.
  it('numbers every migration inside the core band', () => {
    const outside = readdirSync(MIGRATIONS_DIR)
      .map((f) => /^migration(\d{3})\.ts$/.exec(f)?.[1])
      .filter((v): v is string => v !== undefined)
      .filter((v) => Number(v) >= CLOUD_BAND_START);
    expect(outside).toEqual([]);
  });

  it('registers no migration twice', () => {
    const names = [...PRE_TAXONOMY_MIGRATIONS, ...POST_TAXONOMY_MIGRATIONS].map((fn) => fn.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('includes migration 115 (Plan 195 — campaigns.config + contract_hash) after 112', () => {
    const names = POST_TAXONOMY_MIGRATIONS.map((fn) => fn.name);
    const idx112 = names.indexOf('applyMigration112');
    const idx115 = names.indexOf('applyMigration115');
    expect(POST_TAXONOMY_MIGRATIONS).toContain(applyMigration115);
    expect(idx112).toBeGreaterThanOrEqual(0);
    expect(idx115).toBe(idx112 + 1);
  });

  it('every migration records ITS OWN version number in schema_migrations', () => {
    // apply.ts derives the skip-version from the FUNCTION NAME but trusts the
    // migration body to record itself — a mismatched INSERT value makes the
    // migration re-run on every db:migrate forever AND poisons the recorded
    // number for an unrelated future migration. Founding incident: the Plan
    // 195 migrations were renumbered 112-114 → 115-117 (filenames + function
    // names) but their INSERT literals still said 112/113/114.
    // migration040 absorbed the withdrawn 041 (mcp_server_bindings) into one
    // file and records BOTH numbers so pre-withdrawal DBs stay convergent.
    const EXTRA_RECORDED_VERSIONS: Record<number, readonly number[]> = { 40: [41] };

    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^migration\d{3}\.ts$/.test(f));
    const mismatches: string[] = [];
    for (const file of files) {
      const fileVersion = Number(/^migration(\d{3})\.ts$/.exec(file)![1]);
      const allowed = new Set([fileVersion, ...(EXTRA_RECORDED_VERSIONS[fileVersion] ?? [])]);
      const source = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
      // Only check files using the standard self-recording INSERT pattern;
      // a migration with no insert (or a bespoke pattern) is out of scope.
      for (const match of source.matchAll(
        /INSERT INTO[\s\S]{0,200}?schema_migrations[\s\S]{0,200}?VALUES\s*\(\s*(\d+)/g,
      )) {
        const recorded = Number(match[1]);
        if (!allowed.has(recorded)) {
          mismatches.push(`${file} records version ${String(recorded)}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('every migration records SOMETHING — a file with no INSERT re-runs forever', () => {
    // The check above only verifies the NUMBER of a recording migration, so a
    // file with no INSERT at all passed it silently. The runner gates purely
    // on the schema_migrations row, so such a migration re-executes on every
    // startup of every tenant — and one carrying a repair scan re-scans every
    // row each time. Migrations 206 and 207 shipped that way and the guard
    // said nothing, because "no insert" was out of its scope.
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^migration\d{3}\.ts$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    const silent = files.filter(
      (file) =>
        !/INSERT INTO[\s\S]{0,200}?schema_migrations/.test(
          readFileSync(join(MIGRATIONS_DIR, file), 'utf-8'),
        ),
    );
    expect(silent).toEqual([]);
  });

  it('migration129 capability-group literal matches buildGroupId(memory, run_output) (Plan 233)', () => {
    // The floor op memory.run_output.get derives capability group
    // buildGroupId('memory','run_output') === 'memory.run_output'. A typo in
    // the migration's jsonb literal would silently deny every floored reread
    // ("not covered by any allowed capability") with no failing test.
    const source = readFileSync(join(MIGRATIONS_DIR, 'migration129.ts'), 'utf-8');
    expect(source).toContain('"capabilityGroupId":"memory.run_output"');
  });
});
