/**
 * The control plane for simulations: authoring the artifact, reading its
 * standing readiness, and removing it.
 *
 * Readiness is recomputed on every read from the artifact and the definition it
 * targets, never stamped on the row — an endpoint that loses its response
 * schema surfaces on the next read with no stale flag to clean up.
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  SimulationDeleteInputSchema,
  SimulationGetInputSchema,
  SimulationListInputSchema,
  SimulationSchema,
  SimulationUpsertInputSchema,
  type ApiEndpoint,
  type OperationId,
  type SimulationBaseline,
  type SimulationDeleteOutput,
  type SimulationGetOutput,
  type SimulationListOutput,
  type SimulationSummary,
  type SimulationUpsertOutput,
} from '@aflow/schemas';
import { simulationReadiness } from '@aflow/integration-simulator';
import { SimulationArtifactRejected, writeSimulationArtifact } from '@aflow/cybernetic-runtime';
import { publishApiCatalogInvalidation } from '@aflow/redis';
import {
  apiBindings,
  apiDefinitions,
  createTenantContext,
  getDatabase,
  simulationBaselines,
  simulationCallRecords,
  simulationEntities,
  simulationRunContexts,
  simulations,
  withTenantSchema,
} from '@aflow/database';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';
import type { InlineHandlerArgs } from './types.js';
import { emitStepError, emitStepSuccess, readInlineOpInputRecord } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { handleSimulationWorldOp } from './simulationWorld.js';
import {
  SimulationOpError,
  readSimulationRow,
  targetEndpoints,
  type SimulationScope,
} from './simulationStore.js';

/** A simulation summary needs the endpoints of the definition it targets. */
async function endpointsByApiId(
  scope: SimulationScope,
  apiIds: readonly string[],
): Promise<Map<string, ApiEndpoint[]>> {
  if (apiIds.length === 0) return new Map();
  const rows = await withTenantSchema(scope.db, scope.tenantCtx, async (tx) =>
    tx
      .select({ apiId: apiDefinitions.apiId, definitionJson: apiDefinitions.definitionJson })
      .from(apiDefinitions)
      .where(
        and(
          eq(apiDefinitions.spaceId, scope.spaceId),
          inArray(apiDefinitions.apiId, [...new Set(apiIds)]),
        ),
      ),
  );
  return new Map(
    rows.map((row) => [
      row.apiId,
      ((row.definitionJson as Record<string, unknown> | null)?.['endpoints'] as
        ApiEndpoint[] | undefined) ?? [],
    ]),
  );
}

async function baselineVersionsBySimulation(
  scope: SimulationScope,
  simulationIds: readonly string[],
): Promise<Map<string, number[]>> {
  if (simulationIds.length === 0) return new Map();
  const rows = await withTenantSchema(scope.db, scope.tenantCtx, async (tx) =>
    tx
      .select({
        simulationId: simulationBaselines.simulationId,
        version: simulationBaselines.version,
      })
      .from(simulationBaselines)
      .where(
        and(
          eq(simulationBaselines.spaceId, scope.spaceId),
          inArray(simulationBaselines.simulationId, [...simulationIds]),
        ),
      ),
  );
  const byId = new Map<string, number[]>();
  for (const row of rows) {
    const versions = byId.get(row.simulationId) ?? [];
    versions.push(row.version);
    byId.set(row.simulationId, versions);
  }
  for (const versions of byId.values()) versions.sort((a, b) => a - b);
  return byId;
}

