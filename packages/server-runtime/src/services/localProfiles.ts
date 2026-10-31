/**
 * The local edition's profile lifecycle (Plan 335 P2): list, add, rename, set
 * the avatar and remove.
 *
 * A profile is a human `users` row with an active membership in the pinned
 * tenant (option A). Adding one writes the user, a `member` membership and its
 * first workspace in one transaction. Removing one runs the account erasure
 * cascade, which deletes the spaces only that profile is in and leaves the
 * tenant and every other profile intact.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  createTenantContext,
  executeAccountDeletion,
  planAccountDeletion,
  tenantMemberships,
  users,
  withTenantSchema,
  type AccountDeletionPlan,
} from '@aflow/database';
import { publishRbacInvalidation, RBAC_TENANT_CACHE_PREFIX } from '@aflow/authz';
import {
  TenantRoleSchema,
  localProfileAvatarUrl,
  readLocalProfileAvatar,
  type EditionDescriptor,
  type LocalProfile,
  type LocalProfileAvatar,
  type LocalProfileRemovalPreview,
  type LocalProfileSpace,
  type RemoveLocalProfileResponse,
  type TenantId,
} from '@aflow/schemas';
import { createLocalProfileWorkspace } from '../bootstrap/localEdition.js';
import { bumpLocalProfileSessionGeneration } from '../plugins/localProfiles.js';

export type LocalProfileRefusal = 'not_found' | 'owner' | 'blocked';

/** A request the profile rules refuse. The route answers it with its status. */
export class LocalProfileError extends Error {
  constructor(
    readonly refusal: LocalProfileRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'LocalProfileError';
  }
}

const profileColumns = {
  userId: users.id,
  displayName: users.displayName,
  avatarUrl: users.avatarUrl,
  role: tenantMemberships.role,
  createdAt: users.createdAt,
};

interface ProfileRow {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  createdAt: Date;
}

function toProfile(row: ProfileRow): LocalProfile {
  const role = TenantRoleSchema.catch('member').parse(row.role);
  return {
    userId: row.userId,
    displayName: row.displayName,
    avatar: readLocalProfileAvatar(row.avatarUrl),
    role,
    isOwner: role === 'owner',
    createdAt: row.createdAt.toISOString(),
  };
}

/** The same predicate the profile count reads, so a listed profile is a counted one. */
function isProfileIn(tenantId: string) {
  return and(
    eq(tenantMemberships.tenantId, tenantId),
    eq(tenantMemberships.status, 'active'),
    eq(users.kind, 'human'),
  );
}

/** Every profile of the install, the owner first. */
export async function listLocalProfiles(
  db: PostgresJsDatabase,
  tenantId: string,
): Promise<LocalProfile[]> {
  const rows = await db
    .select(profileColumns)
    .from(tenantMemberships)
    .innerJoin(users, eq(users.id, tenantMemberships.userId))
    .where(isProfileIn(tenantId))
    .orderBy(
      sql`CASE WHEN ${tenantMemberships.role} = 'owner' THEN 0 ELSE 1 END`,
      asc(users.createdAt),
      asc(users.id),
    );
  return rows.map(toProfile);
}

export async function readLocalProfile(
  db: PostgresJsDatabase,
  tenantId: string,
  userId: string,
): Promise<LocalProfile | null> {
  const rows = await db
    .select(profileColumns)
    .from(tenantMemberships)
    .innerJoin(users, eq(users.id, tenantMemberships.userId))
    .where(and(isProfileIn(tenantId), eq(users.id, userId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toProfile(row);
}

async function requireLocalProfile(
  db: PostgresJsDatabase,
  tenantId: string,
  userId: string,
): Promise<LocalProfile> {
  const profile = await readLocalProfile(db, tenantId, userId);
  if (profile === null) {
    throw new LocalProfileError('not_found', 'No profile with that id on this install.');
  }
  return profile;
}

/**
 * Adds a profile and its first workspace, in one transaction.
 *
 * The user carries no email (Plan 335 §5): a later aflow.ai account supplies
 * one, and an invented address would be a second identity to undo.
 */
export async function addLocalProfile(
  db: PostgresJsDatabase,
  opts: {
    edition: EditionDescriptor;
    tenantId: TenantId;
    displayName: string;
    avatar: LocalProfileAvatar;
  },
): Promise<{ profile: LocalProfile; spaceId: string }> {
  const userId = randomUUID();
  return withTenantSchema(db, createTenantContext(opts.tenantId), async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        id: userId,
        displayName: opts.displayName,
        avatarUrl: localProfileAvatarUrl(opts.avatar),
        kind: 'human',
        status: 'active',
      })
      .returning({ createdAt: users.createdAt });
    if (!user) throw new Error('Failed to create the profile user');
    await tx.insert(tenantMemberships).values({
      tenantId: opts.tenantId,
      userId,
      role: 'member',
      status: 'active',
      joinedAt: new Date(),
    });
    const spaceId = await createLocalProfileWorkspace(tx, {
      edition: opts.edition,
      tenantId: opts.tenantId,
      userId,
      isTenantAdmin: false,
    });
    return {
      profile: toProfile({
        userId,
        displayName: opts.displayName,
        avatarUrl: localProfileAvatarUrl(opts.avatar),
        role: 'member',
        createdAt: user.createdAt,
      }),
      spaceId,
    };
  });
}

