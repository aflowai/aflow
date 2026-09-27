/**
 * The operator's view of simulated fulfillment — what a simulation holds, what
 * it can actually answer, and the world a run left behind.
 *
 * The one write here posts the whole artifact through `writeSimulationArtifact`,
 * the same function the `integration.simulation.upsert` operation calls. The
 * invariants that make a stored simulation safe to pin — an endpoint-mode
 * target that exists, a revision the store assigns and bumps under a lock —
 * therefore hold identically whether an agent or the editor wrote it. A route
 * that reimplemented the upsert would be a second place to enforce them, and
 * the first place they would stop being.
 *
 * Readiness is RECOMPUTED per request rather than stored. It is a function of
 * the simulation and the API definition, and both move independently — an
 * endpoint gains a response schema and every simulation over it becomes more
 * answerable without anything rewriting a stored verdict.
 *
 * Authz mirrors API bindings (`api_config:read`): a simulation is space
 * infrastructure config at the same altitude as the binding that names it.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  apiBindings,
  apiDefinitions,
  simulationBaselines,
  simulationCallRecords,
  simulationRunContexts,
  simulations,
} from '@aflow/database';
import {
  foldRunWorld,
  freezeSimulationBaseline,
  restoreSimulationBaseline,
  seedSimulationBaseline,
  SimulationArtifactRejected,
  SimulationBaselineRejected,
  SimulationWorldReadError,
  writeSimulationArtifact,
} from '@aflow/cybernetic-runtime';
import { endpointReadiness, simulationReadiness } from '@aflow/integration-simulator';
import {
  ApiDefinitionSchema,
  SimulationSchema,
  type ApiDefinition,
  type Simulation,
  type SimulationEndpointReadiness,
} from '@aflow/schemas';
import { getDb, getPayloadStore, getRedis } from './shared.js';

const ReadinessCountsSchema = z.object({
  world_ready: z.number(),
  contract_ready: z.number(),
  not_ready: z.number(),
});

const SimulationSummarySchema = z.object({
  simulationId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  revision: z.number(),
  targetApiId: z.string(),
  enabled: z.boolean(),
  collections: z.array(z.string()),
  /** Bindings in this space whose fulfillment names this simulation. */
  boundBindingIds: z.array(z.string()),
  endpointCount: z.number(),
  readiness: ReadinessCountsSchema,
  updatedAt: z.string(),
});

const BaselineSchema = z.object({
  version: z.number(),
  description: z.string().nullable(),
  entityCounts: z.record(z.number()),
  createdAt: z.string(),
});

const EndpointReportSchema = z.object({
  endpointId: z.string(),
  readiness: z.enum(['world_ready', 'contract_ready', 'not_ready']),
  declaredStatusClasses: z.array(z.string()),
  hasEffect: z.boolean(),
  hasRule: z.boolean(),
  diagnostics: z.array(
    z.object({ code: z.string(), endpointId: z.string().optional(), detail: z.string() }),
  ),
});

function emptyCounts(): z.infer<typeof ReadinessCountsSchema> {
  return { world_ready: 0, contract_ready: 0, not_ready: 0 };
}

function countReadiness(levels: readonly SimulationEndpointReadiness[]) {
  const counts = emptyCounts();
  for (const level of levels) counts[level] += 1;
  return counts;
}

/**
 * A stored row that no longer parses is reported, never dropped. Hiding it
 * would present a space as holding fewer simulations than it does, and the
 * unparseable one is exactly the one an operator needs to find.
 */
function parseSimulation(definitionJson: unknown): Simulation | undefined {
  const parsed = SimulationSchema.safeParse(definitionJson);
  return parsed.success ? parsed.data : undefined;
}

function parseDefinition(definitionJson: unknown): ApiDefinition | undefined {
  const parsed = ApiDefinitionSchema.safeParse(definitionJson);
  return parsed.success ? parsed.data : undefined;
}

