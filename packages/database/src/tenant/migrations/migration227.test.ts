import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import { applyMigration227 } from './migration227.js';

async function sentSql(): Promise<string> {
  const sent: string[] = [];
  const client = {
    unsafe: (text: string) => {
      sent.push(text);
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  await applyMigration227(client, 't_00000000000000000000000000000227');
  return sent.join('\n');
}

describe('migration 227', () => {
  it('adds a nullable renews_schedule_id to agent_schedules', async () => {
    expect(await sentSql()).toMatch(
      /ALTER TABLE "[^"]+"\.agent_schedules\s+ADD COLUMN IF NOT EXISTS renews_schedule_id UUID;/,
    );
  });

  it('lets a schedule have one successor', async () => {
    expect(await sentSql()).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS \w+\s+ON "[^"]+"\.agent_schedules \(renews_schedule_id\)\s+WHERE renews_schedule_id IS NOT NULL;/,
    );
  });

  it('records itself as version 227', async () => {
    expect(await sentSql()).toMatch(
      /INSERT INTO "[^"]+"\.schema_migrations \(version, description\)\s+VALUES \(227,/,
    );
  });
});
