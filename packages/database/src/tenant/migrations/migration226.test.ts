/**
 * Read from the SQL the migration actually sends, so the assertion is about
 * what reaches a tenant rather than a restatement of it.
 */
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import { applyMigration226 } from './migration226.js';

async function sentSql(): Promise<string> {
  const sent: string[] = [];
  const client = {
    unsafe: (text: string) => {
      sent.push(text);
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  await applyMigration226(client, 't_00000000000000000000000000000226');
  return sent.join('\n');
}

describe('migration 226', () => {
  it('adds a nullable plan_node_id to coach_learnings, indexed where it is set', async () => {
    const sql = await sentSql();
    expect(sql).toMatch(
      /ALTER TABLE "[^"]+"\.coach_learnings\s+ADD COLUMN IF NOT EXISTS plan_node_id UUID;/,
    );
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS \w+\s+ON "[^"]+"\.coach_learnings \(space_id, plan_node_id\)\s+WHERE plan_node_id IS NOT NULL;/,
    );
  });

  it('creates plan_node_dependencies keyed by the pair, deleted with either node', async () => {
    const sql = await sentSql();
    const table =
      /CREATE TABLE IF NOT EXISTS "[^"]+"\.plan_node_dependencies \(([\s\S]*?)\n\s*\);/.exec(
        sql,
      )?.[1];
    expect(table).toBeDefined();
    const columns = (table ?? '')
      .split('\n')
      .map((line) => /^\s*([a-z_]+)\s/.exec(line)?.[1])
      .filter((c): c is string => c !== undefined && c !== 'PRIMARY');
    expect(columns).toEqual(['node_id', 'depends_on_id', 'space_id', 'condition', 'created_at']);
    expect(table).toMatch(
      /node_id\s+UUID NOT NULL REFERENCES "[^"]+"\.plan_nodes \(id\) ON DELETE CASCADE/,
    );
    expect(table).toMatch(
      /depends_on_id\s+UUID NOT NULL REFERENCES "[^"]+"\.plan_nodes \(id\) ON DELETE CASCADE/,
    );
    expect(table).toContain('PRIMARY KEY (node_id, depends_on_id)');
  });

  it('indexes plan_node_dependencies leading with space_id, which the space cascade deletes by', async () => {
    const indexes = [
      ...(await sentSql()).matchAll(
        /CREATE INDEX IF NOT EXISTS \w+\s+ON "[^"]+"\.plan_node_dependencies \(([^)]+)\)/g,
      ),
    ].map((m) => m[1]);
    expect(indexes).toEqual(['space_id, depends_on_id']);
  });

  it('records itself as applied', async () => {
    expect(await sentSql()).toMatch(
      /INSERT INTO "[^"]+"\.schema_migrations \(version, description\)\s+VALUES \(226,/,
    );
  });
});
