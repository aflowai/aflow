import { expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { planNodeLinks } from '../../schema/tenant/planNodes.js';
import { readdirSync, readFileSync } from 'node:fs';

it('keeps link trust out of the schema and every migration', () => {
  expect(Object.keys(getTableColumns(planNodeLinks))).not.toContain('trustedForClose');
  const dir = new URL('./', import.meta.url);
  const adding = readdirSync(dir)
    .filter((file) => /^migration\d{3}\.ts$/.test(file))
    .filter((file) => readFileSync(new URL(file, dir), 'utf8').includes('trusted_for_close'));
  expect(adding).toEqual([]);
});
