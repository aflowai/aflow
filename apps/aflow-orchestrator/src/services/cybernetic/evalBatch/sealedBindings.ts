/**
 * Provisioning a sealed trial's simulated bindings (Plan 293 §5.8b).
 *
 * Plan 269 designed three fixture tiers and shipped the third inert: `sealed`
 * was to "additionally remap API bindings" to something that answers without a
 * service, and the thing that answers is a Plan 293 simulation. This is the
 * remap.
 *
 * Everything a sealed trial's integration needs is COPIED into the fixture
 * space rather than referenced across from the home one. Integrations are
 * space-scoped, and a fixture space reading a home-space row would depend on
 * something an operator can change while the batch is still running — the same
 * reason a trial pins a workflow revision instead of resolving `latest`.
 *
 * The copies go through the ordinary writers (`writeSimulationArtifact`,
 * `seedSimulationBaseline`) rather than raw inserts, so a fixture copy is held
 * to every invariant the original was: the target definition has to exist and
 * be endpoint-mode, and the carried world has to satisfy the collection
 * declarations as they stand.
 */
import { apiSurfaceFor } from '@aflow/cybernetic-runtime';
import { stableHash } from '@aflow/schemas';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  apiBindings,
  apiDefinitions,
  createTenantContext,
  simulationBaselines,
  simulationEntities,
  simulations,
  withTenantSchema,
} from '@aflow/database';
import {
  SimulationSchema,
  type FixtureBinding,
  type SimulationRunInput,
  type TenantId,
} from '@aflow/schemas';
import { seedSimulationBaseline, writeSimulationArtifact } from '@aflow/cybernetic-runtime';

/** The host a simulated request is addressed to, which resolves nowhere. */
const SIMULATED_HOST = 'simulated.invalid';

/** A refusal the batch grades as a case-level fault, never an infra retry. */
export class SealedProvisioningError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SealedProvisioningError';
  }
}

export interface ProvisionSealedBindingsParams {
  db: PostgresJsDatabase;
  tenantId: TenantId;
  /** Space holding the authored definitions, simulations and baselines. */
  homeSpaceId: string;
  /** The trial's own space, which receives the copies. */
  fixtureSpaceId: string;
  bindings: readonly FixtureBinding[];
  /**
   * Seeds every simulation the trial pins. Derived from the case revision by
   * the caller, NEVER from the run: trials measure variance in the agent, and a
   * per-run seed would vary the world underneath them too.
   */
  seed: string;
  /**
   * The source world this case was pinned to at launch, keyed by simulationId.
   * Every trial provisions from the SAME selection: resolving the head per
   * trial would let an operator freezing a baseline mid-batch hand later trials
   * a different world under an identical case revision and seed.
   */
  sources: Record<
    string,
    { simulationRevision: number; baselineVersion: number; definitionHash?: string | undefined }
  >;
  /**
   * The instant the case is set at, from its fixture. Absent means the trial
   * reads the world at wall-clock time, which is only safe for a world holding
   * no relative dates.
   */
  clockAnchorMs?: number | undefined;
}

/**
 * Copies each stubbed integration into the fixture space and returns the pins
 * the trial's run must start with.
 */
