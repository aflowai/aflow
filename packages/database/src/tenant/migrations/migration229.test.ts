import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import { applyMigration229 } from './migration229.js';

async function sentSql(): Promise<string> {
  const sent: string[] = [];
  const client = {
    unsafe: (text: string) => {
      sent.push(text);
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  await applyMigration229(client, 't_00000000000000000000000000000229');
  return sent.join('\n');
}

describe('migration 229', () => {
  it('adds the usage column to the skill discovery projection', async () => {
    expect(await sentSql()).toMatch(
      /ALTER TABLE "[^"]+"\.skill_discovery\s+ADD COLUMN IF NOT EXISTS usage JSONB NOT NULL DEFAULT '\{\}'::jsonb/,
    );
  });

  it('projects an object usage block from the workflow document and nothing else', async () => {
    const sql = await sentSql();
    expect(sql).toMatch(
      /CASE WHEN jsonb_typeof\(doc->'usage'\) = 'object' THEN doc->'usage' ELSE '\{\}'::jsonb END/,
    );
    expect(sql).toMatch(/usage = EXCLUDED\.usage/);
  });

  it('rebuilds the projection from every stored workflow', async () => {
    expect(await sentSql()).toMatch(
      /SELECT "[^"]+"\.sync_skill_discovery\(space_id, path, inline_content, deleted_at\)\s+FROM "[^"]+"\.memory_docs/,
    );
  });

  it('records itself as version 229', async () => {
    expect(await sentSql()).toMatch(
      /INSERT INTO "[^"]+"\.schema_migrations \(version, description\)\s+VALUES \(229,/,
    );
  });
});
