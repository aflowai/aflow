/**
 * Bring a local-edition instance to a usable state, and leave an already-usable
 * one alone.
 *
 * The appliance authenticates as its own instance, which means the request
 * arrives as a user the database has never seen: no tenant schema, no user row,
 * no workspace, no capability assignment. Nothing in the hosted product creates
 * those — a JWT arrives and JIT provisioning follows it — so the local edition
 * needs the equivalent as a command it can run before the API serves anything.
 *
 * Every step reads before it writes, so this runs on first boot and on every
 * boot after it. What it repairs is the fixed scaffolding; what the operator
 * has since built on top of that is never touched.
 */
import type postgres from 'postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DEFAULT_SPACE_COMPUTE_POLICY, defaultsToSafeProfile } from '@aflow/schemas';
import { and, eq, isNull } from 'drizzle-orm';
import {
  createTenantContext,
  findDefaultCapabilityProfileId,
  createTenantSchema,
  spaceMemberships,
  spaceCapabilityAssignments,
  spaces,
  tenantIdToSchemaName,
  tenantMemberships,
  tenants,
  tenantSchemaExists,
  withTenantSchema,
  applyTenantMigrations,
} from '@aflow/database';
import type { EditionDescriptor, TenantId } from '@aflow/schemas';

const FIRST_WORKSPACE = { name: 'Personal', slug: 'personal' } as const;

export type StepOutcome = 'created' | 'present';

export interface BootstrapStep {
  name: string;
  outcome: StepOutcome;
  detail?: string;
}

export interface BootstrapReport {
  tenantId: TenantId;
  ownerId: string;
  /** Every workspace the owner holds after this run, oldest first. */
  spaceIds: string[];
  steps: BootstrapStep[];
}

export interface BootstrapOptions {
  edition: EditionDescriptor;
  sql: postgres.Sql;
  db: PostgresJsDatabase;
  ownerId: string;
  ownerDisplayName?: string;
}

