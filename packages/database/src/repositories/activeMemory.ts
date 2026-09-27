/**
 * Active-memory register repository (Plan 251).
 *
 * The register lives as a jsonb column on the tenant `spaces` row — it has no
 * memory-doc path, so generic memory mutations cannot address it by
 * construction. All writes go through `mutateActiveMemoryRegister`, which owns
 * the optimistic-concurrency (revision-CAS) retry loop.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import type { ActiveMemoryEntry, ActiveMemoryRegister } from '@aflow/schemas';
import {
  ACTIVE_MEMORY_REGISTER_VERSION,
  ActiveMemoryEntryValidator,
  emptyActiveMemoryRegister,
} from '@aflow/schemas';
import type { TenantContext } from '../tenant.js';
import { withTenantSchema } from '../tenant.js';
import { spaces } from '../schema/tenant.js';
import { spaceMemberships } from '../schema/public.js';

export interface ActiveMemorySpaceState {
  register: ActiveMemoryRegister;
  /**
   * True only for a space with NO members other than its owner — the
   * single-principal condition injection/promotion gate on.
   */
  singleOwner: boolean;
  /**
   * False only when the stored shell is unusable (wrong version / not a
   * register shape). Individually invalid entries are salvaged away instead,
   * so one bad entry never invalidates the register.
   */
  registerValid: boolean;
}

const RegisterShellSchema = z.object({
  version: z.number(),
  revision: z.number().int().nonnegative(),
  entries: z.array(z.unknown()),
});

export async function loadActiveMemorySpaceState(
  db: PostgresJsDatabase,
  tenantCtx: TenantContext,
  spaceId: string,
): Promise<ActiveMemorySpaceState | null> {
  const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({ ownerId: spaces.ownerId, activeMemory: spaces.activeMemory })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .limit(1),
  );
  const row = rows[0];
  if (!row) return null;

  // Single-owner = no membership rows for anyone but the owner.
  // `space_memberships` lives in the public schema (cross-schema), so it is
  // queried directly, not through the tenant-schema wrapper. Fail closed when
  // ownership is unknown.
  let singleOwner = false;
  if (row.ownerId) {
    const others = await db
      .select({ userId: spaceMemberships.userId })
      .from(spaceMemberships)
      .where(
        and(
          eq(spaceMemberships.tenantId, tenantCtx.tenantId),
          eq(spaceMemberships.spaceId, spaceId),
          ne(spaceMemberships.userId, row.ownerId),
        ),
      )
      .limit(1);
    singleOwner = others.length === 0;
  }

  if (row.activeMemory === null) {
    return { singleOwner, register: emptyActiveMemoryRegister(), registerValid: true };
  }
  const shell = RegisterShellSchema.safeParse(row.activeMemory);
  if (!shell.success || shell.data.version !== ACTIVE_MEMORY_REGISTER_VERSION) {
    return { singleOwner, register: emptyActiveMemoryRegister(), registerValid: false };
  }
  // Salvage individually valid entries; the stored revision is preserved so the
  // revision-CAS below stays honest against the raw column value.
  const entries: ActiveMemoryEntry[] = [];
  for (const raw of shell.data.entries) {
    const parsed = ActiveMemoryEntryValidator.safeParse(raw);
    if (parsed.success) entries.push(parsed.data);
  }
  return {
    singleOwner,
    register: {
      version: ACTIVE_MEMORY_REGISTER_VERSION,
      revision: shell.data.revision,
      entries,
    },
    registerValid: true,
  };
}

async function saveActiveMemoryRegister(
  db: PostgresJsDatabase,
  tenantCtx: TenantContext,
  spaceId: string,
  register: ActiveMemoryRegister,
  expectedRevision: number,
): Promise<boolean> {
  const result = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .update(spaces)
      .set({ activeMemory: register, updatedAt: new Date() })
      .where(
        sql`${spaces.id} = ${spaceId} AND COALESCE((${spaces.activeMemory}->>'revision')::int, 0) = ${expectedRevision}`,
      )
      .returning({ id: spaces.id }),
  );
  return result.length > 0;
}

export type ActiveMemoryAdmit = (
  state: ActiveMemorySpaceState,
) =>
  | { ok: false; error: string }
  | { ok: true; register: ActiveMemoryRegister; entry?: ActiveMemoryEntry; noop: boolean };

export type ActiveMemoryMutateOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'register_invalid' }
  | { outcome: 'rejected'; error: string }
  | { outcome: 'noop'; state: ActiveMemorySpaceState; entry?: ActiveMemoryEntry }
  | { outcome: 'saved'; register: ActiveMemoryRegister; entry?: ActiveMemoryEntry }
  | { outcome: 'conflict' };

const CAS_ATTEMPTS = 2;

/**
 * Load → admit → revision-CAS save, with one retry on a concurrent change.
 * A stored register whose shell is unusable fails closed as `register_invalid`
 * rather than being silently replaced through a phantom-empty CAS.
 */
export async function mutateActiveMemoryRegister(
  db: PostgresJsDatabase,
  tenantCtx: TenantContext,
  spaceId: string,
  admit: ActiveMemoryAdmit,
): Promise<ActiveMemoryMutateOutcome> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const state = await loadActiveMemorySpaceState(db, tenantCtx, spaceId);
    if (!state) return { outcome: 'not_found' };
    if (!state.registerValid) return { outcome: 'register_invalid' };

    const mutation = admit(state);
    if (!mutation.ok) return { outcome: 'rejected', error: mutation.error };
    if (mutation.noop) {
      return {
        outcome: 'noop',
        state,
        ...(mutation.entry !== undefined ? { entry: mutation.entry } : {}),
      };
    }

    const saved = await saveActiveMemoryRegister(
      db,
      tenantCtx,
      spaceId,
      mutation.register,
      state.register.revision,
    );
    if (saved) {
      return {
        outcome: 'saved',
        register: mutation.register,
        ...(mutation.entry !== undefined ? { entry: mutation.entry } : {}),
      };
    }
  }
  return { outcome: 'conflict' };
}
