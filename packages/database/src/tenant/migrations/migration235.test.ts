import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import { applyMigration235 } from './migration235.js';

async function sentSql(): Promise<string> {
  const sent: string[] = [];
  const client = {
    unsafe: (text: string) => {
      sent.push(text);
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  await applyMigration235(client, 't_00000000000000000000000000000235');
  return sent.join('\n');
}

describe('migration 235', () => {
  it('adds a nullable original_schedule_id to agent_schedules', async () => {
    expect(await sentSql()).toMatch(
      /ALTER TABLE "[^"]+"\.agent_schedules\s+ADD COLUMN IF NOT EXISTS original_schedule_id UUID;/,
    );
  });

  it('fills it on the renewals of every chain and leaves the first schedule NULL', async () => {
    const sent = (await sentSql()).replace(/\s+/g, ' ');
    expect(sent).toContain('WITH RECURSIVE walk AS');
    expect(sent).toContain('SET original_schedule_id = walk.original_id');
    expect(sent).toContain('AND target.id <> walk.original_id');
  });

  it("indexes each chain's renewals newest first", async () => {
    expect(await sentSql()).toMatch(
      /CREATE INDEX IF NOT EXISTS \w+\s+ON "[^"]+"\.agent_schedules \(original_schedule_id, created_at DESC\)\s+WHERE original_schedule_id IS NOT NULL;/,
    );
  });

  it('records itself as version 235', async () => {
    expect(await sentSql()).toMatch(/VALUES \(235, /);
  });
});
