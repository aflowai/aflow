/**
 * Bootstrap runs on a real database, twice, and the second run changes nothing.
 *
 * The property under test is not that the rows appear — it is that a restart
 * neither duplicates them nor overwrites what the operator has since changed,
 * which no in-memory double can demonstrate.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type postgres from 'postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  capabilityProfiles,
  createDatabase,
  createTenantContext,
  dropTenantSchema,
  spaceCapabilityAssignments,
  spaceMemberships,
  spaces,
  tenantMemberships,
  tenants,
  withTenantSchema,
} from '@aflow/database';
import type { EditionDescriptor, TenantId } from '@aflow/schemas';
import { bootstrapLocalEdition } from './localEdition.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

// A tenant of its own, so the run never touches the dev instance's data.
const TENANT_ID = '00000000-0000-4000-8000-0000000ed246' as TenantId;
const OWNER_ID = randomUUID();

const EDITION: EditionDescriptor = {
  edition: 'community-local',
  authProvider: 'local-instance',
  tenancy: { mode: 'fixed', tenantId: TENANT_ID },
  exposure: { bind: 'loopback', requireTls: false },
  computeRuntime: 'absent',
  codeLane: 'absent',
  hostLane: 'absent',
  browserLane: 'absent',
};

describeDb('bootstrapLocalEdition', () => {
  let sql: postgres.Sql;
  let db: PostgresJsDatabase;

  // A single connection: applying the tenant migrations issues its own
  // transactions, which a pooled client refuses.
  async function clear(): Promise<void> {
    await dropTenantSchema(sql, TENANT_ID).catch(() => undefined);
    await sql`DELETE FROM public.space_memberships WHERE tenant_id = ${TENANT_ID}`;
    await sql`DELETE FROM public.tenant_memberships WHERE tenant_id = ${TENANT_ID}`;
    await sql`DELETE FROM public.tenants WHERE tenant_id = ${TENANT_ID}`;
    await sql`DELETE FROM public.users WHERE id = ${OWNER_ID}`;
  }

  beforeAll(async () => {
    const connection = createDatabase({
      connectionString: DATABASE_URL as string,
      maxConnections: 1,
    });
    sql = connection.sql;
    db = connection.db;
    // Leftovers from an interrupted run would make the first assertion read
    // "already present" and pass for the wrong reason.
    await clear();
  }, 60_000);

  afterAll(async () => {
    await clear();
    await sql.end();
  }, 60_000);

  it('establishes a usable instance, then leaves it alone', async () => {
    const first = await bootstrapLocalEdition({ edition: EDITION, sql, db, ownerId: OWNER_ID });

    expect(first.tenantId).toBe(TENANT_ID);
    expect(first.ownerId).toBe(OWNER_ID);
    expect(first.steps.filter((s) => s.outcome === 'created').map((s) => s.name)).toEqual([
      'tenant',
      'tenant schema',
      'owner',
      'tenant membership',
      'workspace',
      'default workspace',
      'workspace membership',
      'capability assignment',
    ]);

    const second = await bootstrapLocalEdition({ edition: EDITION, sql, db, ownerId: OWNER_ID });

    expect(second.spaceIds).toEqual(first.spaceIds);
    expect(second.steps.every((s) => s.outcome === 'present')).toBe(true);

    // One workspace, not one per restart — and none left unowned beside it.
    const owned = await withTenantSchema(db, createTenantContext(TENANT_ID), (tx) =>
      tx.select({ id: spaces.id, ownerId: spaces.ownerId }).from(spaces),
    );
    expect(owned).toHaveLength(1);
    expect(owned[0]?.ownerId).toBe(OWNER_ID);

    const memberships = await db
      .select({ role: tenantMemberships.role })
      .from(tenantMemberships)
      .where(
        and(eq(tenantMemberships.tenantId, TENANT_ID), eq(tenantMemberships.userId, OWNER_ID)),
      );
    expect(memberships).toEqual([{ role: 'owner' }]);

    const spaceRoles = await db
      .select({ role: spaceMemberships.role })
      .from(spaceMemberships)
      .where(eq(spaceMemberships.spaceId, first.spaceIds[0] as string));
    expect(spaceRoles).toEqual([{ role: 'admin' }]);

    // The public migrations backfill this pointer before the tenant row
    // exists, so bootstrap is the only thing that can set it.
    const [tenantRow] = await db
      .select({ defaultSpaceId: tenants.defaultSpaceId })
      .from(tenants)
      .where(eq(tenants.tenantId, TENANT_ID));
    expect(tenantRow?.defaultSpaceId).toBe(first.spaceIds[0]);
  }, 120_000);

  it('assigns the first workspace the profile every other space on the edition gets', async () => {
    const report = await bootstrapLocalEdition({ edition: EDITION, sql, db, ownerId: OWNER_ID });

    const assigned = await withTenantSchema(db, createTenantContext(TENANT_ID), async (tx) => {
      const rows = await tx
        .select({ name: capabilityProfiles.name })
        .from(spaceCapabilityAssignments)
        .innerJoin(
          capabilityProfiles,
          eq(capabilityProfiles.id, spaceCapabilityAssignments.profileId),
        )
        .where(eq(spaceCapabilityAssignments.spaceId, report.spaceIds[0] as string));
      return rows;
    });

    expect(assigned).toEqual([{ name: 'Full Access' }]);
  }, 120_000);

  it('leaves a default workspace the operator has since chosen', async () => {
    const [second] = await withTenantSchema(db, createTenantContext(TENANT_ID), (tx) =>
      tx
        .insert(spaces)
        .values({ name: 'Second', slug: 'second', ownerId: OWNER_ID, createdBy: OWNER_ID })
        .returning({ id: spaces.id }),
    );
    const chosen = second?.id as string;
    await db.update(tenants).set({ defaultSpaceId: chosen }).where(eq(tenants.tenantId, TENANT_ID));

    const report = await bootstrapLocalEdition({ edition: EDITION, sql, db, ownerId: OWNER_ID });

    expect(report.steps).toContainEqual({
      name: 'default workspace',
      outcome: 'present',
      detail: chosen,
    });

    const [tenantRow] = await db
      .select({ defaultSpaceId: tenants.defaultSpaceId })
      .from(tenants)
      .where(eq(tenants.tenantId, TENANT_ID));
    expect(tenantRow?.defaultSpaceId).toBe(chosen);
  }, 120_000);

  it('refuses to run against a multi-tenant edition', async () => {
    await expect(
      bootstrapLocalEdition({
        edition: { ...EDITION, tenancy: { mode: 'multi' } },
        sql,
        db,
        ownerId: OWNER_ID,
      }),
    ).rejects.toThrow(/selects its tenant per request/);
  });
});
