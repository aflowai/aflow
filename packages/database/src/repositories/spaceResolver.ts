import { and, eq, desc, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { TenantId, SpaceSlug } from '@aflow/schemas';

import { spaces, spaceSlugHistory, type SpaceRow } from '../schema/tenant.js';
import { withTenantSchema, createTenantContext } from '../tenant.js';

// ============================================================================
// Errors
// ============================================================================

export class UnknownSpaceSlugError extends Error {
  constructor(public readonly slug: string) {
    super(`No space with slug "${slug}" in this tenant`);
  }
}

/** Space exists but is archived. Distinct from "not found" so callers can recover. */
export class ArchivedSpaceError extends Error {
  constructor(
    public readonly spaceId: string,
    public readonly slug: string,
  ) {
    super(`Space (id: ${spaceId}, slug: ${slug}) is archived`);
  }
}

// ============================================================================
// resolveSpaceRef — slug → space row + optional redirect annotation
// ============================================================================

export interface ResolvedSpaceRef {
  space: SpaceRow;
  /** Set when the input slug resolved via history; `toSlug` is the live one. */
  redirect?: { fromSlug: SpaceSlug; toSlug: SpaceSlug };
}

/**
 * Resolve a slug to the live space row. Walks `space_slug_history` on a
 * direct miss so renamed slugs still work. Returns the **current canonical
 * row** — callers reading `redirect` should 302 to the canonical URL so the
 * URL bar self-heals on first visit.
 *
 * Archived spaces are excluded by default. Pass `includeArchived: true` on
 * admin/recovery paths.
 *
 * Throws {@link UnknownSpaceSlugError} if neither the live table nor history
 * matches, or {@link ArchivedSpaceError} if the resolved space is archived
 * and `includeArchived` was not set.
 */
export async function resolveSpaceRef(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { slug: SpaceSlug; includeArchived?: boolean },
): Promise<ResolvedSpaceRef> {
  const tenantCtx = createTenantContext(tenantId);

  return withTenantSchema(db, tenantCtx, async (tx) => {
    // 1. Direct live lookup.
    const [live] = await tx.select().from(spaces).where(eq(spaces.slug, params.slug)).limit(1);

    if (live) {
      if (live.archivedAt !== null && !params.includeArchived) {
        throw new ArchivedSpaceError(live.id, live.slug);
      }
      return { space: live };
    }

    // 2. History fallback — the slug was renamed (possibly multiple times).
    //    history row carries `space_id` (stable). We then read the current
    //    canonical slug back from `spaces` so callers redirect to
    //    end-of-chain, never an intermediate hop.
    const [historyRow] = await tx
      .select({ spaceId: spaceSlugHistory.spaceId })
      .from(spaceSlugHistory)
      .where(eq(spaceSlugHistory.oldSlug, params.slug))
      .orderBy(desc(spaceSlugHistory.renamedAt))
      .limit(1);

    if (!historyRow) {
      throw new UnknownSpaceSlugError(params.slug);
    }

    const [current] = await tx
      .select()
      .from(spaces)
      .where(eq(spaces.id, historyRow.spaceId))
      .limit(1);

    if (!current) {
      // History points at a space that was hard-deleted. Surface as
      // not-found rather than archived (the row is gone, not just hidden).
      throw new UnknownSpaceSlugError(params.slug);
    }

    if (current.archivedAt !== null && !params.includeArchived) {
      throw new ArchivedSpaceError(current.id, current.slug);
    }

    return {
      space: current,
      redirect: {
        fromSlug: params.slug,
        toSlug: current.slug as SpaceSlug,
      },
    };
  });
}

// ============================================================================
// Slug history write — rename support
// ============================================================================

export interface RenameSpaceSlugParams {
  spaceId: string;
  oldSlug: SpaceSlug;
  newSlug: SpaceSlug;
  renamedBy: string | null;
}

/**
 * Record a slug change in `space_slug_history`. Called by the PATCH path
 * **after** the live `spaces.slug` has been updated.
 *
 * The `UNIQUE (old_slug)` index on `space_slug_history` blocks slug reuse
 * across spaces — if `oldSlug` is already retired (for any space, ever), the
 * insert raises a unique-violation. Surface this to the caller as a typed
 * `SpaceSlugRetiredError` so the PATCH can return `SLUG_TAKEN`.
 */
export class SpaceSlugRetiredError extends Error {
  constructor(public readonly slug: SpaceSlug) {
    super(
      `Space slug "${slug}" is retired in this tenant and cannot be reused while history exists for it`,
    );
  }
}

/**
 * Insert a history row for `oldSlug → newSlug`. Throws
 * {@link SpaceSlugRetiredError} if `newSlug` collides with a retired slug
 * in `space_slug_history`. Callers must run this **inside the same
 * transaction** as the `UPDATE spaces SET slug = newSlug` so that a unique
 * collision aborts the rename atomically.
 */
export async function recordSpaceSlugRename(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: RenameSpaceSlugParams,
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    // Reuse-block: a new slug that's already in history (for any space)
    // can't be the new live slug. The DB unique index on `old_slug` already
    // enforces this on insert, but checking up-front gives a typed error
    // rather than a raw unique-violation.
    const [retired] = await tx
      .select({ id: spaceSlugHistory.id })
      .from(spaceSlugHistory)
      .where(eq(spaceSlugHistory.oldSlug, params.newSlug))
      .limit(1);
    if (retired) {
      throw new SpaceSlugRetiredError(params.newSlug);
    }

    await tx.insert(spaceSlugHistory).values({
      spaceId: params.spaceId,
      oldSlug: params.oldSlug,
      newSlug: params.newSlug,
      renamedBy: params.renamedBy,
    });
  });
}

// ============================================================================
// "where-is" — which spaces (accessible to this user) contain a resource?
// ============================================================================

export interface SpaceWhereIsHit {
  spaceId: string;
  spaceSlug: SpaceSlug;
  spaceName: string;
}

export async function findSpacesWithAgentSlug(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { agentSlug: string; accessibleSpaceIds: readonly string[] },
): Promise<SpaceWhereIsHit[]> {
  if (params.accessibleSpaceIds.length === 0) return [];
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const { agents } = await import('../schema/tenant.js');
    const { inArray } = await import('drizzle-orm');
    const rows = await tx
      .select({
        spaceId: agents.spaceId,
        spaceSlug: spaces.slug,
        spaceName: spaces.name,
      })
      .from(agents)
      .innerJoin(spaces, eq(spaces.id, agents.spaceId))
      .where(
        and(
          eq(agents.slug, params.agentSlug),
          isNull(agents.archivedAt),
          inArray(agents.spaceId, params.accessibleSpaceIds as string[]),
          isNull(spaces.archivedAt),
        ),
      );
    return rows.map((r) => ({
      spaceId: r.spaceId,
      spaceSlug: r.spaceSlug as SpaceSlug,
      spaceName: r.spaceName,
    }));
  });
}