export async function provisionSealedBindings(
  params: ProvisionSealedBindingsParams,
): Promise<SimulationRunInput> {
  const { db, tenantId, homeSpaceId, fixtureSpaceId, bindings, seed, sources, clockAnchorMs } =
    params;
  const tenantCtx = createTenantContext(tenantId);

  const personaIds: Record<string, string | null> = {};
  const baselineVersions: Record<string, number> = {};

  for (const binding of bindings) {
    // Unreachable in practice: the launch gate refuses a sealed case carrying a
    // `live_readonly` binding, because a fixture space cannot reach a live
    // integration. Kept so this loop cannot silently provision one as a stub if
    // that gate ever moves.
    if (binding.mode !== 'stub') continue;
    const simulationId = binding.simulationId;
    if (simulationId === undefined) {
      // The schema already refuses this; the guard keeps the invariant local.
      throw new SealedProvisioningError(
        'SEALED_BINDING_NO_SIMULATION',
        `The sealed fixture binding for "${binding.integrationId}" is a stub and names no simulationId.`,
      );
    }

    const pinned = sources[simulationId];
    if (pinned === undefined) {
      throw new SealedProvisioningError(
        'SEALED_SOURCE_UNRESOLVED',
        `The batch recorded no source world for simulation "${simulationId}", so this trial cannot be provisioned from the same selection its siblings were.`,
      );
    }

    const source = await readHomeArtifacts(db, tenantCtx, homeSpaceId, {
      integrationId: binding.integrationId,
      simulationId,
      baselineVersion: pinned.baselineVersion,
    });

    // A simulation keeps no revision history, so an artifact edited mid-batch
    // cannot be reconstructed as it stood at launch. Refusing is the only
    // honest answer left — the alternative is a later trial measuring a
    // different subject than the first under the same case revision.
    if (source.simulation.revision !== pinned.simulationRevision) {
      throw new SealedProvisioningError(
        'SEALED_SOURCE_MOVED',
        `Simulation "${simulationId}" was at revision ${String(pinned.simulationRevision)} when this batch launched and is now at ${String(source.simulation.revision)}. Trials of one case must face the same world, and an earlier revision cannot be recovered — re-run the batch against the current artifact.`,
      );
    }

    // The definition is read from the home space HERE, at dispatch, not at
    // launch — so an endpoint edited in between is carried into the trial while
    // the manifest still describes the contract the batch recorded. That is the
    // same hazard the simulation revision check above refuses, one artifact
    // over, and it is the tool surface the agent reads.
    if (pinned.definitionHash !== undefined) {
      const currentHash = stableHash(
        apiSurfaceFor([{ apiId: binding.integrationId, definitionJson: source.definitionJson }]),
      );
      if (currentHash !== pinned.definitionHash) {
        throw new SealedProvisioningError(
          'SEALED_SOURCE_MOVED',
          `The API definition for "${binding.integrationId}" has changed since this batch launched. Trials of one case must face the same tool surface, and the contract as it stood at launch cannot be recovered — re-run the batch against the current definition.`,
        );
      }
    }

    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx
        .insert(apiDefinitions)
        .values({
          apiId: binding.integrationId,
          spaceId: fixtureSpaceId,
          name: source.definitionName,
          definitionJson: source.definitionJson,
        })
        .onConflictDoNothing();
    });

    // Revision 0 asserts "this simulation does not exist here yet" — a fixture
    // space is fresh, so anything else means two trials raced into one space.
    await writeSimulationArtifact({
      db,
      tenantCtx,
      tenantId,
      spaceId: fixtureSpaceId,
      simulation: source.simulation,
      expectedRevision: 0,
    });

    // The version comes back from the writer rather than being assumed. Writing
    // the artifact mints an empty baseline of its own, so the copied world is
    // never the first version in the fixture space — and pinning the empty one
    // hands the trial a world with no rows, which `unmatched: 'generate'`
    // answers by inventing them. The case then grades a world nobody authored.
    const seeded = await seedSimulationBaseline(
      { db, tenantCtx, tenantId, spaceId: fixtureSpaceId },
      source.simulation,
      {
        simulationId,
        entities: source.entities,
        description: `Sealed eval fixture, copied from baseline v${String(source.baselineVersion)}`,
      },
    );

    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(apiBindings).values({
        bindingId: `sealed-${binding.integrationId}`,
        spaceId: fixtureSpaceId,
        apiId: binding.integrationId,
        name: source.definitionName,
        description: 'Simulated binding provisioned for a sealed eval trial.',
        scopeJson: { tenantId: tenantId as string, spaceId: fixtureSpaceId },
        // Never the source binding's auth, whatever it was: a simulated call
        // reaches no host, and a credential reference here would be the one
        // secret-shaped thing in a space that exists to hold none.
        authJson: { type: 'none' },
        // The source binding's policy, because it is known to parse. A hand-made
        // one is a second place to keep in step with the schema, and a binding
        // the loader cannot parse is not reported as invalid — it is reported as
        // ABSENT, which reads as "this integration was never bound here".
        egressPolicyJson: source.egressPolicyJson,
        fulfillmentMode: 'simulated',
        simulationId,
        enabled: 1,
      });
    });

    // The run pins the COPY's version, not the one it came from: the two spaces
    // number their baselines independently.
    baselineVersions[simulationId] = seeded.baseline.version;
    if (binding.personaId !== undefined) personaIds[simulationId] = binding.personaId;
  }

  return {
    seed,
    baselineVersions,
    ...(Object.keys(personaIds).length > 0 ? { personaIds } : {}),
    ...(clockAnchorMs !== undefined ? { clockAnchorMs } : {}),
  };
}

interface HomeArtifacts {
  definitionName: string;
  definitionJson: unknown;
  egressPolicyJson: unknown;
  simulation: ReturnType<typeof SimulationSchema.parse>;
  entities: Record<string, Array<Record<string, unknown>>>;
  baselineVersion: number;
}

