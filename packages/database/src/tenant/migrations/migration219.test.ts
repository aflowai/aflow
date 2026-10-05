/**
 * Read from the SQL the migration actually sends, so the assertion is about
 * what reaches a tenant rather than a restatement of it.
 */
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import { applyMigration219 } from './migration219.js';

async function sentSql(): Promise<string> {
  const sent: string[] = [];
  const client = {
    unsafe: (text: string) => {
      sent.push(text);
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  await applyMigration219(client, 't_00000000000000000000000000000219');
  return sent.join('\n');
}

describe('migration 219', () => {
  it('adds a nullable plan_node_id to workflow_runs, indexed where it is set', async () => {
    const sql = await sentSql();
    expect(sql).toMatch(
      /ALTER TABLE "[^"]+"\.workflow_runs\s+ADD COLUMN IF NOT EXISTS plan_node_id UUID;/,
    );
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS \w+\s+ON "[^"]+"\.workflow_runs \(plan_node_id\)\s+WHERE plan_node_id IS NOT NULL;/,
    );
  });

  it('creates plan_node_links keyed by node, kind and ref, deleted with its node', async () => {
    const sql = await sentSql();
    const table = /CREATE TABLE IF NOT EXISTS "[^"]+"\.plan_node_links \(([\s\S]*?)\n\s*\);/.exec(
      sql,
    )?.[1];
    expect(table).toBeDefined();
    const columns = (table ?? '')
      .split('\n')
      .map((line) => /^\s*([a-z_]+)\s/.exec(line)?.[1])
      .filter((c): c is string => c !== undefined && c !== 'PRIMARY');
    expect(columns).toEqual(['node_id', 'space_id', 'kind', 'ref', 'label', 'created_at']);
    expect(table).toMatch(
      /node_id\s+UUID NOT NULL REFERENCES "[^"]+"\.plan_nodes \(id\) ON DELETE CASCADE/,
    );
    expect(table).toContain('PRIMARY KEY (node_id, kind, ref)');
  });

  it('indexes plan_node_links leading with space_id, which the space cascade deletes by', async () => {
    const indexes = [
      ...(await sentSql()).matchAll(
        /CREATE INDEX IF NOT EXISTS \w+\s+ON "[^"]+"\.plan_node_links \(([^)]+)\)/g,
      ),
    ].map((m) => m[1]);
    expect(indexes).toEqual(['space_id, node_id']);
  });

  it('records itself as applied', async () => {
    expect(await sentSql()).toMatch(
      /INSERT INTO "[^"]+"\.schema_migrations \(version, description\)\s+VALUES \(219,/,
    );
  });
});
