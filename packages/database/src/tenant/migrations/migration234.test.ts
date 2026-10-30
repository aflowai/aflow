import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import { applyMigration234 } from './migration234.js';

async function sentSql(): Promise<string> {
  const sent: string[] = [];
  const client = {
    unsafe: (text: string) => {
      sent.push(text);
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  await applyMigration234(client, 't_00000000000000000000000000000234');
  return sent.join('\n');
}

describe('migration 234', () => {
  it('adds the nullable card column', async () => {
    expect(await sentSql()).toMatch(
      /ALTER TABLE "[^"]+"\.plan_nodes\s+ADD COLUMN IF NOT EXISTS card JSONB;/,
    );
  });

  it('records itself as version 234', async () => {
    expect(await sentSql()).toMatch(/VALUES \(234, /);
  });
});