async function readHomeArtifacts(
  db: PostgresJsDatabase,
  tenantCtx: ReturnType<typeof createTenantContext>,
  homeSpaceId: string,
  want: { integrationId: string; simulationId: string; baselineVersion?: number },
): Promise<HomeArtifacts> {
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const definitionRows = await tx
      .select({ name: apiDefinitions.name, definitionJson: apiDefinitions.definitionJson })
      .from(apiDefinitions)
      .where(
        and(eq(apiDefinitions.apiId, want.integrationId), eq(apiDefinitions.spaceId, homeSpaceId)),
      )
      .limit(1);
    const definition = definitionRows[0];
    if (!definition) {
      throw new SealedProvisioningError(
        'SEALED_DEFINITION_NOT_FOUND',
        `The sealed case names integration "${want.integrationId}", which the batch's home space does not define.`,
      );
    }

    const simulationRows = await tx
      .select({ definitionJson: simulations.definitionJson })
      .from(simulations)
      .where(
        and(eq(simulations.simulationId, want.simulationId), eq(simulations.spaceId, homeSpaceId)),
      )
      .limit(1);
    const simulationRow = simulationRows[0];
    if (!simulationRow) {
      throw new SealedProvisioningError(
        'SEALED_SIMULATION_NOT_FOUND',
        `The sealed case names simulation "${want.simulationId}", which the batch's home space does not hold.`,
      );
    }
    const parsed = SimulationSchema.safeParse(simulationRow.definitionJson);
    if (!parsed.success) {
      throw new SealedProvisioningError(
        'SEALED_SIMULATION_INVALID',
        `Simulation "${want.simulationId}" does not validate, so a trial cannot be sealed against it: ${parsed.error.issues
          .slice(0, 4)
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
    }

    const baselineRows = await tx
      .select({ version: simulationBaselines.version })
      .from(simulationBaselines)
      .where(
        and(
          eq(simulationBaselines.spaceId, homeSpaceId),
          eq(simulationBaselines.simulationId, want.simulationId),
        ),
      );
    const version = chooseBaselineVersion(
      baselineRows.map((row) => row.version),
      want.simulationId,
      want.baselineVersion,
    );
    const entityRows = await tx
      .select({
        collection: simulationEntities.collection,
        bodyJson: simulationEntities.bodyJson,
      })
      .from(simulationEntities)
      .where(
        and(
          eq(simulationEntities.spaceId, homeSpaceId),
          eq(simulationEntities.simulationId, want.simulationId),
          eq(simulationEntities.version, version),
        ),
      );

    const entities: Record<string, Array<Record<string, unknown>>> = {};
    for (const row of entityRows) {
      (entities[row.collection] ??= []).push(row.bodyJson as Record<string, unknown>);
    }

    // The source binding is the shape the loader already accepts for this
    // integration. Absent one, the definition's own host is what a live call
    // would have reached — and a simulated call reaches nothing either way.
    const bindingRows = await tx
      .select({ egressPolicyJson: apiBindings.egressPolicyJson })
      .from(apiBindings)
      .where(and(eq(apiBindings.apiId, want.integrationId), eq(apiBindings.spaceId, homeSpaceId)))
      .limit(1);

    return {
      definitionName: definition.name,
      definitionJson: definition.definitionJson,
      egressPolicyJson:
        bindingRows[0]?.egressPolicyJson ?? egressPolicyForDefinition(definition.definitionJson),
      simulation: parsed.data,
      entities,
      baselineVersion: version,
    };
  });
}

/**
 * Which of the simulation's baseline versions the trial copies.
 *
 * Exported for direct coverage: this is the whole of the case's authority over
 * which world it faces, and both refusals below are silent failures if they are
 * ever relaxed into a fallback.
 */
export function chooseBaselineVersion(
  held: readonly number[],
  simulationId: string,
  requested?: number,
): number {
  const sorted = [...held].sort((a, b) => a - b);
  if (sorted.length === 0) {
    throw new SealedProvisioningError(
      'SEALED_BASELINE_NOT_FOUND',
      `Simulation "${simulationId}" holds no baseline version, so there is no world to copy.`,
    );
  }
  if (requested === undefined) return sorted[sorted.length - 1]!;
  if (!sorted.includes(requested)) {
    // Falling back to the head here would answer a case that asked for an older
    // world with a newer one, and copying an empty world instead would leave
    // `unmatched: 'generate'` inventing the rows — both grade as though they
    // measured the case that was written.
    throw new SealedProvisioningError(
      'SEALED_BASELINE_NOT_FOUND',
      `The sealed case pins baseline version ${String(requested)} of "${simulationId}", which holds only [${sorted.join(', ')}].`,
    );
  }
  return requested;
}

/**
 * A policy for an integration the home space defines but never bound.
 *
 * `allowedHosts` cannot be empty, and a simulated binding has no host to name —
 * so it names the one the simulator's canonical request already carries, which
 * resolves nowhere by construction.
 */
function egressPolicyForDefinition(definitionJson: unknown): Record<string, unknown> {
  const baseUrl =
    definitionJson !== null && typeof definitionJson === 'object'
      ? (definitionJson as Record<string, unknown>)['baseUrl']
      : undefined;
  let host = SIMULATED_HOST;
  if (typeof baseUrl === 'string') {
    try {
      host = new URL(baseUrl).host;
    } catch {
      host = SIMULATED_HOST;
    }
  }
  return { allowedHosts: [host] };
}
