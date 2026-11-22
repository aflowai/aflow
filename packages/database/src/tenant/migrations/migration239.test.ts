import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import type { TenantId } from '@aflow/schemas';

import { tenantIdToSchemaName } from '../context.js';
import { applyMigration239 } from './migration239.js';

const OPERATOR_SCHEMA = tenantIdToSchemaName('00000000-0000-4000-8000-0000000ed1c0' as TenantId);
const OTHER_SCHEMA = 't_00000000000000000000000000000239';

async function sentSql(schema: string): Promise<string> {
  const sent: string[] = [];
  const client = {
    unsafe: (text: string) => {
      sent.push(text);
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  await applyMigration239(client, schema);
  return sent.join('\n');
}

describe('migration 239', () => {
  it.each([OPERATOR_SCHEMA, OTHER_SCHEMA])(
    'adds the autonomy policy column with no default in %s, so a space that never chose reads ratify',
    async (schema) => {
      expect(await sentSql(schema)).toMatch(
        /ALTER TABLE "[^"]+"\.spaces\s+ADD COLUMN IF NOT EXISTS autonomy_policy jsonb;/,
      );
    },
  );

  it("writes full for the operator's Full Circle and Trading Joe alone, where nothing is stored", async () => {
    expect(await sentSql(OPERATOR_SCHEMA)).toMatch(
      new RegExp(
        `UPDATE "${OPERATOR_SCHEMA}"\\.spaces\\s+SET autonomy_policy = '\\{"autonomy":"full"\\}'::jsonb\\s+WHERE name IN \\('Full Circle', 'Trading Joe'\\) AND autonomy_policy IS NULL;`,
      ),
    );
  });

  it('writes no autonomy in another tenant, whatever its spaces are named', async () => {
    const sql = await sentSql(OTHER_SCHEMA);
    expect(sql).not.toMatch(/UPDATE/);
    expect(sql).not.toMatch(/"full"/);
  });

  it.each([OPERATOR_SCHEMA, OTHER_SCHEMA])(
    'records itself as version 239 in %s',
    async (schema) => {
      expect(await sentSql(schema)).toMatch(/VALUES \(239, /);
    },
  );
});
