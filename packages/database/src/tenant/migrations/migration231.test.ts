import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import { applyMigration231 } from './migration231.js';

async function sentSql(): Promise<string> {
  const sent: string[] = [];
  const client = {
    unsafe: (text: string) => {
      sent.push(text);
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  await applyMigration231(client, 't_00000000000000000000000000000231');
  return sent.join('\n');
}

describe('migration 231', () => {
  it('adds a bounded operator-owned spend ceiling', async () => {
    expect(await sentSql()).toMatch(
      /ALTER TABLE "[^"]+"\.plan_nodes\s+ADD COLUMN IF NOT EXISTS spend_cents INTEGER CHECK/,
    );
  });

  it('records itself as version 231', async () => {
    expect(await sentSql()).toMatch(/VALUES \(231, /);
  });
});
