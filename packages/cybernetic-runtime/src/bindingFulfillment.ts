/**
 * The one place a binding's fulfillment is checked before it is written.
 *
 * Both write paths reach it — the `api.binding.upsert` operation and the REST
 * route the operator UI posts to — because a binding that names a simulation
 * the space does not hold, or one whose endpoints the simulation cannot
 * answer, is the same defect whichever surface created it. The check has to
 * live above both: the invariant it enforces is what makes `fulfillment` a
 * declaration rather than a hint.
 */
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { simulations, withTenantSchema } from '@aflow/database';
import type { TenantContext } from '@aflow/database';
import {
  type ApiEndpoint,
  type BindingFulfillment,
  type Simulation,
  validateSimulatedBinding,
} from '@aflow/schemas';

/**
 * The simulation a binding claims, as the invariant check needs it. Absent
 * rather than thrown: `validateSimulatedBinding` names the missing simulation
 * alongside every other violation, so the operator sees one complete answer
 * instead of the first failure.
 */
export async function readSimulationForBinding(
  db: PostgresJsDatabase,
  tenantCtx: TenantContext,
  spaceId: string,
  simulationId: string,
): Promise<Pick<Simulation, 'simulationId' | 'targets'> | undefined> {
  const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({ targetApiId: simulations.targetApiId })
      .from(simulations)
      .where(and(eq(simulations.simulationId, simulationId), eq(simulations.spaceId, spaceId)))
      .limit(1),
  );
  const row = rows[0];
  if (!row) return undefined;
  return { simulationId, targets: { sourceKind: 'api', integrationId: row.targetApiId } };
}

export class SimulatedBindingRejected extends Error {
  readonly bindingId: string;
  readonly simulationId: string;
  readonly violations: readonly string[];

  constructor(bindingId: string, simulationId: string, violations: readonly string[]) {
    super(
      `Binding "${bindingId}" cannot be fulfilled by simulation "${simulationId}": ${violations.join(' ')}`,
    );
    this.name = 'SimulatedBindingRejected';
    this.bindingId = bindingId;
    this.simulationId = simulationId;
    this.violations = violations;
  }
}

export interface FulfillmentDefinitionView {
  apiId: string;
  callMode: 'endpoint' | 'direct_url';
  endpoints: ApiEndpoint[];
}

/**
 * Throws `SimulatedBindingRejected` if the declaration cannot hold. A `live`
 * fulfillment is checked by doing nothing — there is no simulation to reconcile
 * it against, and a live binding must never be reasoned about as a degraded
 * simulated one.
 */
export async function assertBindingFulfillmentWritable(params: {
  db: PostgresJsDatabase;
  tenantCtx: TenantContext;
  spaceId: string;
  bindingId: string;
  apiId: string;
  fulfillment: BindingFulfillment;
  definition?: FulfillmentDefinitionView | undefined;
}): Promise<void> {
  if (params.fulfillment.mode !== 'simulated') return;

  const simulation = await readSimulationForBinding(
    params.db,
    params.tenantCtx,
    params.spaceId,
    params.fulfillment.simulationId,
  );
  const violations = validateSimulatedBinding({
    binding: {
      bindingId: params.bindingId,
      apiId: params.apiId,
      fulfillment: params.fulfillment,
    },
    definition: params.definition,
    simulation,
  });
  if (violations.length > 0) {
    throw new SimulatedBindingRejected(
      params.bindingId,
      params.fulfillment.simulationId,
      violations.map((violation) => violation.message),
    );
  }
}
