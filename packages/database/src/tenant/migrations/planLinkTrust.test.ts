import { expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { planNodeLinks } from '../../schema/tenant/planNodes.js';
import { readFileSync } from 'node:fs';

it('keeps link trust out of the schema and unmerged migration list', () => {
  expect(Object.keys(getTableColumns(planNodeLinks))).not.toContain('trustedForClose');
  const migrations = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  expect(migrations).not.toContain('applyMigration232');
});
