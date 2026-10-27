/**
 * Creating a space, as every surface that creates one does it: the create
 * route, and the Store's install of a `space` listing (Plan 330 D1), which
 * creates the space a template applies to inside its own install transaction.
 * One sequence, so a space made from a template is held to the same slug,
 * quota, model, capability-profile, membership and bootstrap rules as any
 * other.
 */
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  createTenantContext,
  findDefaultCapabilityProfileId,
  getTenantProvisioningPolicy,
  spaceCapabilityAssignments,
  spaceMemberships,
  spaceSlugHistory,
  spaces,
  withTenantSchema,
} from '@aflow/database';
import { canCreateSpace } from '@aflow/authz';
import {
  DEFAULT_SPACE_CODE_POLICY,
  DEFAULT_SPACE_COMPUTE_POLICY,
  defaultSpaceDirectives,
  defaultsToSafeProfile,
  validateSpaceSlug,
  type EntityDirectives,
  type SpaceCodePolicy,
  type SpaceComputePolicy,
} from '@aflow/schemas';
import { withTenantDefaultModels } from '../lib/agentModelPolicy.js';
import { databaseErrorText } from '../lib/databaseErrors.js';
import { validateAgentCapabilitySettings } from '../routes/agentCapabilityValidation.js';
import {
  allowedAgentModelRefs,
  offListAgentModelError,
  offListAgentModelRefs,
} from '../routes/spacesShared.js';
import type { TenantContext } from '../plugins/tenant.js';
import { bootstrapCyberneticEntity } from './entityBootstrap.js';

type Edition = FastifyInstance['edition'];

export interface SpaceCreationRefusal {
  ok: false;
  status: 400 | 403 | 409;
  body: { error: string; message: string };
}

type ProvisioningPolicy = Awaited<ReturnType<typeof getTenantProvisioningPolicy>>;

export interface ValidatedSpaceCreation {
  ok: true;
  directives: EntityDirectives;
  provisioning: ProvisioningPolicy;
}

/**
 * Everything decided before the space's transaction: who may create one, the
 * slug, and the directives the space starts with, held to the tenant's models.
 */
export async function validateSpaceCreation(params: {
  db: PostgresJsDatabase;
  tenant: TenantContext;
  edition: Edition;
  slug: string;
  directives: EntityDirectives | undefined;
  /** The model roles the caller named; the rest take the tenant's defaults. */
  chosenModelRoles: ReadonlySet<string>;
}): Promise<ValidatedSpaceCreation | SpaceCreationRefusal> {
  const { db, tenant, slug } = params;
  // Any tenant member (or above) can create spaces
  const memberRoles = ['owner', 'admin', 'member'];
  if (!memberRoles.includes(tenant.tenantRole)) {
    return {
      ok: false,
      status: 403,
      body: { error: 'Forbidden', message: 'Member access required' },
    };
  }
  const provisioning = await getTenantProvisioningPolicy(db, tenant.tenantId);
  if (!canCreateSpace(tenant.tenantRole)) {
    return {
      ok: false,
      status: 403,
      body: { error: 'Forbidden', message: 'Member access required to create spaces' },
    };
  }
  const slugValidation = validateSpaceSlug(slug);
  if (!slugValidation.ok) {
    return {
      ok: false,
      status: 400,
      body: { error: slugValidation.code, message: slugValidation.message },
    };
  }

  const allowedModels = await allowedAgentModelRefs(db, tenant.tenantId, params.edition.edition);
  const directives = withTenantDefaultModels(
    params.directives ?? defaultSpaceDirectives(),
    allowedModels.ids,
    params.chosenModelRoles,
  );
  const offListModels = offListAgentModelRefs(directives, allowedModels);
  if (offListModels.length > 0) {
    return {
      ok: false,
      status: 400,
      body: offListAgentModelError(offListModels, allowedModels.ids),
    };
  }
  const placementError = await validateAgentCapabilitySettings(
    { db, tenantId: tenant.tenantId },
    directives.capabilityDiscovery,
  );
  if (placementError) return { ok: false, status: 400, body: placementError };
  return { ok: true, directives, provisioning };
}

/**
 * Insert the space and assign its capability profile, inside the caller's
 * tenant transaction. Refusals throw `SLUG_RETIRED:` / `SPACE_QUOTA_REACHED:`
 * errors that `spaceCreationFailure` turns into a response.
 */
