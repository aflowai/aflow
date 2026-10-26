import { spaces } from '../schema/tenant.js';
import { withTenantSchema } from '../tenant/queries.js';
import { createTenantContext } from '../tenant/context.js';
import { spaceDirectivesUpdateGuard } from './spaceDirectives.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantId } from '@aflow/schemas';
import { createDatabase } from '../connection.js';
import { tenantIdToSchemaName } from '../tenant/context.js';
import { applyMigration221 } from '../tenant/migrations/migration221.js';
import { applyMigration222 } from '../tenant/migrations/migration222.js';
import { applyMigration229 } from '../tenant/migrations/migration229.js';
import { listSkillCatalog } from '@aflow/platform-artifacts';
import { querySkillDiscovery } from './skillDiscovery.js';

const connectionString = process.env['DATABASE_URL'];
const tenantId = randomUUID() as TenantId;
const schema = tenantIdToSchemaName(tenantId);
const spaceId = randomUUID();
const otherSpace = randomUUID();
const storeSpace = randomUUID();

describe.skipIf(!connectionString)('skill discovery metadata (isolated Postgres schema)', () => {
  const handle = createDatabase({ connectionString: connectionString ?? '' });
  const client = handle.sql;
  beforeAll(async () => {
    await client.unsafe(`CREATE SCHEMA "${schema}";
      CREATE TABLE "${schema}".spaces (id UUID PRIMARY KEY, directives JSONB);
      CREATE TABLE "${schema}".memory_docs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), space_id UUID, path TEXT,
        inline_content TEXT, deleted_at TIMESTAMPTZ,
        embedding_status TEXT NOT NULL DEFAULT 'disabled', updated_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE "${schema}".memory_chunks (doc_id UUID, embedding_model TEXT);
      CREATE TABLE "${schema}".memory_embed_config (scope_type TEXT, scope_value TEXT, embedding_model TEXT);
      CREATE TABLE "${schema}".schema_migrations (version INTEGER PRIMARY KEY, description TEXT);
      CREATE TABLE "${schema}".capability_profiles (is_system_profile BOOLEAN, allowed_capabilities JSONB);`);
    await client.unsafe(
      `INSERT INTO "${schema}".spaces VALUES ($1, $2::jsonb), ($3, '{}'::jsonb)`,
      [
        spaceId,
        JSON.stringify({
          capabilityDiscovery: {
            bundlePlacements: {
              author_skills: 'off',
              run_skills: 'on_demand',
              integrations: 'always_on',
            },
          },
        }),
        otherSpace,
      ],
    );
    await applyMigration221(client, schema);
    await applyMigration222(client, schema);
    // A skill stored before the usage column existed is projected with it.
    await client.unsafe(`INSERT INTO "${schema}".spaces VALUES ($1, '{}'::jsonb)`, [storeSpace]);
    await client.unsafe(
      `INSERT INTO "${schema}".memory_docs (space_id, path, inline_content, deleted_at)
      VALUES ($1, '/workflows/early-skill/workflow.json', $2, NULL)`,
      [
        storeSpace,
        JSON.stringify({
          name: 'Early skill',
          description: 'Stored before usage was projected',
          usage: { whenToUse: ['Reconciling a ledger'] },
          status: 'approved',
          mode: 'process',
          revision: 1,
        }),
      ],
    );
    await applyMigration229(client, schema);
    await client.unsafe(
      `INSERT INTO "${schema}".memory_docs (space_id, path, inline_content, deleted_at)
      SELECT $1::uuid, '/workflows/skill-' || lpad(i::text, 4, '0') || '/workflow.json',
        jsonb_build_object('slug', 'skill-' || lpad(i::text,4,'0'), 'name', 'Skill ' || i, 'description', 'Review pull requests', 'mode', 'process', 'status', 'approved', 'revision', 1)::text, NULL
      FROM generate_series(1,1005) AS i`,
      [spaceId],
    );
    await client.unsafe(
      `INSERT INTO "${schema}".memory_docs (space_id, path, inline_content, deleted_at) VALUES ($1, '/workflows/private-skill/workflow.json', '{"name":"Private skill","status":"approved","mode":"process"}', NULL)`,
      [otherSpace],
    );
  }, 20000);
  afterAll(async () => {
    try {
      await client.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await client.end();
    }
  });
  it('projects a skill’s usage, including one stored before the column existed', async () => {
    const found = await querySkillDiscovery(handle.db, tenantId, storeSpace, {
      query: 'reconciling ledger',
    });
    expect(found.skills[0]).toMatchObject({
      slug: 'early-skill',
      usage: { whenToUse: ['Reconciling a ledger'] },
    });
  });
  it('ranks the installed store skills by their whenToUse: a bug fix finds Commission Change first', async () => {
    for (const entry of listSkillCatalog()) {
      const doc = {
        ...entry.bundle.workflow,
        ...(entry.bundle.activation ? { activation: entry.bundle.activation } : {}),
        status: 'approved',
        revision: entry.version,
      };
      await client.unsafe(
        `INSERT INTO "${schema}".memory_docs (space_id, path, inline_content, deleted_at) VALUES ($1, $2, $3, NULL)`,
        [storeSpace, `/workflows/${entry.bundle.workflow.slug}/workflow.json`, JSON.stringify(doc)],
      );
    }
    const found = await querySkillDiscovery(handle.db, tenantId, storeSpace, {
      query: 'fix a bug in the repo',
      limit: 5,
    });
    expect(found.skills[0]?.slug).toBe('commission-change');
    expect(found.skills[0]?.usage.whenToUse.length).toBeGreaterThan(0);
    expect(found.skills[0]?.usage.next[0]?.skill).toBe('publish-local-changes');
  });
  it('applies both the embedding and skill-discovery migrations in order', async () => {
    const versions = await client.unsafe(
      `SELECT version FROM "${schema}".schema_migrations ORDER BY version`,
    );
    expect(versions.map((row) => row['version'])).toEqual([221, 222, 229]);
    const columns = await client.unsafe(
      `SELECT memory_embedding_model FROM "${schema}".spaces WHERE id = $1`,
      [spaceId],
    );
    expect(columns[0]?.['memory_embedding_model']).toBeNull();
  });
  it('searches beyond both old scan bounds and returns the actual matched count', async () => {
    const found = await querySkillDiscovery(handle.db, tenantId, spaceId, {
      query: 'skill-1001',
      limit: 5,
    });
    expect(found.total).toBe(1);
    expect(found.skills[0]?.slug).toBe('skill-1001');
    const all = await querySkillDiscovery(handle.db, tenantId, spaceId, { limit: 5 });
    expect(all.total).toBeGreaterThanOrEqual(1005);
    expect(all.skills).toHaveLength(5);
    expect(
      (await querySkillDiscovery(handle.db, tenantId, spaceId, { query: 'Private' })).total,
    ).toBe(0);
  });
  it('filters off skills before counting and paginates the complete result set', async () => {
    const first = await querySkillDiscovery(handle.db, tenantId, spaceId, {
      query: 'pull requests',
      limit: 5,
      excludedSlugs: ['skill-1001'],
    });
    const next = await querySkillDiscovery(handle.db, tenantId, spaceId, {
      query: 'pull requests',
      limit: 5,
      offset: 5,
      excludedSlugs: ['skill-1001'],
    });
    expect(first.total).toBe(1004);
    expect(first.skills.some((s) => next.skills.some((n) => n.slug === s.slug))).toBe(false);
  });
  it('updates and removes derived metadata in the same write as the document', async () => {
    await client.unsafe(
      `UPDATE "${schema}".memory_docs SET inline_content = '{"name":"Unique replacement","description":"Renamed purpose","status":"approved","mode":"process","revision":2}' WHERE space_id = $1 AND path = '/workflows/skill-1005/workflow.json'`,
      [spaceId],
    );
    expect(
      (await querySkillDiscovery(handle.db, tenantId, spaceId, { query: 'Unique replacement' }))
        .skills[0]?.revision,
    ).toBe(2);
    await client.unsafe(
      `UPDATE "${schema}".memory_docs SET deleted_at = now() WHERE space_id = $1 AND path = '/workflows/skill-1005/workflow.json'`,
      [spaceId],
    );
    expect(
      (await querySkillDiscovery(handle.db, tenantId, spaceId, { query: 'Unique replacement' }))
        .total,
    ).toBe(0);
  });
  it('does not overwrite another editor’s settings from a stale directives snapshot', async () => {
    const beforeRows = await client.unsafe(
      `SELECT directives FROM "${schema}".spaces WHERE id = $1`,
      [spaceId],
    );
    const before = beforeRows[0]?.['directives'];
    const first = {
      ...(before as Record<string, unknown>),
      responsibility: 'Changed in another editor',
    };
    const update = (value: unknown) =>
      withTenantSchema(handle.db, createTenantContext(tenantId), async (tx) =>
        tx
          .update(spaces)
          .set({ directives: value as never })
          .where(spaceDirectivesUpdateGuard(spaceId, before))
          .returning({ directives: spaces.directives }),
      );
    expect(await update(first)).toHaveLength(1);
    expect(await update({ modelDefaults: { helmsman: 'stale-model' } })).toHaveLength(0);
    const after = await client.unsafe(`SELECT directives FROM "${schema}".spaces WHERE id = $1`, [
      spaceId,
    ]);
    expect(after[0]?.['directives']).toEqual(first);
  });
  it('preserves explicit parent choices when creating task-based subgroups', async () => {
    const rows = await client.unsafe(`SELECT directives FROM "${schema}".spaces WHERE id = $1`, [
      spaceId,
    ]);
    const placements = (
      rows[0]?.['directives'] as {
        capabilityDiscovery: { bundlePlacements: Record<string, string> };
      }
    ).capabilityDiscovery.bundlePlacements;
    expect(placements['inspect_skills']).toBe('off');
    expect(placements['http_bindings']).toBe('always_on');
    expect(placements['campaigns']).toBe('on_demand');
  });
});
