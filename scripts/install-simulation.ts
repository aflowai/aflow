import 'dotenv/config';

import {
  closeConnection,
  createAgentRepository,
  createTenantContext,
  getConnection,
  getDatabase,
  listTenantSchemas,
  resolveAgentRef,
  simulations,
  spaces,
  withTenantSchema,
} from '@aflow/database';
import {
  seedSimulationBaseline,
  writeApiDefinition,
  writeSimulationArtifact,
} from '@aflow/cybernetic-runtime';
import {
  ApiDefinitionSchema,
  SimulationSchema,
  type AgentId,
  type AgentSlug,
  type SimulationDeskAgent,
  type ApiDefinition,
  type Simulation,
  type TenantId,
} from '@aflow/schemas';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

/**
 * Put an authored simulation and its seed world into a space.
 *
 * The artifact is 100KB of collection schemas and handler source, which is more
 * than an operator pastes into a form and more than an agent should be asked to
 * retype. It travels from the repo, where it is version-controlled and tested,
 * through the SAME writers the server's routes and the inline operations use —
 * so revision checking, target validation, copy-on-write versioning and the
 * whole-world revalidation all still apply. Writing the rows directly would
 * skip every one of them.
 *
 *   NODE_OPTIONS='--conditions=ts-source' npx tsx scripts/install-simulation.ts \
 *     --simulation cs-desk --space <spaceId> [--artifact-only|--seed-only]
 */

interface Bundle {
  definition: ApiDefinition;
  simulation: Simulation;
  /** The subject that talks to this world. A separate artifact, not part of the simulation. */
  agent?: SimulationDeskAgent;
  baseline: Record<string, Array<Record<string, unknown>>>;
  baselineDescription: string;
}

