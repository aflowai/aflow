import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import { applyMigration228 } from './migration228.js';

async function sentSql(): Promise<string> {
  const sent: string[] = [];
  const client = {
    unsafe: (text: string) => {
      sent.push(text);
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  await applyMigration228(client, 't_00000000000000000000000000000228');
  return sent.join('\n');
}

describe('migration 228', () => {
  it('grants ai.model read and write to the authoring system profiles', async () => {
    const sql = await sentSql();
    expect(sql).toMatch(/"capabilityGroupId":"ai\.model","accessMode":"read"/);
    expect(sql).toMatch(/"capabilityGroupId":"ai\.model","accessMode":"write"/);
    expect(sql).toMatch(/name IN \('Full Access', 'Standard', 'Personal Safe'\)/);
  });

  it('grants Read Only the read half only', async () => {
    expect(await sentSql()).toMatch(
      /\|\| '\[\{"capabilityGroupId":"ai\.model","accessMode":"read"\}\]'::jsonb\s+WHERE is_system_profile = true\s+AND name = 'Read Only'/,
    );
  });

  it('records itself as version 228', async () => {
    expect(await sentSql()).toMatch(
      /INSERT INTO "[^"]+"\.schema_migrations \(version, description\)\s+VALUES \(228,/,
    );
  });
});