/** Renames a profile, changes its avatar, or both. The owner's own profile included. */
export async function updateLocalProfile(
  db: PostgresJsDatabase,
  opts: {
    tenantId: string;
    userId: string;
    displayName?: string | undefined;
    avatar?: LocalProfileAvatar | undefined;
  },
): Promise<LocalProfile> {
  await requireLocalProfile(db, opts.tenantId, opts.userId);
  await db
    .update(users)
    .set({
      ...(opts.displayName === undefined ? {} : { displayName: opts.displayName }),
      ...(opts.avatar === undefined ? {} : { avatarUrl: localProfileAvatarUrl(opts.avatar) }),
      updatedAt: new Date(),
    })
    .where(eq(users.id, opts.userId));
  return requireLocalProfile(db, opts.tenantId, opts.userId);
}

interface RemovalPlan {
  profile: LocalProfile;
  plan: AccountDeletionPlan;
  spacesDeleted: LocalProfileSpace[];
  spacesTransferred: LocalProfileSpace[];
}

async function planLocalProfileRemoval(
  db: PostgresJsDatabase,
  sqlClient: postgres.Sql,
  tenantId: string,
  userId: string,
): Promise<RemovalPlan> {
  const profile = await requireLocalProfile(db, tenantId, userId);
  if (profile.isOwner) {
    throw new LocalProfileError('owner', 'The owner profile cannot be removed.');
  }
  const plan = await planAccountDeletion(sqlClient, userId);
  // The cascade erases a user from every tenant it belongs to. A local profile
  // belongs to the pinned tenant alone, so any other membership is a user this
  // route did not make, and erasing it from here would reach past the install.
  const foreign = plan.tenants.filter((tenant) => tenant.tenantId !== tenantId);
  if (foreign.length > 0) {
    throw new LocalProfileError(
      'blocked',
      'This user belongs to another tenant too, so removing the profile here would erase it there.',
    );
  }
  if (plan.blockers.length > 0) {
    throw new LocalProfileError('blocked', plan.blockers.join(' '));
  }
  const spacesDeleted = plan.tenants.flatMap((tenant) =>
    tenant.spacesToPurge.map((space) => ({ spaceId: space.spaceId, name: space.name })),
  );
  const spacesTransferred = plan.tenants.flatMap((tenant) =>
    tenant.spacesToTransfer.map((space) => ({ spaceId: space.spaceId, name: space.name })),
  );
  return { profile, plan, spacesDeleted, spacesTransferred };
}

/** What removing a profile would delete, read without writing anything. */
export async function previewLocalProfileRemoval(
  db: PostgresJsDatabase,
  sqlClient: postgres.Sql,
  tenantId: string,
  userId: string,
): Promise<LocalProfileRemovalPreview> {
  const { profile, plan, spacesDeleted, spacesTransferred } = await planLocalProfileRemoval(
    db,
    sqlClient,
    tenantId,
    userId,
  );
  const deletedRows: Record<string, number> = {};
  for (const tenant of plan.tenants) {
    for (const [table, count] of Object.entries(tenant.purgeCounts)) {
      deletedRows[table] = (deletedRows[table] ?? 0) + count;
    }
  }
  return { profile, spacesDeleted, spacesTransferred, deletedRows };
}

/**
 * Removes a profile: ends its sessions, then erases the user.
 *
 * The generation bump comes first, so a session still in use is refused from
 * that moment rather than from the commit. The cached tenant role is evicted
 * after, because it would otherwise answer for a deleted membership for up to
 * the cache's lifetime.
 */
export async function removeLocalProfile(
  db: PostgresJsDatabase,
  opts: {
    sql: postgres.Sql;
    redis: Redis | null | undefined;
    tenantId: string;
    userId: string;
    onCacheError?: (err: unknown) => void;
  },
): Promise<RemoveLocalProfileResponse> {
  const { plan, spacesDeleted, spacesTransferred } = await planLocalProfileRemoval(
    db,
    opts.sql,
    opts.tenantId,
    opts.userId,
  );
  await bumpLocalProfileSessionGeneration(db, opts.userId);
  await executeAccountDeletion(opts.sql, plan);
  if (opts.redis) {
    try {
      await opts.redis.del(`${RBAC_TENANT_CACHE_PREFIX}:${opts.userId}:${opts.tenantId}`);
      await publishRbacInvalidation(opts.redis, opts.userId, opts.tenantId);
    } catch (err) {
      opts.onCacheError?.(err);
    }
  }
  return { userId: opts.userId, spacesDeleted, spacesTransferred };
}
