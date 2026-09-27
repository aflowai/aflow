import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import postgres from 'postgres';
import { applyMigration148 } from './migration148.js';

const DATABASE_URL = process.env['DATABASE_URL'];

// Sentinel scratch schema per the sandbox convention (bb5a0000 prefix),
// padded to the `t_[0-9a-f]{32}` shape `isValidSchemaName` expects. Created
// and dropped entirely within this test — never touches a real tenant.
const SCHEMA_NAME = 't_bb5a0000000000000000000000000000';

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('migration148 — repairs migration004/006 pgvector collateral damage (real DB)', () => {
  const sql = postgres(DATABASE_URL ?? '');
  let pgvectorAvailable = false;

  async function resetScratchSchema(): Promise<void> {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA_NAME}" CASCADE`);
    await sql.unsafe(`CREATE SCHEMA "${SCHEMA_NAME}"`);
    // Minimal prerequisite shape migration148 depends on — memory_entries for
    // the FK, memory_chunks for the ALTER TABLE ADD COLUMN, schema_migrations
    // for self-recording.
    await sql.unsafe(`
      CREATE TABLE "${SCHEMA_NAME}".memory_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid()
      );
      CREATE TABLE "${SCHEMA_NAME}".memory_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid()
      );
      CREATE TABLE "${SCHEMA_NAME}".schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        description TEXT
      );
    `);
  }

  async function tableExists(table: string): Promise<boolean> {
    const rows = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${SCHEMA_NAME} AND table_name = ${table}
      ) AS ok`;
    return rows[0]?.ok === true;
  }

  async function indexExists(index: string): Promise<boolean> {
    const rows = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = ${SCHEMA_NAME} AND indexname = ${index}
      ) AS ok`;
    return rows[0]?.ok === true;
  }

  beforeAll(async () => {
    const extension = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS ok`;
    pgvectorAvailable = extension[0]?.ok === true;
    await resetScratchSchema();
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA_NAME}" CASCADE`);
    await sql.end();
  });

  it('creates memory_entry_embeddings + memory_chunks vector columns from a genuinely-missing state', async (ctx: TestContext) => {
    if (!pgvectorAvailable) {
      ctx.skip('pgvector not installed in this Postgres — repair path not exercised');
      return;
    }

    await applyMigration148(sql, SCHEMA_NAME);

    expect(await tableExists('memory_entry_embeddings')).toBe(true);
    expect(await indexExists('idx_memory_entry_embeddings_model')).toBe(true);
    // Never attempted — architecturally impossible on a dimension-less column.
    expect(await indexExists('idx_memory_entry_embeddings_vector')).toBe(false);

    expect(await indexExists('idx_memory_chunks_vec_1536')).toBe(true);
    // Never attempted — exceeds pgvector's 2000-dim hnsw cap.
    expect(await indexExists('idx_memory_chunks_vec_3072')).toBe(false);

    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${SCHEMA_NAME} AND table_name = 'memory_chunks'`;
    const columnNames = columns.map((c) => c.column_name);
    expect(columnNames).toContain('embedding_1536');
    expect(columnNames).toContain('embedding_3072');

    const recorded = await sql<{ version: number }[]>`
      SELECT version FROM ${sql(SCHEMA_NAME)}.schema_migrations WHERE version = 148`;
    expect(recorded).toHaveLength(1);
  });

  it('is a no-op on the table but still adds a missing index when partially repaired (real-world observed shape)', async (ctx: TestContext) => {
    if (!pgvectorAvailable) {
      ctx.skip('pgvector not installed in this Postgres — repair path not exercised');
      return;
    }

    // Reproduce the live shape found on already-broken tenants: table exists
    // (from a manual CREATE TABLE) but its index doesn't.
    await resetScratchSchema();
    await sql.unsafe(`
      CREATE TABLE "${SCHEMA_NAME}".memory_entry_embeddings (
        entry_id UUID NOT NULL REFERENCES "${SCHEMA_NAME}".memory_entries(id) ON DELETE CASCADE,
        embedding_model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        embedding vector NOT NULL,
        content_hash TEXT NOT NULL,
        embedded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (entry_id, embedding_model)
      );
    `);
    expect(await indexExists('idx_memory_entry_embeddings_model')).toBe(false);

    await applyMigration148(sql, SCHEMA_NAME);

    expect(await tableExists('memory_entry_embeddings')).toBe(true);
    expect(await indexExists('idx_memory_entry_embeddings_model')).toBe(true);

    // Running it again on the now-fully-healed schema is a pure no-op.
    await expect(applyMigration148(sql, SCHEMA_NAME)).resolves.toBeUndefined();
  });
});
