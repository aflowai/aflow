/**
 * Reads and errors the simulation control-plane operations share.
 */
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ZodError } from 'zod';
import {
  SimulationSchema,
  type ApiEndpoint,
  type ErrorClassification,
  type Simulation,
  type TenantId,
} from '@aflow/schemas';
import { apiDefinitions, simulations, withTenantSchema } from '@aflow/database';
import type { TenantContext } from '@aflow/database';

export interface SimulationScope {
  db: PostgresJsDatabase;
  tenantCtx: TenantContext;
  tenantId: TenantId;
  spaceId: string;
}

/** A failure the caller can act on, as opposed to one the platform owns. */
export class SimulationOpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly classification: ErrorClassification,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SimulationOpError';
  }

  static invalidInput(error: ZodError): SimulationOpError {
    return new SimulationOpError(
      'SIMULATION_INVALID_INPUT',
      `Invalid input: ${error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
      'validation',
    );
  }
}

/** The stored artifact, parsed, with the API it targets. */
export async function readSimulationRow(
  scope: SimulationScope,
  simulationId: string,
): Promise<{ simulation: Simulation; targetApiId: string }> {
  const rows = await withTenantSchema(scope.db, scope.tenantCtx, async (tx) =>
    tx
      .select({
        definitionJson: simulations.definitionJson,
        targetApiId: simulations.targetApiId,
        revision: simulations.revision,
      })
      .from(simulations)
      .where(
        and(eq(simulations.spaceId, scope.spaceId), eq(simulations.simulationId, simulationId)),
      )
      .limit(1),
  );
  const row = rows[0];
  if (!row) {
    throw new SimulationOpError(
      'SIMULATION_NOT_FOUND',
      `Simulation "${simulationId}" does not exist in this space.`,
      'not_found',
    );
  }
  const parsed = SimulationSchema.safeParse(row.definitionJson);
  if (!parsed.success) {
    throw new SimulationOpError(
      'SIMULATION_INVALID',
      `Simulation "${simulationId}" is stored but no longer validates, so it can answer nothing: ${parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
      'validation',
    );
  }
  return { simulation: parsed.data, targetApiId: row.targetApiId };
}

/** The endpoints readiness is computed against. Empty when the definition is gone. */
export async function targetEndpoints(
  scope: SimulationScope,
  apiId: string,
): Promise<ApiEndpoint[]> {
  const rows = await withTenantSchema(scope.db, scope.tenantCtx, async (tx) =>
    tx
      .select({ definitionJson: apiDefinitions.definitionJson })
      .from(apiDefinitions)
      .where(and(eq(apiDefinitions.apiId, apiId), eq(apiDefinitions.spaceId, scope.spaceId)))
      .limit(1),
  );
  const definitionJson = rows[0]?.definitionJson as Record<string, unknown> | undefined;
  return (definitionJson?.['endpoints'] as ApiEndpoint[] | undefined) ?? [];
}