/** Simulations this script can install, by the id they carry. */
const BUNDLES: Record<string, () => Promise<Bundle>> = {
  'cs-desk': async () => {
    const [
      { buildCsDeskSimulation },
      { CS_DESK_BASELINE },
      { CS_DESK_DEFINITION },
      { CS_DESK_AGENT },
    ] = await Promise.all([
      import('../packages/integration-simulator/src/csDesk/simulation.js'),
      import('../packages/integration-simulator/src/csDesk/baseline.js'),
      import('../packages/integration-simulator/src/csDesk/definition.js'),
      import('../packages/integration-simulator/src/csDesk/agent.js'),
    ]);
    return {
      definition: ApiDefinitionSchema.parse(CS_DESK_DEFINITION),
      agent: CS_DESK_AGENT,
      simulation: buildCsDeskSimulation(),
      baseline: CS_DESK_BASELINE,
      baselineDescription: 'Support desk seed world — one case per decision row.',
    };
  },
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const simulationId = arg('simulation');
  const spaceId = arg('space');
  const artifactOnly = process.argv.includes('--artifact-only');
  const skipDefinition = process.argv.includes('--skip-definition');
  const skipAgent = process.argv.includes('--skip-agent');
  const seedOnly = process.argv.includes('--seed-only');

  const load = simulationId ? BUNDLES[simulationId] : undefined;
  if (!load || !spaceId) {
    console.error(
      `usage: install-simulation.ts --simulation <${Object.keys(BUNDLES).join('|')}> --space <spaceId> [--artifact-only|--seed-only|--skip-definition|--skip-agent]`,
    );
    process.exitCode = 1;
    return;
  }

  const bundle = await load();
  const simulation = SimulationSchema.parse(bundle.simulation);
  const db = getDatabase();

  try {
    // A space row lives inside its tenant's schema and carries no tenant column,
    // so the tenant is found by looking for the space rather than read off it.
    const tenants = await listTenantSchemas(getConnection());
    let found: { tenantId: TenantId; name: string } | undefined;
    for (const tenant of tenants) {
      const ctx = createTenantContext(tenant.tenantId);
      const rows = await withTenantSchema(db, ctx, async (tx: unknown) =>
        (tx as PostgresJsDatabase)
          .select({ name: spaces.name })
          .from(spaces)
          .where(eq(spaces.id, spaceId))
          .limit(1),
      );
      const row = rows[0];
      if (row) {
        found = { tenantId: tenant.tenantId, name: row.name };
        break;
      }
    }
    if (!found) throw new Error(`No space ${spaceId} in any tenant`);

    const tenantId = found.tenantId;
    const tenantCtx = createTenantContext(tenantId);
    const scope = { db, tenantCtx, tenantId, spaceId };
    console.log(`space: ${found.name} (${spaceId})  tenant: ${tenantId}`);

    // The definition goes first: the artifact's target is validated against a
    // stored definition, so writing them in the other order rejects a bundle
    // that is internally consistent.
    //
    // This path also carries `writeRiskTier`, which the agent-facing
    // `api.definition.upsert` deliberately strips so an agent cannot un-gate a
    // write endpoint of its own — a curated bundle is exactly the case that
    // needs to set it.
    if (!seedOnly && !skipDefinition) {
      await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
        await writeApiDefinition({
          definition: bundle.definition,
          spaceId,
          conflictPolicy: 'overwrite',
          tx: tx as PostgresJsDatabase,
        });
      });
      const tiers = bundle.definition.endpoints
        .map((e) => `${e.endpointId}=${e.writeRiskTier ?? 'derived'}`)
        .join(' ');
      console.log(
        `definition: ${bundle.definition.apiId} — ${String(bundle.definition.endpoints.length)} endpoints`,
      );
      console.log(`  tiers: ${tiers}`);
    }

    if (!seedOnly) {
      // The stored revision is read first so this is a merge against what is
      // there rather than a blind overwrite of somebody else's edit.
      const stored = await withTenantSchema(db, tenantCtx, async (tx: unknown) =>
        (tx as PostgresJsDatabase)
          .select({ revision: simulations.revision })
          .from(simulations)
          .where(
            and(
              eq(simulations.simulationId, simulation.simulationId),
              eq(simulations.spaceId, spaceId),
            ),
          )
          .limit(1),
      );
      const expectedRevision = stored[0]?.revision ?? 0;

      const written = await writeSimulationArtifact({
        db,
        tenantCtx,
        tenantId,
        spaceId,
        simulation,
        expectedRevision,
      });
      console.log(
        `artifact: ${written.created ? 'created' : 'updated'} at revision ${String(written.revision)} — ` +
          `${String(simulation.collections.length)} collections, ${String(Object.keys(simulation.handlers).length)} handlers, ` +
          `${String(simulation.personas.length)} personas`,
      );

      // The writer computes readiness under the same lock that stored the
      // artifact, so this is the state as written rather than a re-derivation.
      for (const endpoint of written.readiness.endpoints) {
        console.log(`  ${endpoint.readiness.padEnd(14)} ${endpoint.endpointId}`);
      }
      for (const diagnostic of written.readiness.diagnostics) {
        console.log(
          `  ! ${diagnostic.code} ${diagnostic.collection ?? diagnostic.endpointId ?? ''}`,
        );
      }
    }

    // The agent goes last: its tools are the API's endpoints, resolved by
    // `apiId`, and `coreApis` yields ZERO tools silently for an id the space
    // does not carry. Writing it before the definition would produce an agent
    // that looks configured and can call nothing.
    if (!seedOnly && !skipAgent && bundle.agent) {
      const agent = bundle.agent;
      const repo = createAgentRepository(db, tenantCtx);
      const existing = await resolveAgentRef(db, tenantId, {
        spaceId,
        agentSlug: agent.flowId as AgentSlug,
      }).catch(() => null);

      if (existing) {
        const agentId = existing.target.agentId as AgentId;
        const latest = await repo.getLatestVersion(agentId);
        const next = String(Number(latest?.version ?? '0') + 1);
        await repo.publishVersion({
          agentId,
          version: next,
          definition: { ...agent.definition, version: next } as Parameters<
            typeof repo.publishVersion
          >[0]['definition'],
          name: agent.name,
          description: agent.description,
        });
        console.log(`agent: ${agent.flowId} updated to version ${next} (${agentId})`);
      } else {
        const created = await repo.create({
          spaceId,
          slug: agent.flowId as AgentSlug,
          name: agent.name,
          description: agent.description,
          initialVersion: {
            version: '1',
            definition: agent.definition as Parameters<
              typeof repo.create
            >[0]['initialVersion']['definition'],
          },
        });
        console.log(`agent: ${agent.flowId} created (${created.agent.id})`);
      }
      console.log(`  chat: /s/<space-slug>/chat?agentId=<the id above>`);
    }

    if (!artifactOnly) {
      const seeded = await seedSimulationBaseline(scope, simulation, {
        simulationId: simulation.simulationId,
        description: bundle.baselineDescription,
        entities: bundle.baseline,
      });
      const counts = Object.entries(seeded.baseline.entityCounts)
        .map(([collection, n]) => `${collection}=${String(n)}`)
        .join(' ');
      console.log(`baseline: version ${seeded.baseline.version} — ${counts}`);
    }
  } finally {
    await closeConnection();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
