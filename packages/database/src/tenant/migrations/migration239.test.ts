import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import { applyMigration239 } from './migration239.js';

async function sentSql(): Promise<string> {
  const sent: string[] = [];
  const client = {
    unsafe: (text: string) => {
      sent.push(text);
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  await applyMigration239(client, 't_00000000000000000000000000000239');
  return sent.join('\n');
}

describe('migration 239', () => {
  it('adds the autonomy policy column with no default, so a space that never chose reads ratify', async () => {
    expect(await sentSql()).toMatch(
      /ALTER TABLE "[^"]+"\.spaces\s+ADD COLUMN IF NOT EXISTS autonomy_policy jsonb;/,
    );
  });

  it('writes full for Full Circle and Trading Joe alone, where nothing is stored', async () => {
    expect(await sentSql()).toMatch(
      /UPDATE "[^"]+"\.spaces\s+SET autonomy_policy = '\{"autonomy":"full"\}'::jsonb\s+WHERE name IN \('Full Circle', 'Trading Joe'\) AND autonomy_policy IS NULL;/,
    );
  });

  it('records itself as version 239', async () => {
    expect(await sentSql()).toMatch(/VALUES \(239, /);
  });
});
