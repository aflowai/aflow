import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import { applyMigration006 } from './migration006.js';
import { applyMigration148 } from './migration148.js';

/**
 * A migration's own `sqlClient.unsafe` call sequence is the thing under test
 * here — whether it records itself as applied, and whether a real error
 * survives — not real Postgres DDL, so a stub client is more precise than a
 * live one: it can force "extension genuinely absent" and "CREATE EXTENSION
 * failed for some other reason" independently, neither of which is safely
 * reproducible against the shared local dev database (dropping pgvector
 * there would break every other real-DB test in this package).
 */
function fakeSql(responses: Array<unknown[] | Error>): postgres.Sql & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const unsafe = async (query: string): Promise<unknown[]> => {
    calls.push(query);
    const next = responses[i];
    i += 1;
    if (next instanceof Error) throw next;
    return next ?? [];
  };
  return { unsafe, calls } as unknown as postgres.Sql & { calls: string[] };
}

describe('migration148 — does not record itself applied when pgvector is absent', () => {
  it('makes exactly one probe call and never inserts into schema_migrations', async () => {
    const sql = fakeSql([[]]); // pg_extension probe → no rows → absent
    await applyMigration148(sql, 't_fake');

    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0]).toMatch(/pg_extension/);
    expect(sql.calls.some((c) => /INSERT INTO/i.test(c))).toBe(false);
  });
});

describe('migration006 — pgvector availability probe replaces the swallow-all try/catch', () => {
  it('skips without recording when pg_available_extensions reports vector unavailable', async () => {
    const sql = fakeSql([
      [], // memory_embed_config block
      [], // pg_available_extensions probe → not available
    ]);
    await expect(applyMigration006(sql, 't_fake')).resolves.toBeUndefined();

    expect(sql.calls).toHaveLength(2);
    expect(sql.calls[1]).toMatch(/pg_available_extensions/);
    expect(sql.calls.some((c) => /CREATE EXTENSION/i.test(c))).toBe(false);
  });

  it('propagates a genuine CREATE EXTENSION failure instead of swallowing it', async () => {
    const permissionError = new Error('permission denied to create extension "vector"');
    const sql = fakeSql([
      [], // memory_embed_config block
      [{ available: true }], // pg_available_extensions → vector IS available
      permissionError, // CREATE EXTENSION itself fails for a real reason
    ]);

    await expect(applyMigration006(sql, 't_fake')).rejects.toThrow(permissionError);
  });
});
