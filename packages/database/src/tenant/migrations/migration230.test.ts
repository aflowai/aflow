import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import { applyMigration230 } from './migration230.js';

async function sentSql(): Promise<string> {
  const sent: string[] = [];
  const client = {
    unsafe: (text: string) => {
      sent.push(text);
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  await applyMigration230(client, 't_00000000000000000000000000000230');
  return sent.join('\n');
}

describe('migration 230', () => {
  it('adds the time a person last opened a plan node', async () => {
    expect(await sentSql()).toMatch(
      /ALTER TABLE "[^"]+"\.plan_nodes\s+ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ/,
    );
  });

  it('records itself as version 230', async () => {
    expect(await sentSql()).toMatch(/VALUES \(230, /);
  });
});
