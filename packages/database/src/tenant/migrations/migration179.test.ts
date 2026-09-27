/**
 * Run against the real migrated schema, not a hand-built fixture. A fixture
 * seeded with the names the migration looks for proves only that the string
 * matches itself: rename `Personal Safe` upstream and both the migration and
 * the test stay green while a live tenant loses media generation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  enforceGrant,
  getOperation,
  getOperationCapability,
  type CapabilityEntry,
  type RunAccessGrant,
} from '@aflow/schemas';
import { applyTenantMigrations } from './apply.js';
import { applyMigration179 } from './migration179.js';

const DATABASE_URL = process.env['DATABASE_URL'];

// Sentinel scratch schema per the sandbox convention (bb5a0000 prefix),
// padded to the `t_[0-9a-f]{32}` shape `isValidSchemaName` expects.
const SCHEMA_NAME = 't_bb5a0000000000000000000000000179';

const describeDb = DATABASE_URL ? describe : describe.skip;

const MEDIA_READ = { capabilityGroupId: 'ai.media', accessMode: 'read' } as const;
const MEDIA_WRITE = { capabilityGroupId: 'ai.media', accessMode: 'write' } as const;

/** The profile names the migration itself grants to, read out of its SQL. */
function grantedProfileNames(): string[] {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'migration179.ts'),
    'utf8',
  );
  const clause = /name IN \(([^)]+)\)/.exec(source);
  expect(clause, 'migration no longer selects profiles by name').not.toBeNull();
  return Array.from((clause?.[1] ?? '').matchAll(/'([^']+)'/g), (match) => match[1] as string);
}

function grantWith(profileName: string, allowed: CapabilityEntry[]): RunAccessGrant {
  return {
    spaceId: '00000000-0000-0000-0000-0000000000aa',
    accessLevel: 'write',
    grantedToUserId: '00000000-0000-0000-0000-0000000000bb',
    tenantRole: 'admin',
    spaceRole: 'admin',
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    capabilities: {
      allowedCapabilities: allowed,
      deniedCapabilities: [],
      allowedRiskModifiers: ['external_side_effect'],
      deniedRiskModifiers: [],
      allowPrivileged: false,
    },
    compiledProfileName: profileName,
    resourceScopes: [],
  };
}

function allowsVideoGeneration(profileName: string, allowed: CapabilityEntry[]): boolean {
  const op = getOperation('ai.media.video')!;
  const capability = getOperationCapability('ai.media.video')!;
  return enforceGrant(
    grantWith(profileName, allowed),
    'ai.media.video',
    op.mutates,
    op.privileged ?? false,
    capability.capabilityGroupId,
    capability.accessMode,
    op.riskModifiers,
  ).allowed;
}

describeDb('migration179 — ai.media is a write capability (real DB)', () => {
  const notices: string[] = [];
  // The chain opens transactions, which postgres.js only allows on a single
  // reserved connection.
  const sql = postgres(DATABASE_URL ?? '', {
    max: 1,
    onnotice: (notice) => notices.push(notice.message),
  });

  async function allowedFor(name: string): Promise<CapabilityEntry[]> {
    const rows = await sql<{ allowed_capabilities: CapabilityEntry[] }[]>`
      SELECT allowed_capabilities FROM ${sql(SCHEMA_NAME)}.capability_profiles WHERE name = ${name}`;
    return rows[0]?.allowed_capabilities ?? [];
  }

  async function systemProfileNames(): Promise<string[]> {
    const rows = await sql<{ name: string }[]>`
      SELECT name FROM ${sql(SCHEMA_NAME)}.capability_profiles WHERE is_system_profile = true`;
    return rows.map((row) => row.name);
  }

  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA_NAME}" CASCADE`);
    await sql.unsafe(`CREATE SCHEMA "${SCHEMA_NAME}"`);
    await applyTenantMigrations(sql, SCHEMA_NAME);
  }, 120_000);

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA_NAME}" CASCADE`);
    await sql.end();
  });

  it('names profiles the migrated schema actually seeds', async () => {
    const seeded = await systemProfileNames();
    expect(seeded).toEqual(expect.arrayContaining(grantedProfileNames()));
  });

  it('grants ai.media:write to every profile it names', async () => {
    for (const name of grantedProfileNames()) {
      const allowed = await allowedFor(name);
      expect(allowed, name).toContainEqual(MEDIA_WRITE);
      expect(allowed, name).not.toContainEqual(MEDIA_READ);
    }
  });

  it('leaves the viewer profile unable to spend', async () => {
    const readOnly = await allowedFor('Read Only');
    expect(readOnly).not.toContainEqual(MEDIA_WRITE);
    expect(readOnly).not.toContainEqual(MEDIA_READ);
    expect(readOnly).toContainEqual({ capabilityGroupId: 'agent.control', accessMode: 'write' });
  });

  it('records itself in the migrated schema', async () => {
    const recorded = await sql<{ version: number }[]>`
      SELECT version FROM ${sql(SCHEMA_NAME)}.schema_migrations WHERE version = 179`;
    expect(recorded).toHaveLength(1);
  });

  it('lets Standard generate video and refuses Read Only', async () => {
    expect(allowsVideoGeneration('Standard', await allowedFor('Standard'))).toBe(true);
    expect(allowsVideoGeneration('Read Only', await allowedFor('Read Only'))).toBe(false);
  });

  it('drops the dead read from operator-authored profiles too, and names them', async () => {
    await sql.unsafe(`
      INSERT INTO "${SCHEMA_NAME}".capability_profiles (name, allowed_capabilities, is_system_profile)
      VALUES ('Tenant Custom', '[{"capabilityGroupId":"ai.media","accessMode":"read"}]'::jsonb, false);

      UPDATE "${SCHEMA_NAME}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"ai.media","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true;

      DELETE FROM "${SCHEMA_NAME}".schema_migrations WHERE version = 179;
    `);

    notices.length = 0;
    await applyMigration179(sql, SCHEMA_NAME);

    expect(await allowedFor('Tenant Custom')).toEqual([]);
    for (const name of await systemProfileNames()) {
      expect(await allowedFor(name), name).not.toContainEqual(MEDIA_READ);
    }
    expect(notices.join('\n')).toContain("'Tenant Custom'");
  });

  it('is a no-op on a schema it has already migrated', async () => {
    const before = await allowedFor('Full Access');
    await applyMigration179(sql, SCHEMA_NAME);
    expect(await allowedFor('Full Access')).toEqual(before);
  });
});