export function registerSimulationRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/simulations',
    {
      config: { authz: { resource: 'api_config', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'List simulations in this space',
        response: { 200: z.object({ simulations: z.array(SimulationSummarySchema) }) },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      if (!db) {
        reply.send({ simulations: [] });
        return;
      }

      const tenantContext = createTenantContext(tenant.tenantId);
      const { rows, bindings, definitions } = await withTenantSchema(
        db,
        tenantContext,
        async (tx) => ({
          rows: await tx.select().from(simulations).where(eq(simulations.spaceId, space.spaceId)),
          bindings: await tx
            .select({
              bindingId: apiBindings.bindingId,
              simulationId: apiBindings.simulationId,
            })
            .from(apiBindings)
            .where(eq(apiBindings.spaceId, space.spaceId)),
          definitions: await tx
            .select({
              apiId: apiDefinitions.apiId,
              definitionJson: apiDefinitions.definitionJson,
            })
            .from(apiDefinitions)
            .where(eq(apiDefinitions.spaceId, space.spaceId)),
        }),
      );

      const definitionByApi = new Map(definitions.map((d) => [d.apiId, d.definitionJson]));

      const summaries = rows.map((row) => {
        const simulation = parseSimulation(row.definitionJson);
        const definition = parseDefinition(definitionByApi.get(row.targetApiId));
        const reports =
          simulation && definition
            ? simulationReadiness(definition, simulation).endpoints
            : undefined;

        return {
          simulationId: row.simulationId,
          name: row.name,
          description: row.description ?? null,
          revision: row.revision,
          targetApiId: row.targetApiId,
          enabled: row.enabled === 1,
          collections: simulation?.collections.map((c) => c.collection) ?? [],
          boundBindingIds: bindings
            .filter((b) => b.simulationId === row.simulationId)
            .map((b) => b.bindingId),
          endpointCount: definition?.endpoints.length ?? 0,
          readiness: reports ? countReadiness(reports.map((r) => r.readiness)) : emptyCounts(),
          updatedAt: new Date(row.updatedAt).toISOString(),
        };
      });

      reply.send({ simulations: summaries });
    },
  );

  app.get(
    '/simulations/:simulationId',
    {
      config: { authz: { resource: 'api_config', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Get a simulation with per-endpoint readiness',
        params: z.object({ simulationId: z.string() }),
        response: {
          200: z.object({
            summary: SimulationSummarySchema,
            simulation: z.record(z.unknown()),
            endpoints: z.array(EndpointReportSchema),
            baselines: z.array(BaselineSchema),
          }),
          404: z.object({ error: z.string() }),
          422: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      if (!db) {
        reply.code(404).send({ error: 'Database not configured' });
        return;
      }
      const { simulationId } = request.params as { simulationId: string };
      const tenantContext = createTenantContext(tenant.tenantId);

      const { rows, bindings, baselines } = await withTenantSchema(
        db,
        tenantContext,
        async (tx) => ({
          rows: await tx
            .select()
            .from(simulations)
            .where(
              and(
                eq(simulations.simulationId, simulationId),
                eq(simulations.spaceId, space.spaceId),
              ),
            )
            .limit(1),
          bindings: await tx
            .select({ bindingId: apiBindings.bindingId, simulationId: apiBindings.simulationId })
            .from(apiBindings)
            .where(eq(apiBindings.spaceId, space.spaceId)),
          baselines: await tx
            .select({
              version: simulationBaselines.version,
              description: simulationBaselines.description,
              entityCounts: simulationBaselines.entityCounts,
              createdAt: simulationBaselines.createdAt,
            })
            .from(simulationBaselines)
            .where(
              and(
                eq(simulationBaselines.simulationId, simulationId),
                eq(simulationBaselines.spaceId, space.spaceId),
              ),
            )
            .orderBy(desc(simulationBaselines.version)),
        }),
      );

      const row = rows[0];
      if (!row) {
        reply.code(404).send({ error: `Simulation "${simulationId}" not found in this space.` });
        return;
      }

      const simulation = parseSimulation(row.definitionJson);
      if (!simulation) {
        reply.code(422).send({
          error: `Simulation "${simulationId}" is stored in a shape this version cannot read, so its readiness cannot be computed.`,
        });
        return;
      }

      const defRows = await withTenantSchema(db, tenantContext, async (tx) =>
        tx
          .select({ definitionJson: apiDefinitions.definitionJson })
          .from(apiDefinitions)
          .where(
            and(
              eq(apiDefinitions.apiId, row.targetApiId),
              eq(apiDefinitions.spaceId, space.spaceId),
            ),
          )
          .limit(1),
      );
      const definition = parseDefinition(defRows[0]?.definitionJson);

      // A rule is per-endpoint authoring the endpoint report does not carry, so
      // it is composed here rather than pushed into the shared detector.
      const ruledEndpoints = new Set(simulation.rules.map((rule) => rule.when.endpointId));

      const endpoints = (definition?.endpoints ?? []).map((endpoint) => {
        const report = endpointReadiness(endpoint, simulation);
        return {
          endpointId: report.endpointId,
          readiness: report.readiness,
          declaredStatusClasses: report.declaredStatusClasses,
          hasEffect: report.hasEffect,
          hasRule: ruledEndpoints.has(endpoint.endpointId),
          diagnostics: report.diagnostics,
        };
      });

      reply.send({
        summary: {
          simulationId: row.simulationId,
          name: row.name,
          description: row.description ?? null,
          revision: row.revision,
          targetApiId: row.targetApiId,
          enabled: row.enabled === 1,
          collections: simulation.collections.map((c) => c.collection),
          boundBindingIds: bindings
            .filter((b) => b.simulationId === row.simulationId)
            .map((b) => b.bindingId),
          endpointCount: definition?.endpoints.length ?? 0,
          readiness: countReadiness(endpoints.map((e) => e.readiness)),
          updatedAt: new Date(row.updatedAt).toISOString(),
        },
        simulation: simulation as unknown as Record<string, unknown>,
        endpoints,
        baselines: baselines.map((baseline) => ({
          version: baseline.version,
          description: baseline.description ?? null,
          entityCounts: baseline.entityCounts,
          createdAt: baseline.createdAt.toISOString(),
        })),
      });
    },
  );

  app.put(
    '/simulations/:simulationId',
    {
      config: { authz: { resource: 'api_config', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Create or replace a simulation',
        params: z.object({ simulationId: z.string() }),
        // The whole artifact, because a partial write cannot be validated: an
        // effect names collections, and a rule names a status the definition
        // must declare, so half an artifact is not a smaller artifact.
        body: z.object({
          simulation: z.record(z.unknown()),
          // The editor sends what it loaded. A save that lands after an agent
          // edited the same artifact is refused rather than dropping that edit.
          // Required, matching the operation: an optional guard is the one
          // every caller forgets, and forgetting it discards another edit.
          expectedRevision: z.number().int().min(0),
        }),
        response: {
          200: z.object({
            simulationId: z.string(),
            revision: z.number(),
            created: z.boolean(),
          }),
          400: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      if (!db) {
        reply.code(404).send({ error: 'Database not configured' });
        return;
      }
      const { simulationId } = request.params as { simulationId: string };
      const body = request.body as {
        simulation: Record<string, unknown>;
        expectedRevision: number;
      };

      // The path owns the id. `revision`, `createdAt` and `updatedAt` are
      // dropped rather than defaulted here: the store assigns all three, and a
      // caller that could supply a revision could move the artifact a run is
      // pinned to.
      const {
        revision: _revision,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        ...authored
      } = body.simulation;
      const parsed = SimulationSchema.safeParse({ ...authored, simulationId });
      if (!parsed.success) {
        reply.code(400).send({
          error: `The simulation does not validate: ${parsed.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')}`,
        });
        return;
      }

      try {
        const result = await writeSimulationArtifact({
          db,
          tenantCtx: createTenantContext(tenant.tenantId),
          tenantId: tenant.tenantId,
          spaceId: space.spaceId as string,
          simulation: parsed.data,
          expectedRevision: body.expectedRevision,
        });
        reply.send({
          simulationId: result.simulationId,
          revision: result.revision,
          created: result.created,
        });
      } catch (error) {
        if (error instanceof SimulationArtifactRejected) {
          const status =
            error.code === 'SIMULATION_TARGET_NOT_FOUND'
              ? 404
              : error.code === 'SIMULATION_REVISION_CONFLICT'
                ? 409
                : 400;
          reply.code(status).send({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );

  app.get(
    '/simulations/:simulationId/runs',
    {
      config: { authz: { resource: 'api_config', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Runs that hold a world for this simulation',
        params: z.object({ simulationId: z.string() }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }),
        response: {
          200: z.object({
            runs: z.array(
              z.object({
                runId: z.string(),
                pinnedAt: z.string(),
                baselineVersion: z.number(),
                simulationRevision: z.number(),
                /** Journal records, which is one per CALL rather than per mutation. */
                callCount: z.number(),
                /** Greatest version the run reached, 0 when nothing committed. */
                headVersion: z.number(),
              }),
            ),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      if (!db) {
        reply.send({ runs: [] });
        return;
      }
      const { simulationId } = request.params as { simulationId: string };
      const { limit } = request.query as { limit?: number };
      const tenantContext = createTenantContext(tenant.tenantId);

      // A run appears because it PINNED the simulation, not because it
      // committed to it: a run whose every call was answered by a rule holds a
      // world worth inspecting and has advanced no version.
      const pins = await withTenantSchema(db, tenantContext, async (tx) =>
        tx
          .select({
            runId: simulationRunContexts.runId,
            createdAt: simulationRunContexts.createdAt,
            contextJson: simulationRunContexts.contextJson,
          })
          .from(simulationRunContexts)
          .where(
            and(
              eq(simulationRunContexts.spaceId, space.spaceId),
              eq(simulationRunContexts.simulationId, simulationId),
            ),
          )
          .orderBy(desc(simulationRunContexts.createdAt))
          .limit(limit ?? 25),
      );

      if (pins.length === 0) {
        reply.send({ runs: [] });
        return;
      }

      const runIds = pins.map((pin) => pin.runId);
      const counts = await withTenantSchema(db, tenantContext, async (tx) =>
        tx
          .select({
            runId: simulationCallRecords.runId,
            calls: sql<number>`count(*)::int`,
            head: sql<number>`coalesce(max(${simulationCallRecords.worldVersionAfter}), 0)::int`,
          })
          .from(simulationCallRecords)
          .where(
            and(
              eq(simulationCallRecords.spaceId, space.spaceId),
              eq(simulationCallRecords.simulationId, simulationId),
              inArray(simulationCallRecords.runId, runIds),
            ),
          )
          .groupBy(simulationCallRecords.runId),
      );
      const byRun = new Map(counts.map((row) => [row.runId, row]));

      reply.send({
        runs: pins.map((pin) => {
          const tally = byRun.get(pin.runId);
          return {
            runId: pin.runId,
            pinnedAt: new Date(pin.createdAt).toISOString(),
            baselineVersion: pin.contextJson.baselineVersion,
            simulationRevision: pin.contextJson.simulationRevision,
            callCount: tally?.calls ?? 0,
            headVersion: tally?.head ?? 0,
          };
        }),
      });
    },
  );

  app.get(
    '/simulations/:simulationId/world',
    {
      config: { authz: { resource: 'api_config', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: "Fold a run's simulated world to a version",
        params: z.object({ simulationId: z.string() }),
        querystring: z.object({
          runId: z.string(),
          worldVersion: z.coerce.number().int().min(0).optional(),
          entityLimit: z.coerce.number().int().min(1).max(500).optional(),
          includeCalls: z.coerce.boolean().optional(),
        }),
        response: {
          200: z.object({
            runContext: z.record(z.unknown()),
            worldVersion: z.number(),
            atHead: z.boolean(),
            collections: z.array(
              z.object({
                collection: z.string(),
                entities: z.array(z.record(z.unknown())),
                total: z.number(),
                truncated: z.boolean(),
              }),
            ),
            calls: z.array(z.record(z.unknown())).optional(),
          }),
          400: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      const redis = getRedis(fastify);
      const payloadStore = getPayloadStore(fastify);
      if (!db || !redis || !payloadStore) {
        reply.code(404).send({ error: 'World storage is not configured on this deployment.' });
        return;
      }

      const { simulationId } = request.params as { simulationId: string };
      const query = request.query as {
        runId: string;
        worldVersion?: number;
        entityLimit?: number;
        includeCalls?: boolean;
      };

      try {
        const world = await foldRunWorld(
          {
            db,
            redis,
            payloadStore,
            tenantId: tenant.tenantId,
            spaceId: space.spaceId as string,
          },
          {
            simulationId,
            runId: query.runId,
            worldVersion: query.worldVersion,
            entityLimit: query.entityLimit,
            includeCalls: query.includeCalls,
          },
        );
        reply.send({
          runContext: world.runContext as unknown as Record<string, unknown>,
          worldVersion: world.worldVersion,
          atHead: world.atHead,
          collections: world.collections,
          ...(world.calls
            ? { calls: world.calls as unknown as Array<Record<string, unknown>> }
            : {}),
        });
      } catch (error) {
        if (error instanceof SimulationWorldReadError) {
          reply.code(error.kind === 'not_found' ? 404 : 400).send({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );

  /**
   * Loading the artifact a baseline write is held to.
   *
   * The declarations, not the rows: every mint validates the whole post-copy
   * world against the collections as they stand NOW, so the write needs the
   * current artifact even when it supplies no entities of its own.
   */
  async function loadSimulation(
    db: NonNullable<ReturnType<typeof getDb>>,
    tenantId: string,
    spaceId: string,
    simulationId: string,
  ): Promise<Simulation | null> {
    const rows = await withTenantSchema(db, createTenantContext(tenantId as never), async (tx) =>
      tx
        .select({ definitionJson: simulations.definitionJson })
        .from(simulations)
        .where(and(eq(simulations.simulationId, simulationId), eq(simulations.spaceId, spaceId)))
        .limit(1),
    );
    const row = rows[0];
    if (!row) return null;
    const parsed = SimulationSchema.safeParse(row.definitionJson);
    return parsed.success ? parsed.data : null;
  }

  const BaselineResponseSchema = z.object({
    baseline: z.object({
      simulationId: z.string(),
      version: z.number(),
      description: z.string().optional(),
      entityCounts: z.record(z.number()),
      createdAt: z.string().optional(),
    }),
    foldedCallCount: z.number().optional(),
    worldVersion: z.number().optional(),
  });

  /**
   * Every baseline write answers the same refusals, because they all run the
   * same writer. A rejected world is 400 with the violations named, a lost race
   * is 409 — the operator re-reads and retries rather than forcing.
   */
  function baselineFailure(error: unknown): { status: 400 | 404 | 409; error: string } | null {
    if (!(error instanceof SimulationBaselineRejected)) return null;
    const status = error.kind === 'not_found' ? 404 : error.kind === 'conflict' ? 409 : 400;
    return { status, error: error.message };
  }

  app.post(
    '/simulations/:simulationId/baselines',
    {
      config: { authz: { resource: 'api_config', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Seed a new baseline version from supplied entities',
        params: z.object({ simulationId: z.string() }),
        body: z.object({
          entities: z.record(z.array(z.record(z.unknown()))),
          description: z.string().max(500).optional(),
        }),
        response: {
          200: BaselineResponseSchema,
          400: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      if (!db) {
        reply.code(404).send({ error: 'Database not configured' });
        return;
      }
      const { simulationId } = request.params as { simulationId: string };
      const body = request.body as {
        entities: Record<string, Array<Record<string, unknown>>>;
        description?: string;
      };
      const spaceId = space.spaceId as string;
      const simulation = await loadSimulation(db, tenant.tenantId, spaceId, simulationId);
      if (!simulation) {
        reply
          .code(404)
          .send({ error: `Simulation "${simulationId}" was not found in this space.` });
        return;
      }

      try {
        const result = await seedSimulationBaseline(
          {
            db,
            tenantCtx: createTenantContext(tenant.tenantId),
            tenantId: tenant.tenantId,
            spaceId,
          },
          simulation,
          {
            simulationId,
            entities: body.entities,
            ...(body.description === undefined ? {} : { description: body.description }),
          },
        );
        reply.send(result);
      } catch (error) {
        const failure = baselineFailure(error);
        if (!failure) throw error;
        reply.code(failure.status).send({ error: failure.error });
      }
    },
  );

  app.post(
    '/simulations/:simulationId/baselines/freeze',
    {
      config: { authz: { resource: 'api_config', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: "Promote a run's world into a new baseline version",
        params: z.object({ simulationId: z.string() }),
        body: z.object({
          runId: z.string(),
          // The version the operator was LOOKING at. A freeze that read the
          // latest itself would promote from whatever landed while they read.
          expectedVersion: z.number().int().min(1),
          description: z.string().max(500).optional(),
        }),
        response: {
          200: BaselineResponseSchema,
          400: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      const redis = getRedis(fastify);
      const payloadStore = getPayloadStore(fastify);
      if (!db || !redis || !payloadStore) {
        reply.code(404).send({ error: 'World storage is not configured on this deployment.' });
        return;
      }
      const { simulationId } = request.params as { simulationId: string };
      const body = request.body as {
        runId: string;
        expectedVersion: number;
        description?: string;
      };
      const spaceId = space.spaceId as string;
      const simulation = await loadSimulation(db, tenant.tenantId, spaceId, simulationId);
      if (!simulation) {
        reply
          .code(404)
          .send({ error: `Simulation "${simulationId}" was not found in this space.` });
        return;
      }

      try {
        const result = await freezeSimulationBaseline(
          {
            db,
            tenantCtx: createTenantContext(tenant.tenantId),
            tenantId: tenant.tenantId,
            spaceId,
          },
          { db, redis, payloadStore, tenantId: tenant.tenantId, spaceId },
          simulation,
          {
            simulationId,
            runId: body.runId,
            expectedVersion: body.expectedVersion,
            ...(body.description === undefined ? {} : { description: body.description }),
          },
        );
        reply.send(result);
      } catch (error) {
        const failure = baselineFailure(error);
        if (!failure) throw error;
        reply.code(failure.status).send({ error: failure.error });
      }
    },
  );

  app.post(
    '/simulations/:simulationId/baselines/restore',
    {
      config: { authz: { resource: 'api_config', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: "Mint a new baseline version holding an earlier one's world",
        params: z.object({ simulationId: z.string() }),
        body: z.object({
          fromVersion: z.number().int().min(1),
          description: z.string().max(500).optional(),
        }),
        response: {
          200: BaselineResponseSchema,
          400: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      if (!db) {
        reply.code(404).send({ error: 'Database not configured' });
        return;
      }
      const { simulationId } = request.params as { simulationId: string };
      const body = request.body as { fromVersion: number; description?: string };
      const spaceId = space.spaceId as string;
      const simulation = await loadSimulation(db, tenant.tenantId, spaceId, simulationId);
      if (!simulation) {
        reply
          .code(404)
          .send({ error: `Simulation "${simulationId}" was not found in this space.` });
        return;
      }

      try {
        const result = await restoreSimulationBaseline(
          {
            db,
            tenantCtx: createTenantContext(tenant.tenantId),
            tenantId: tenant.tenantId,
            spaceId,
          },
          simulation,
          {
            simulationId,
            fromVersion: body.fromVersion,
            ...(body.description === undefined ? {} : { description: body.description }),
          },
        );
        reply.send(result);
      } catch (error) {
        const failure = baselineFailure(error);
        if (!failure) throw error;
        reply.code(failure.status).send({ error: failure.error });
      }
    },
  );
}
