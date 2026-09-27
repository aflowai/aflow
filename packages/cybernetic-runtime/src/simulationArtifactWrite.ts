/**
 * Writing a simulation artifact, for every surface that authors one.
 *
 * The operation an agent calls and the REST route the editor posts to must
 * enforce the same invariants, because they are what make a stored simulation
 * safe to pin: the target must be an endpoint-mode definition that exists (a
 * simulation answers a contract, so there has to be one), the revision is
 * assigned by the store rather than the caller, and it is bumped under a lock —
 * two concurrent upserts that both read N would both store N+1, and a run
 * pinned to N+1 could then be reading either artifact.
 *
 * The empty baseline is minted in the SAME transaction, because an empty world
 * is a real baseline version rather than the absence of one: a run pinning a
 * never-seeded simulation must pin a version that can never later acquire rows.
 * Minting it afterwards can fail once the artifact has already committed, and
 * the caller is then handed an error it cannot retry — the revision moved, so
 * its `expectedRevision` is refused on the second attempt.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  apiDefinitions,
  ensureSimulationBaselineIn,
  simulations,
  withTenantSchema,
} from '@aflow/database';
import type { TenantContext } from '@aflow/database';
import { simulationReadiness } from '@aflow/integration-simulator';
import {
  ApiDefinitionSchema,
  type Simulation,
  type SimulationReadinessReport,
  type TenantId,
} from '@aflow/schemas';

/** A refusal the author can act on, as opposed to one the platform owns. */
export class SimulationArtifactRejected extends Error {
  readonly code:
    | 'SIMULATION_TARGET_NOT_FOUND'
    | 'SIMULATION_TARGET_INVALID'
    | 'SIMULATION_TARGET_NOT_ENDPOINT_MODE'
    | 'SIMULATION_REVISION_CONFLICT';

  constructor(code: SimulationArtifactRejected['code'], message: string) {
    super(message);
    this.name = 'SimulationArtifactRejected';
    this.code = code;
  }
}

export interface SimulationWriteResult {
  simulationId: string;
  revision: number;
  created: boolean;
  readiness: SimulationReadinessReport;
}

export async function writeSimulationArtifact(params: {
  db: PostgresJsDatabase;
  tenantCtx: TenantContext;
  tenantId: TenantId;
  spaceId: string;
  /** The artifact as authored. `revision`, `createdAt` and `updatedAt` are ignored. */
  simulation: Simulation;
  /**
   * The revision the author read before merging. Compared under the same lock
   * that assigns the next one.
   *
   * This write REPLACES the whole artifact, so two authors who each read N and
   * merged their own change both store N+1 and the second silently discards
   * the first — and with an agent and an operator both editing, "two authors"
   * is the normal case rather than the contended one. Omitted means the caller
   * is not claiming to have read anything, which is correct for a create and
   * accepted for a deliberate overwrite.
   */
  expectedRevision: number;
}): Promise<SimulationWriteResult> {
  const { db, tenantCtx, spaceId } = params;
  const incoming = params.simulation;
  const targetApiId = incoming.targets.integrationId;

  const definitionRows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({ definitionJson: apiDefinitions.definitionJson })
      .from(apiDefinitions)
      .where(and(eq(apiDefinitions.apiId, targetApiId), eq(apiDefinitions.spaceId, spaceId)))
      .limit(1),
  );
  const definitionRow = definitionRows[0];
  if (!definitionRow) {
    throw new SimulationArtifactRejected(
      'SIMULATION_TARGET_NOT_FOUND',
      `Simulation "${incoming.simulationId}" targets API "${targetApiId}", which does not exist in this space. Create the definition first — a simulation answers a contract, so there has to be one.`,
    );
  }
  const definition = ApiDefinitionSchema.safeParse(definitionRow.definitionJson);
  if (!definition.success) {
    throw new SimulationArtifactRejected(
      'SIMULATION_TARGET_INVALID',
      `API definition "${targetApiId}" does not validate, so its contract cannot be simulated: ${definition.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  if (definition.data.callMode === 'direct_url') {
    throw new SimulationArtifactRejected(
      'SIMULATION_TARGET_NOT_ENDPOINT_MODE',
      `API "${targetApiId}" is a direct_url definition, which declares no endpoints and therefore no contract to simulate. Only an endpoint-mode definition can be simulated.`,
    );
  }

  const nowIso = new Date().toISOString();
  const outcome = await withTenantSchema(db, tenantCtx, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${spaceId}:simulation:${incoming.simulationId}`}, 0))`,
    );
    const priorRows = await tx
      .select({ revision: simulations.revision, createdAt: simulations.createdAt })
      .from(simulations)
      .where(
        and(eq(simulations.simulationId, incoming.simulationId), eq(simulations.spaceId, spaceId)),
      )
      .limit(1);
    const prior = priorRows[0];
    if ((prior?.revision ?? 0) !== params.expectedRevision) {
      throw new SimulationArtifactRejected(
        'SIMULATION_REVISION_CONFLICT',
        `Simulation "${incoming.simulationId}" is at revision ${String(prior?.revision ?? 0)}, not ${String(params.expectedRevision)} — it was written after you read it. Re-read it with integration.simulation.get, merge your change onto what is there now, and write again; this operation replaces the whole artifact, so storing yours would drop whatever the other write added.`,
      );
    }
    const revision = (prior?.revision ?? 0) + 1;
    const stored: Simulation = {
      ...incoming,
      revision,
      createdAt: prior?.createdAt.toISOString() ?? nowIso,
      updatedAt: nowIso,
    };

    await tx.execute(sql`
      INSERT INTO simulations (simulation_id, space_id, name, description, revision, target_api_id, definition_json, enabled)
      VALUES (
        ${stored.simulationId},
        ${spaceId}::uuid,
        ${stored.name},
        ${stored.description ?? null},
        ${revision},
        ${targetApiId},
        ${JSON.stringify(stored)}::jsonb,
        1
      )
      ON CONFLICT (simulation_id, space_id) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description,
        revision = EXCLUDED.revision, target_api_id = EXCLUDED.target_api_id,
        definition_json = EXCLUDED.definition_json, updated_at = NOW()
    `);

    await ensureSimulationBaselineIn(tx, {
      spaceId,
      simulationId: incoming.simulationId,
    });

    return { revision, created: prior === undefined, stored };
  });

  return {
    simulationId: incoming.simulationId,
    revision: outcome.revision,
    created: outcome.created,
    readiness: simulationReadiness({ endpoints: definition.data.endpoints }, outcome.stored),
  };
}
