/**
 * The seed-world versions a run pins against.
 *
 * A simulation with no authored world still has to give a run something to pin,
 * and the version it pins must be one that can never acquire rows: baseline
 * versions are immutable, so an empty world is a real version like any other.
 * Answering "no baseline" with a synthetic version number would name the same
 * version the first seed mints, and the pinned world would gain entities the
 * moment someone seeded it.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { TenantId } from '@aflow/schemas';
import { createTenantContext } from '../tenant/context.js';
import { withTenantSchema } from '../tenant/queries.js';
import { simulationBaselines } from '../schema/tenant/simulations.js';

/** The version a simulation's first baseline is minted as. */
const FIRST_BASELINE_VERSION = 1;

export interface SimulationBaselineHead {
  version: number;
  createdAt: Date;
}

export interface SimulationBaselineKey {
  db: PostgresJsDatabase;
  tenantId: TenantId;
  spaceId: string;
  simulationId: string;
}

/**
 * The simulation's latest baseline version, minting an empty one when it has
 * none.
 *
 * The insert loses to a concurrent seed rather than overwriting it, so the
 * caller is handed whatever the simulation's first version turned out to hold.
 */
export async function ensureSimulationBaseline(
  key: SimulationBaselineKey,
): Promise<SimulationBaselineHead> {
  const tenantContext = createTenantContext(key.tenantId);
  return withTenantSchema(key.db, tenantContext, async (tx) =>
    ensureSimulationBaselineIn(tx, { spaceId: key.spaceId, simulationId: key.simulationId }),
  );
}

/**
 * The same mint, against a transaction the caller already holds.
 *
 * Exists so a writer that creates the simulation can create its baseline in the
 * SAME transaction: minting afterwards can throw once the artifact has already
 * committed, and the caller then sees a failure it cannot retry — the revision
 * moved, so `expectedRevision` refuses the second attempt.
 */
export async function ensureSimulationBaselineIn(
  tx: PostgresJsDatabase,
  key: { spaceId: string; simulationId: string },
): Promise<SimulationBaselineHead> {
  const inserted = await tx
    .insert(simulationBaselines)
    .values({
      spaceId: key.spaceId,
      simulationId: key.simulationId,
      version: FIRST_BASELINE_VERSION,
      entityCounts: {},
    })
    .onConflictDoNothing()
    .returning({
      version: simulationBaselines.version,
      createdAt: simulationBaselines.createdAt,
    });
  const minted = inserted[0];
  if (minted !== undefined) return minted;

  const existing = await tx
    .select({
      version: simulationBaselines.version,
      createdAt: simulationBaselines.createdAt,
    })
    .from(simulationBaselines)
    .where(
      and(
        eq(simulationBaselines.spaceId, key.spaceId),
        eq(simulationBaselines.simulationId, key.simulationId),
      ),
    )
    .orderBy(desc(simulationBaselines.version))
    .limit(1);
  const head = existing[0];
  if (head === undefined) {
    throw new Error(
      `Simulation "${key.simulationId}" has no baseline version and would not accept an empty one.`,
    );
  }
  return head;
}