async function listSimulations(
  scope: SimulationScope,
  input: unknown,
): Promise<SimulationListOutput> {
  const parsed = SimulationListInputSchema.safeParse(input ?? {});
  if (!parsed.success) throw SimulationOpError.invalidInput(parsed.error);
  const { integrationId } = parsed.data;

  const rows = await withTenantSchema(scope.db, scope.tenantCtx, async (tx) =>
    tx
      .select({
        simulationId: simulations.simulationId,
        revision: simulations.revision,
        name: simulations.name,
        description: simulations.description,
        targetApiId: simulations.targetApiId,
        definitionJson: simulations.definitionJson,
      })
      .from(simulations)
      .where(
        and(
          eq(simulations.spaceId, scope.spaceId),
          ...(integrationId === undefined ? [] : [eq(simulations.targetApiId, integrationId)]),
        ),
      ),
  );

  const [endpoints, baselines] = await Promise.all([
    endpointsByApiId(
      scope,
      rows.map((row) => row.targetApiId),
    ),
    baselineVersionsBySimulation(
      scope,
      rows.map((row) => row.simulationId),
    ),
  ]);

  const items: SimulationSummary[] = rows
    .map((row) => {
      const declared = endpoints.get(row.targetApiId) ?? [];
      const parsedArtifact = SimulationSchema.safeParse(row.definitionJson);
      // An artifact that no longer validates can answer nothing, and saying so
      // through the roll-up is truer than omitting the row: the operator sees
      // the simulation exists and that none of its endpoints are usable.
      const readiness = parsedArtifact.success
        ? simulationReadiness({ endpoints: declared }, parsedArtifact.data)
        : {
            simulationId: row.simulationId,
            revision: row.revision,
            worldReadyCount: 0,
            contractReadyCount: 0,
            notReadyCount: declared.length,
          };
      return {
        simulationId: row.simulationId,
        revision: row.revision,
        name: row.name,
        ...(row.description === null ? {} : { description: row.description }),
        targets: { sourceKind: 'api' as const, integrationId: row.targetApiId },
        readiness: {
          simulationId: readiness.simulationId,
          revision: readiness.revision,
          worldReadyCount: readiness.worldReadyCount,
          contractReadyCount: readiness.contractReadyCount,
          notReadyCount: readiness.notReadyCount,
        },
        baselineVersions: baselines.get(row.simulationId) ?? [],
      };
    })
    .sort((a, b) => a.simulationId.localeCompare(b.simulationId));

  return { items, total: items.length };
}

async function getSimulation(scope: SimulationScope, input: unknown): Promise<SimulationGetOutput> {
  const parsed = SimulationGetInputSchema.safeParse(input ?? {});
  if (!parsed.success) throw SimulationOpError.invalidInput(parsed.error);
  const { simulationId } = parsed.data;

  const { simulation, targetApiId } = await readSimulationRow(scope, simulationId);
  const endpoints = await targetEndpoints(scope, targetApiId);

  const baselineRows = await withTenantSchema(scope.db, scope.tenantCtx, async (tx) =>
    tx
      .select({
        version: simulationBaselines.version,
        description: simulationBaselines.description,
        entityCounts: simulationBaselines.entityCounts,
        createdAt: simulationBaselines.createdAt,
      })
      .from(simulationBaselines)
      .where(
        and(
          eq(simulationBaselines.spaceId, scope.spaceId),
          eq(simulationBaselines.simulationId, simulationId),
        ),
      ),
  );

  const baselines: SimulationBaseline[] = baselineRows
    .map((row) => ({
      simulationId,
      version: row.version,
      ...(row.description === null ? {} : { description: row.description }),
      entityCounts: row.entityCounts,
      createdAt: row.createdAt.toISOString(),
    }))
    .sort((a, b) => a.version - b.version);

  return {
    simulation,
    readiness: simulationReadiness({ endpoints }, simulation),
    baselines,
  };
}

/**
 * Create or replace the artifact.
 *
 * `revision` is assigned here and never taken from the caller: a run pins the
 * revision it started on, so a caller that could choose one could move the
 * world under a running agent by re-sending the number it already pinned.
 */
async function upsertSimulation(
  scope: SimulationScope,
  input: unknown,
): Promise<SimulationUpsertOutput> {
  const parsed = SimulationUpsertInputSchema.safeParse(input ?? {});
  if (!parsed.success) throw SimulationOpError.invalidInput(parsed.error);

  try {
    return await writeSimulationArtifact({
      db: scope.db,
      tenantCtx: scope.tenantCtx,
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      simulation: parsed.data.simulation,
      expectedRevision: parsed.data.expectedRevision,
    });
  } catch (error) {
    if (error instanceof SimulationArtifactRejected) {
      throw new SimulationOpError(
        error.code,
        error.message,
        error.code === 'SIMULATION_TARGET_NOT_FOUND'
          ? 'not_found'
          : error.code === 'SIMULATION_REVISION_CONFLICT'
            ? 'conflict'
            : 'validation',
      );
    }
    throw error;
  }
}