export async function bootstrapLocalEdition({
  edition,
  sql,
  db,
  ownerId,
  ownerDisplayName = 'Local user',
}: BootstrapOptions): Promise<BootstrapReport> {
  if (edition.tenancy.mode !== 'fixed') {
    throw new Error(
      'Refusing to bootstrap: this command provisions the single tenant a local edition pins, ' +
        'and the resolved edition selects its tenant per request.',
    );
  }

  const tenantId = edition.tenancy.tenantId as TenantId;
  const steps: BootstrapStep[] = [];
  const record = (name: string, outcome: StepOutcome, detail?: string): void => {
    steps.push(detail === undefined ? { name, outcome } : { name, outcome, detail });
  };

  // ---- Tenant row --------------------------------------------------------
  const schemaName = tenantIdToSchemaName(tenantId);
  const insertedTenant = await sql`
    INSERT INTO public.tenants (tenant_id, schema_name, name, status, plan)
    VALUES (${tenantId}, ${schemaName}, 'Local', 'active', 'free')
    ON CONFLICT (tenant_id) DO NOTHING
    RETURNING tenant_id
  `;
  record('tenant', insertedTenant.length > 0 ? 'created' : 'present', schemaName);

  // ---- Tenant schema and migrations --------------------------------------
  if (await tenantSchemaExists(sql, tenantId)) {
    await applyTenantMigrations(sql, schemaName);
    record('tenant schema', 'present', 'migrations applied');
  } else {
    await createTenantSchema(sql, tenantId);
    record('tenant schema', 'created', schemaName);
  }

  // ---- Owner ------------------------------------------------------------
  const insertedUser = await sql`
    INSERT INTO public.users (id, display_name, kind, status)
    VALUES (${ownerId}, ${ownerDisplayName}, 'human', 'active')
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  record('owner', insertedUser.length > 0 ? 'created' : 'present', ownerId);

  const existingMembership = await db
    .select({ userId: tenantMemberships.userId })
    .from(tenantMemberships)
    .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, ownerId)))
    .limit(1);

  if (existingMembership.length === 0) {
    await db
      .insert(tenantMemberships)
      .values({ tenantId, userId: ownerId, role: 'owner', status: 'active' });
    record('tenant membership', 'created', 'owner');
  } else {
    record('tenant membership', 'present');
  }

  // ---- First workspace ---------------------------------------------------
  const tenantCtx = createTenantContext(tenantId);

  const spaceId = await withTenantSchema(db, tenantCtx, async (tx) => {
    // The tenant schema seeds its own space, unowned because the hosted
    // product hands it to whoever is admitted first. Nobody else is coming, so
    // claiming it is both correct and what keeps first boot from showing a
    // workspace the operator cannot enter beside the one bootstrap made.
    const claimed = await tx
      .update(spaces)
      // The seeded description reads "Default shared space", which describes a
      // hosted arrangement this instance does not have. Cleared here and only
      // here: the same predicate that claims an unowned space is the proof it
      // is still the seed and not something the operator has since written.
      .set({
        ownerId,
        createdBy: ownerId,
        description: null,
        // An explicit no, because absent means something else: the compute
        // executor runs a space carrying no policy, and the appliance ships no
        // sandbox to run it in. Saying so here is what lets an agent be told
        // why rather than discovering it when a call goes nowhere.
        computePolicy: { ...DEFAULT_SPACE_COMPUTE_POLICY, enabled: false },
      })
      .where(and(isNull(spaces.ownerId), isNull(spaces.archivedAt)))
      .returning({ id: spaces.id });

    if (claimed.length > 0) {
      record('workspace', 'created', `claimed ${String(claimed.length)}`);
    }

    const owned = await tx
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.ownerId, ownerId), isNull(spaces.archivedAt)))
      .orderBy(spaces.createdAt);

    const first = owned[0];
    if (first) {
      if (claimed.length === 0) record('workspace', 'present', first.id);
      return owned.map((space) => space.id);
    }

    const [created] = await tx
      .insert(spaces)
      .values({
        name: FIRST_WORKSPACE.name,
        slug: FIRST_WORKSPACE.slug,
        ownerId,
        createdBy: ownerId,
        // Same explicit no as the claimed space above. A workspace made by the
        // repair path is no likelier to have a sandbox behind it.
        computePolicy: { ...DEFAULT_SPACE_COMPUTE_POLICY, enabled: false },
      })
      .returning({ id: spaces.id });

    if (!created) throw new Error('Failed to create the first workspace');
    record('workspace', 'created', created.id);
    return [created.id];
  });

  // ---- Default workspace pointer -----------------------------------------
  // The public migrations backfill this pointer from the seeded General space,
  // but they run before this command inserts the tenant row, so a local
  // instance would reach its first request with the pointer still null and the
  // client picking a workspace by its own fallback order instead.
  const defaultSpace = spaceId[0];
  if (!defaultSpace) throw new Error('Failed to resolve the first workspace');

  const [tenantRow] = await db
    .select({ defaultSpaceId: tenants.defaultSpaceId })
    .from(tenants)
    .where(eq(tenants.tenantId, tenantId))
    .limit(1);

  if (tenantRow?.defaultSpaceId) {
    record('default workspace', 'present', tenantRow.defaultSpaceId);
  } else {
    await db
      .update(tenants)
      .set({ defaultSpaceId: defaultSpace })
      .where(and(eq(tenants.tenantId, tenantId), isNull(tenants.defaultSpaceId)));
    record('default workspace', 'created', defaultSpace);
  }

  const heldMemberships = await db
    .select({ spaceId: spaceMemberships.spaceId })
    .from(spaceMemberships)
    .where(eq(spaceMemberships.userId, ownerId));
  const held = new Set(heldMemberships.map((row) => row.spaceId));

  const missingMemberships = spaceId.filter((id) => !held.has(id));
  if (missingMemberships.length > 0) {
    await db
      .insert(spaceMemberships)
      .values(
        missingMemberships.map((id) => ({ tenantId, spaceId: id, userId: ownerId, role: 'admin' })),
      );
    record('workspace membership', 'created', `${String(missingMemberships.length)} admin`);
  } else {
    record('workspace membership', 'present');
  }

  // ---- Agent authority ceiling -------------------------------------------
  await withTenantSchema(db, tenantCtx, async (tx) => {
    const assigned = await tx
      .select({ spaceId: spaceCapabilityAssignments.spaceId })
      .from(spaceCapabilityAssignments);
    const alreadyAssigned = new Set(assigned.map((row) => row.spaceId));

    const unassigned = spaceId.filter((id) => !alreadyAssigned.has(id));
    if (unassigned.length === 0) {
      record('capability assignment', 'present');
      return;
    }

    // The same rule and resolver as every other space-creation path, so the first
    // workspace is not the one space that starts differently.
    const profileId = await findDefaultCapabilityProfileId(tx, {
      memberSafeDefault: defaultsToSafeProfile({ isTenantAdmin: true, edition }),
    });
    if (profileId === undefined) {
      throw new Error(
        'Refusing to leave a workspace unassigned: no default system profile exists.',
      );
    }

    await tx
      .insert(spaceCapabilityAssignments)
      .values(unassigned.map((id) => ({ spaceId: id, profileId, assignedBy: ownerId })));
    record('capability assignment', 'created', `${String(unassigned.length)} space(s)`);
  });

  return { tenantId, ownerId, spaceIds: spaceId, steps };
}
