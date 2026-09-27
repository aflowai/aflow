/**
 * Every due pointer has one owner in the tree and one list behind it.
 *
 * Two ways to write an index is how the previous candidate index and its worker
 * drifted apart, and the drift was invisible until runs stopped reaching
 * Postgres. Here the same hazard is a second place that names a pointer table,
 * or a due source that enters the recompute without a trigger to arm it — the
 * task would then read a pointer nothing maintains.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TENANT_DUE_POINTERS, WORKFLOW_RUN_DUE_POINTER } from './duePointers.js';
import { tenantDueRecomputeSql, tenantDueTriggerDdl, tenantDueTriggerName } from './tenantDue.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const OWNER = 'packages/database/src/tenant/duePointers.ts';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', '__tests__']);
const SCHEMA = 't_00000000000000000000000000000001';

function productionSources(): Array<{ path: string; source: string }> {
  const out: Array<{ path: string; source: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(join(dir, entry.name));
      } else if (
        entry.isFile() &&
        /\.tsx?$/.test(entry.name) &&
        !/\.(test|spec)\./.test(entry.name)
      ) {
        const absolute = join(dir, entry.name);
        out.push({
          path: relative(REPO_ROOT, absolute).split(sep).join('/'),
          source: readFileSync(absolute, 'utf8'),
        });
      }
    }
  };
  for (const segment of ['apps', 'packages'] as const) walk(join(REPO_ROOT, segment));
  return out;
}

const IDENTIFIERS = TENANT_DUE_POINTERS.flatMap((pointer) => [
  pointer.table.split('.')[1]!,
  pointer.trigger,
]);

describe('tenant due pointers', () => {
  it.each(IDENTIFIERS)('names %s in exactly one module', (identifier) => {
    const offenders = productionSources()
      .filter(({ path, source }) => path !== OWNER && source.includes(identifier))
      .map(({ path }) => path);

    expect(
      offenders,
      `Reach the pointer through the declarations in ${OWNER} rather than naming it directly.`,
    ).toEqual([]);
  });

  it.each(TENANT_DUE_POINTERS.map((pointer) => [pointer.table, pointer] as const))(
    '%s arms on every column that can change a source’s due time',
    (_table, pointer) => {
      const uncovered = pointer.sources
        .filter((source) => !source.writtenBy.includes(source.dueColumn))
        .map((source) => source.table);

      expect(
        uncovered,
        'A source whose own due column is not in `writtenBy` is armed by every write except the one that sets its due time.',
      ).toEqual([]);
    },
  );

  it.each(TENANT_DUE_POINTERS.map((pointer) => [pointer.table, pointer] as const))(
    '%s drives both the triggers and the recompute from the same sources',
    (_table, pointer) => {
      // A source that enters one side only is the whole failure: armed but never
      // settled leaves a tenant claimed forever, settled but never armed leaves
      // its work undiscoverable.
      const triggers = tenantDueTriggerDdl(pointer, SCHEMA);
      const recompute = tenantDueRecomputeSql(pointer, SCHEMA);

      for (const source of pointer.sources) {
        expect(triggers).toContain(source.table);
        expect(triggers).toContain(`'${source.dueColumn}'`);
        expect(recompute).toContain(source.table);
        expect(recompute).toContain(`min(${source.dueColumn})`);
      }
    },
  );

  it.each(TENANT_DUE_POINTERS.map((pointer) => [pointer.table, pointer] as const))(
    '%s gives every source on one table its own trigger',
    (_table, pointer) => {
      // The trigger is named for the pointer, so two sources on the same table
      // would both emit `DROP TRIGGER … ; CREATE TRIGGER …` under one name and
      // the second would silently take the first one's place. Sharing the name
      // across different tables is the design; sharing it on one table is a bug.
      const perTable = new Map<string, string[]>();
      for (const source of pointer.sources) {
        const names = perTable.get(source.table) ?? [];
        names.push(tenantDueTriggerName(pointer, source));
        perTable.set(source.table, names);
      }
      for (const [table, names] of perTable) {
        expect(new Set(names).size, `${table} arms twice under one trigger name`).toBe(
          names.length,
        );
      }
    },
  );

  it.each(TENANT_DUE_POINTERS.map((pointer) => [pointer.table, pointer] as const))(
    '%s keeps its recompute-only conditions out of the trigger',
    (_table, pointer) => {
      // A trigger `WHEN` clause cannot contain a subquery, which is why such a
      // condition is recompute-only in the first place. Arming broader than the
      // settle costs a claim; a subquery here fails the source write outright.
      const triggers = tenantDueTriggerDdl(pointer, SCHEMA);
      const recompute = tenantDueRecomputeSql(pointer, SCHEMA);

      for (const source of pointer.sources) {
        if (!source.recomputeOnly) continue;
        const condition = source.recomputeOnly((table) => `"${SCHEMA}".${table}`);
        expect(recompute).toContain(condition);
        expect(triggers).not.toContain(condition);
      }
      expect(triggers).not.toMatch(/WHEN \([^)]*SELECT/i);
    },
  );

  it('renders one predicate for the trigger and the recompute', () => {
    const runs = WORKFLOW_RUN_DUE_POINTER.sources.find((s) => s.table === 'workflow_runs');
    expect(runs?.reconcilable((c) => `NEW.${c}`)).toContain("NEW.status = 'running'");
    expect(runs?.reconcilable((c) => c)).toContain("status = 'running'");
  });
});