async function deleteSimulation(
  args: InlineHandlerArgs,
  scope: SimulationScope,
  input: unknown,
): Promise<SimulationDeleteOutput> {
  const parsed = SimulationDeleteInputSchema.safeParse(input ?? {});
  if (!parsed.success) throw SimulationOpError.invalidInput(parsed.error);
  const { simulationId } = parsed.data;

  const orphanRows = await withTenantSchema(scope.db, scope.tenantCtx, async (tx) =>
    tx
      .select({ bindingId: apiBindings.bindingId })
      .from(apiBindings)
      .where(
        and(eq(apiBindings.spaceId, scope.spaceId), eq(apiBindings.simulationId, simulationId)),
      ),
  );

  const removal = await withTenantSchema(scope.db, scope.tenantCtx, async (tx) => {
    // The payload objects these rows name are NOT deleted, and that is
    // deliberate. They are content-addressed, so an identical delta written by
    // another simulation is the same object — and no check inside this
    // transaction can see a concurrent writer that has stored the bytes but
    // not yet committed the row referencing them. Deleting on a survivor query
    // therefore breaks somebody else's journal at exactly the moment two
    // simulations agree, which is the moment content addressing is working.
    //
    // Orphaned objects are the cheaper wrong answer than a dangling reference,
    // and reclaiming them is a candidate-driven GC job (Plan 180), not
    // something a delete handler can do correctly inline.

    // Baselines, entities, journals and pins go with the artifact: they describe
    // a contract that no longer exists, and an inspector folding them would
    // reconstruct a world against collections nothing declares.
    await tx
      .delete(simulationEntities)
      .where(
        and(
          eq(simulationEntities.spaceId, scope.spaceId),
          eq(simulationEntities.simulationId, simulationId),
        ),
      );
    await tx
      .delete(simulationBaselines)
      .where(
        and(
          eq(simulationBaselines.spaceId, scope.spaceId),
          eq(simulationBaselines.simulationId, simulationId),
        ),
      );
    await tx
      .delete(simulationCallRecords)
      .where(
        and(
          eq(simulationCallRecords.spaceId, scope.spaceId),
          eq(simulationCallRecords.simulationId, simulationId),
        ),
      );
    await tx
      .delete(simulationRunContexts)
      .where(
        and(
          eq(simulationRunContexts.spaceId, scope.spaceId),
          eq(simulationRunContexts.simulationId, simulationId),
        ),
      );
    const removed = await tx
      .delete(simulations)
      .where(
        and(eq(simulations.spaceId, scope.spaceId), eq(simulations.simulationId, simulationId)),
      )
      .returning({ simulationId: simulations.simulationId });

    return { deleted: removed.length > 0 };
  });

  return {
    simulationId,
    deleted: removal.deleted,
    orphanedBindingIds: orphanRows.map((row) => row.bindingId).sort(),
  };
}

export async function handleSimulationOpInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const operationId = args.stepDef.operation as OperationId;
  const logger = getOrchestratorLogger();

  try {
    const scope: SimulationScope = {
      db: getDatabase(),
      tenantCtx: createTenantContext(args.context.tenantId),
      tenantId: args.context.tenantId,
      spaceId: requireSpaceId(args.context),
    };
    const input = (await readInlineOpInputRecord(args)) ?? {};

    let output: Record<string, unknown>;
    let mutated = false;
    switch (operationId) {
      case 'integration.simulation.list':
        output = await listSimulations(scope, input);
        break;
      case 'integration.simulation.get':
        output = await getSimulation(scope, input);
        break;
      case 'integration.simulation.upsert':
        output = await upsertSimulation(scope, input);
        mutated = true;
        break;
      case 'integration.simulation.delete':
        output = await deleteSimulation(args, scope, input);
        mutated = true;
        break;
      default: {
        const world = await handleSimulationWorldOp(args, scope, operationId, input);
        output = world.output;
        mutated = world.mutated;
        break;
      }
    }

    if (mutated) {
      // The api executor caches the artifact per space; without the signal a
      // freshly authored rule waits out the cache before it answers anything.
      publishApiCatalogInvalidation(args.redis, args.context.tenantId, scope.spaceId, {
        kind: 'simulation',
      });
    }
    await emitStepSuccess(args, output, startTime);
  } catch (err) {
    if (err instanceof SimulationOpError) {
      await emitStepError(
        args,
        err.code,
        err.message,
        startTime,
        err.classification,
        false,
        err.details,
      );
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[${operationId}] failed: ${message}`);
    await emitStepError(args, 'SIMULATION_OP_FAILED', `${operationId} failed`, startTime);
  }
}