export async function insertSpaceRecord(
  tx: PostgresJsDatabase,
  params: {
    tenant: TenantContext;
    edition: Edition;
    userId: string;
    provisioning: ProvisioningPolicy;
    name: string;
    slug: string;
    description?: string | undefined;
    directives: EntityDirectives;
    computePolicy?: SpaceComputePolicy | undefined;
    codePolicy?: SpaceCodePolicy | undefined;
  },
): Promise<Record<string, unknown> | null> {
  const { tenant, userId, slug } = params;
  const [retired] = await tx
    .select({ id: spaceSlugHistory.id })
    .from(spaceSlugHistory)
    .where(eq(spaceSlugHistory.oldSlug, slug))
    .limit(1);
  if (retired) {
    throw new Error(`SLUG_RETIRED:${slug}`);
  }

  // Quota counts active owned spaces regardless of sharing state —
  // sharing a space must not free a quota slot. Tenant admins are
  // exempt (they administer the quota itself).
  const maxSpaces = params.provisioning.quotas.maxSpacesPerUser;
  if (!tenant.isAdmin && maxSpaces !== undefined) {
    // Serialize concurrent count-then-insert per owner; released at
    // transaction end.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`space-quota:${userId}`}))`);
    const owned = await tx
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.ownerId, userId), isNull(spaces.archivedAt)));
    if (owned.length >= maxSpaces) {
      throw new Error(`SPACE_QUOTA_REACHED:${String(maxSpaces)}`);
    }
  }

  const vals: Record<string, unknown> = {
    name: params.name,
    slug,
    createdBy: userId,
    ownerId: userId,
  };
  if (params.description !== undefined) vals['description'] = params.description;
  vals['directives'] = params.directives;
  // Clients no longer hardcode compute policy — a space starts with
  // the platform default unless the creator specifies one.
  vals['computePolicy'] = params.computePolicy ?? DEFAULT_SPACE_COMPUTE_POLICY;
  vals['codePolicy'] = params.codePolicy ?? DEFAULT_SPACE_CODE_POLICY;

  const rows = await tx
    .insert(spaces)
    .values(vals as typeof spaces.$inferInsert)
    .returning();

  const spaceRow = rows[0];
  if (!spaceRow) return null;
  const spaceId = (spaceRow as Record<string, unknown>)['id'] as string;

  // The tenant capability ceiling still ANDs over whichever profile
  // ends up assigned.
  const memberSafeDefault = defaultsToSafeProfile({
    isTenantAdmin: tenant.isAdmin,
    edition: params.edition,
  });
  const profileId = await findDefaultCapabilityProfileId(tx, { memberSafeDefault });
  if (!profileId) {
    throw new Error(
      `${memberSafeDefault ? 'Personal Safe' : 'Full Access'} capability profile not found — cannot provision space`,
    );
  }
  await tx.insert(spaceCapabilityAssignments).values({
    spaceId,
    profileId,
    assignedBy: userId,
  });

  return spaceRow as Record<string, unknown>;
}

/** The response for a refusal `insertSpaceRecord` threw, or null when the error is not one. */
export function spaceCreationFailure(err: unknown, slug: string): SpaceCreationRefusal | null {
  const msg = databaseErrorText(err);
  if (msg.startsWith('SLUG_RETIRED:')) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'SLUG_RETIRED',
        message: `"${slug}" is a retired slug from an existing space; reuse is blocked while history exists`,
      },
    };
  }
  if (msg.startsWith('SPACE_QUOTA_REACHED:')) {
    const limit = msg.slice('SPACE_QUOTA_REACHED:'.length);
    return {
      ok: false,
      status: 403,
      body: {
        error: 'QuotaExceeded',
        message: `You have reached the limit of ${limit} spaces. Archive one you no longer use, or ask an administrator to raise the limit.`,
      },
    };
  }
  // Detect unique constraint violation on slug
  if (msg.includes('unique constraint') && msg.includes('slug')) {
    return {
      ok: false,
      status: 409,
      body: { error: 'Conflict', message: `A workspace with slug "${slug}" already exists` },
    };
  }
  return null;
}

/**
 * Membership and bootstrap, once the space's transaction has committed. If
 * either fails the space is deleted, so a retry does not meet its own slug.
 */
export async function provisionCreatedSpace(params: {
  db: PostgresJsDatabase;
  redis: Redis | null | undefined;
  tenant: TenantContext;
  userId: string;
  spaceId: string;
  directives: EntityDirectives;
  log: FastifyBaseLogger;
}): Promise<{ helmsmanResolved: boolean }> {
  const { db, tenant, spaceId, log } = params;
  try {
    await db.insert(spaceMemberships).values({
      spaceId,
      tenantId: tenant.tenantId,
      userId: params.userId,
      role: 'admin',
    });

    const bootstrapResult = await bootstrapCyberneticEntity({
      tenantId: tenant.tenantId,
      spaceId,
      directives: params.directives,
      db,
      redis: params.redis,
      isFirstActivation: true,
      changedDirectiveKeys: [],
      operatorUserId: params.userId,
    });
    log.info(
      {
        spaceId,
        created: bootstrapResult.created,
        resolvedAgents: bootstrapResult.resolvedAgents,
        firstActivation: true,
        durationMs: bootstrapResult.durationMs,
      },
      'Cybernetic entity bootstrapped during space creation',
    );
    return { helmsmanResolved: Boolean(bootstrapResult.resolvedAgents.helmsman) };
  } catch (provisionErr) {
    // Clean up: delete the space so the user can retry without slug conflict
    log.error({ err: provisionErr, spaceId }, 'Space provisioning failed — cleaning up space row');
    try {
      await withTenantSchema(db, createTenantContext(tenant.tenantId), async (tx: unknown) => {
        await (tx as PostgresJsDatabase).execute(sql`DELETE FROM spaces WHERE id = ${spaceId}`);
      });
      await db.delete(spaceMemberships).where(eq(spaceMemberships.spaceId, spaceId));
    } catch (cleanupErr) {
      log.error({ err: cleanupErr, spaceId }, 'Space cleanup also failed');
    }
    throw provisionErr;
  }
}
