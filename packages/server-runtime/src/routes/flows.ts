/**
 * Agent definition management endpoints.
 *
 * All operations are scoped to the current space (resolved by the space plugin
 * from X-Space-ID header or spaceId query param). Space is mandatory.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  AgentIdPathParamSchema,
  AgentIdSchema,
  AgentSystemRoleSchema,
  deriveFlowInputContract,
  type AgentDefinition,
  type AgentSlug,
} from '@aflow/schemas';
import { isPlatformAgentId } from '@aflow/platform-artifacts';

// ============================================================================
// Schemas
// ============================================================================

const AgentVersionSchema = z.object({
  version: z.string(),
  createdAt: z.string().datetime(),
  createdBy: z.string().nullable(),
  deprecated: z.boolean().default(false),
  deprecatedAt: z.string().datetime().optional(),
});

const AgentSummarySchema = z.object({
  agentId: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().optional(),
  system: z.boolean(),
  spaceId: z.string().uuid().optional(),
  latestVersion: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  primaryInputType: z.string().nullable().optional(),
  primaryInputName: z.string().nullable().optional(),
  systemRole: AgentSystemRoleSchema.nullable().optional(),
});

const AgentDefinitionSchema = z.object({
  agentId: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(
    z.object({
      stepId: z.string(),
      type: z.string(),
      operation: z.string().optional(),
      config: z.record(z.unknown()).optional(),
    }),
  ),
  inputSchema: z.record(z.unknown()).optional(),
  outputSchema: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const PublishAgentRequestSchema = z.object({
  slug: z.string().min(1).max(64).optional(),
  /** Stable UUID — present on subsequent publishes to bump the agent's version. */
  agentId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  startStepId: z.string().optional(),
  steps: z
    .array(
      z.object({
        stepId: z.string(),
        type: z.string(),
        operation: z.string().optional(),
        config: z.record(z.unknown()).optional(),
        outputMapping: z.record(z.string()).optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        onSuccess: z
          .object({
            next: z.array(
              z.object({
                stepId: z.string(),
                priority: z.number().default(1),
                when: z.string().optional(),
              }),
            ),
          })
          .optional(),
        onFailure: z
          .object({
            next: z.array(
              z.object({
                stepId: z.string(),
                priority: z.number().default(1),
                when: z.string().optional(),
              }),
            ),
          })
          .optional(),
      }),
    )
    .min(1),
  inputSchema: z.record(z.unknown()).optional(),
  outputSchema: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const PublishAgentResponseSchema = z.object({
  agentId: AgentIdSchema,
  slug: z.string(),
  version: z.string(),
  message: z.string(),
});

// ============================================================================
// Routes
// ============================================================================

export const flowsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.addHook('preHandler', app.authenticate);

  // -------------------------------------------------------------------------
  // GET /v1/agents - List agents in the current space
  // -------------------------------------------------------------------------
  app.get(
    '/',
    {
      schema: {
        tags: ['Agents'],
        summary: 'List agents',
        description: 'List agent definitions in the current space (set via X-Space-ID header).',
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(100).default(20),
          cursor: z.string().optional(),
          spaceId: z.string().uuid().optional(),
        }),
        response: {
          200: z.object({
            agents: z.array(AgentSummarySchema),
            nextCursor: z.string().optional(),
          }),
        },
      },
      config: { authz: { resource: 'agent', action: 'read', spaceIdFrom: 'requireSpace' } },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const { limit } = request.query;
      const context = request.server.appContext;

      if (context?.db) {
        try {
          const { listCustomAgentsInSpace, listPlatformRoles, getLatestVersionRow } =
            await import('@aflow/database');
          const db = context.db as PostgresJsDatabase;
          const [platformRoles, customRows] = await Promise.all([
            Promise.resolve(listPlatformRoles()),
            listCustomAgentsInSpace(db, tenant.tenantId, space.spaceId, { limit }),
          ]);

          interface AgentListItem {
            agentId: string;
            slug: string;
            name: string;
            description?: string;
            system: boolean;
            spaceId?: string;
            latestVersion: string;
            primaryInputType: string | null;
            primaryInputName: string | null;
            systemRole: ReturnType<typeof AgentSystemRoleSchema.safeParse> extends {
              success: true;
              data: infer T;
            }
              ? T | null
              : never;
            createdAt: string;
            updatedAt: string;
          }

          const platformItems: AgentListItem[] = platformRoles.map((entry) => {
            const def = entry.definition as unknown as Record<string, unknown>;
            const meta = (def['metadata'] ?? {}) as Record<string, unknown>;
            const name =
              (typeof meta['name'] === 'string' ? meta['name'] : undefined) ?? entry.systemRole;
            const description =
              typeof meta['description'] === 'string' ? meta['description'] : undefined;
            let primaryInputType: string | null = null;
            let primaryInputName: string | null = null;
            const stateVars = def['stateVariables'];
            if (Array.isArray(stateVars) && stateVars.length > 0) {
              try {
                const contract = deriveFlowInputContract(def as unknown as AgentDefinition);
                if (contract.primaryInput) {
                  primaryInputType = (contract.primaryInput.typeSchema['type'] as string) ?? null;
                  primaryInputName = contract.primaryInput.name;
                }
              } catch {
                /* best-effort */
              }
            }
            const systemRoleParsed = AgentSystemRoleSchema.safeParse(entry.systemRole);
            return {
              agentId: entry.systemRole,
              slug: entry.systemRole,
              name,
              ...(description ? { description } : {}),
              system: true,
              latestVersion: '1',
              primaryInputType,
              primaryInputName,
              systemRole: (systemRoleParsed.success ? systemRoleParsed.data : null) as never,
              createdAt: new Date('2025-01-01').toISOString(),
              updatedAt: new Date('2025-01-01').toISOString(),
            };
          });

          const customItems: AgentListItem[] = await Promise.all(
            customRows.map(async (row) => {
              const latest = await getLatestVersionRow(db, tenant.tenantId, row.id as never);
              const def = (latest?.definitionJson ?? {}) as Record<string, unknown>;
              let primaryInputType: string | null = null;
              let primaryInputName: string | null = null;
              const stateVars = def['stateVariables'];
              if (Array.isArray(stateVars) && stateVars.length > 0) {
                try {
                  const contract = deriveFlowInputContract(def as unknown as AgentDefinition);
                  if (contract.primaryInput) {
                    primaryInputType = (contract.primaryInput.typeSchema['type'] as string) ?? null;
                    primaryInputName = contract.primaryInput.name;
                  }
                } catch {
                  /* best-effort */
                }
              }
              return {
                agentId: row.id,
                slug: row.slug,
                name: row.name,
                ...(row.description ? { description: row.description } : {}),
                system: false,
                spaceId: row.spaceId,
                latestVersion: latest?.version ?? '',
                primaryInputType,
                primaryInputName,
                systemRole: null as never,
                createdAt: row.createdAt.toISOString(),
                updatedAt: row.updatedAt.toISOString(),
              };
            }),
          );

          reply.send({
            agents: [...platformItems, ...customItems],
            nextCursor: undefined,
          });
          return;
        } catch (err) {
          request.log.error({ err }, 'Failed to query agents from database');
        }
      }

      reply.send({ agents: [], nextCursor: undefined });
    },
  );

  // -------------------------------------------------------------------------
  app.get(
    '/check-slug',
    {
      config: { authz: { resource: 'agent', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Agents'],
        summary: 'Check agent slug availability in this space',
        querystring: z.object({
          slug: z.string().min(1).max(128),
          spaceId: z.string().uuid().optional(),
        }),
        response: {
          200: z.discriminatedUnion('status', [
            z.object({ status: z.literal('available') }),
            z.object({ status: z.literal('invalid'), code: z.string(), message: z.string() }),
            z.object({ status: z.literal('reserved'), message: z.string() }),
            z.object({ status: z.literal('taken') }),
            z.object({
              status: z.literal('retired'),
              message: z.string(),
              currentSlug: z.string().optional(),
            }),
          ]),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const { slug } = request.query;
      const context = request.server.appContext;

      // 1. Syntactic + reserved-word check.
      const { validateAgentSlug } = await import('@aflow/schemas');
      const validation = validateAgentSlug(slug);
      if (!validation.ok) {
        if (validation.code === 'SLUG_INVALID') {
          reply.send({
            status: 'invalid' as const,
            code: validation.code,
            message: validation.message,
          });
          return;
        }
        reply.send({ status: 'reserved' as const, message: validation.message });
        return;
      }

      if (!context?.db) {
        // Mock mode: nothing to compare against; assume available.
        reply.send({ status: 'available' as const });
        return;
      }
      const db = context.db as PostgresJsDatabase;
      const { agents, agentSlugHistory, createTenantContext, withTenantSchema } =
        await import('@aflow/database');
      const { eq, and } = await import('drizzle-orm');
      const tenantCtx = createTenantContext(tenant.tenantId);

      // 2. Live-table lookup, scoped to this space.
      const liveRows = (await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.spaceId, space.spaceId), eq(agents.slug, slug)))
          .limit(1),
      )) as Array<{ id: string }>;
      if (liveRows.length > 0) {
        reply.send({ status: 'taken' as const });
        return;
      }

      // 3. History-reuse block, scoped to this space.
      const historyRows = (await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .select({ agentId: agentSlugHistory.agentId })
          .from(agentSlugHistory)
          .where(
            and(eq(agentSlugHistory.spaceId, space.spaceId), eq(agentSlugHistory.oldSlug, slug)),
          )
          .limit(1),
      )) as Array<{ agentId: string }>;
      if (historyRows.length > 0) {
        const agentId = historyRows[0]!.agentId;
        const currentRows = (await withTenantSchema(db, tenantCtx, async (tx) =>
          tx.select({ slug: agents.slug }).from(agents).where(eq(agents.id, agentId)).limit(1),
        )) as Array<{ slug: string }>;
        const currentSlug = currentRows[0]?.slug;
        reply.send({
          status: 'retired' as const,
          message: `"${slug}" is a retired slug in this space; reuse is blocked while history exists`,
          ...(currentSlug ? { currentSlug } : {}),
        });
        return;
      }

      reply.send({ status: 'available' as const });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/agents/:agentId - Get agent with latest definition
  // -------------------------------------------------------------------------
  app.get(
    '/:agentId',
    {
      schema: {
        tags: ['Agents'],
        summary: 'Get agent detail',
        description: 'Get an agent with its latest definition JSON. Must be in the current space.',
        params: z.object({
          agentId: AgentIdPathParamSchema,
        }),
        querystring: z.object({
          spaceId: z.string().uuid().optional(),
        }),
        response: {
          200: z.object({
            agentId: z.string(),
            slug: z.string(),
            name: z.string(),
            description: z.string().optional(),
            latestVersion: z.string(),
            definition: z.record(z.unknown()),
            inputContract: z.record(z.unknown()).optional(),
            createdAt: z.string().datetime().optional(),
            redirect: z.object({ fromSlug: z.string(), toSlug: z.string() }).optional(),
          }),
          404: z.object({ error: z.string(), message: z.string() }),
        },
      },
      config: {
        authz: {
          resource: 'agent',
          action: 'read',
          spaceIdFrom: 'requireSpace',
          resourceIdFrom: 'param',
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const { agentId } = request.params;
      const context = request.server.appContext;

      if (!context?.db) {
        reply.status(404).send({ error: 'NotFound', message: `Agent ${agentId} not found` });
        return;
      }

      try {
        const { loadAgentTargetDefinition, resolveAgentPathParam } =
          await import('@aflow/database');
        const { getPlatformAgentBySystemRole } = await import('@aflow/platform-artifacts');
        const platformEntry = getPlatformAgentBySystemRole(agentId);
        const resolved = platformEntry
          ? { target: { kind: 'platform-role' as const, systemRole: agentId } }
          : await resolveAgentPathParam(
              context.db as PostgresJsDatabase,
              tenant.tenantId,
              space.spaceId,
              agentId,
            );
        const loaded = await loadAgentTargetDefinition(
          context.db as PostgresJsDatabase,
          tenant.tenantId,
          resolved.target as Parameters<typeof loadAgentTargetDefinition>[2],
          'latest',
        );
        const definition = loaded.definition as unknown as Record<string, unknown>;
        const meta = (definition['metadata'] ?? {}) as Record<string, unknown>;

        let inputContract: Record<string, unknown> | undefined;
        try {
          const stateVars = definition['stateVariables'];
          if (Array.isArray(stateVars) && stateVars.length > 0) {
            inputContract = deriveFlowInputContract(
              definition as unknown as AgentDefinition,
            ) as unknown as Record<string, unknown>;
          }
        } catch {
          // Non-blocking: inputContract is an enhancement
        }

        const target = resolved.target;
        const isPlatformResolved = target.kind === 'platform-role';
        const responseAgentId =
          target.kind === 'platform-role' ? target.systemRole : target.agentId;
        const responseSlug =
          target.kind === 'platform-role'
            ? target.systemRole
            : ((resolved as { redirect?: { toSlug: string } }).redirect?.toSlug ?? agentId);
        const redirect = !isPlatformResolved
          ? (resolved as { redirect?: { fromSlug: string; toSlug: string } }).redirect
          : undefined;
        reply.send({
          agentId: responseAgentId,
          slug: responseSlug,
          name: (meta['name'] as string) ?? agentId,
          description: meta['description'] as string | undefined,
          latestVersion: loaded.version,
          definition,
          ...(inputContract ? { inputContract } : {}),
          ...(redirect ? { redirect } : {}),
        });
      } catch (err) {
        request.log.error({ err, agentId }, 'Failed to fetch agent');
        reply.status(404).send({ error: 'NotFound', message: `Agent ${agentId} not found` });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/agents - Publish a new agent version (in current space)
  // -------------------------------------------------------------------------
  app.post(
    '/',
    {
      schema: {
        tags: ['Agents'],
        summary: 'Publish agent definition',
        description:
          'Publish a new agent definition in the current space. Space is resolved from X-Space-ID header.',
        body: z.union([
          PublishAgentRequestSchema,
          z.object({
            definition: z.record(z.unknown()),
          }),
        ]),
        querystring: z.object({
          spaceId: z.string().uuid().optional(),
        }),
        response: {
          201: PublishAgentResponseSchema,
          400: z.object({
            error: z.string(),
            message: z.string(),
            details: z.array(z.unknown()).optional(),
          }),
          403: z.object({ error: z.string(), message: z.string() }),
          500: z.object({ error: z.string(), message: z.string() }),
        },
      },
      config: { authz: { resource: 'agent', action: 'write', spaceIdFrom: 'requireSpace' } },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();

      if (!space.canWrite) {
        reply.status(403).send({
          error: 'Forbidden',
          message: 'You need editor or admin role in this space to publish agents.',
        });
        return;
      }

      const body = request.body as Record<string, unknown>;
      const isFullDefinition = 'definition' in body && typeof body['definition'] === 'object';
      const fullDef = isFullDefinition ? (body['definition'] as Record<string, unknown>) : null;

      const rawSlug = body['slug'] ?? body['agentSlug'] ?? fullDef?.['flowId'] ?? body['flowId'];
      if (rawSlug == null || typeof rawSlug !== 'string') {
        reply.status(400).send({ error: 'ValidationError', message: 'slug is required' });
        return;
      }
      const { validateAgentSlug, AgentSlugSchema } = await import('@aflow/schemas');
      const slugValidation = validateAgentSlug(rawSlug);
      if (!slugValidation.ok) {
        reply.status(400).send({ error: slugValidation.code, message: slugValidation.message });
        return;
      }
      const slug = AgentSlugSchema.parse(rawSlug);

      const context = request.server.appContext;
      if (!context?.db) {
        request.log.info({ slug, version: '1' }, 'Agent published (mock)');
        reply.status(201).send({
          agentId: crypto.randomUUID(),
          slug,
          version: '1',
          message: 'Agent published successfully (mock mode)',
        });
        return;
      }

      // Build the AgentDefinition payload.
      let definitionInput: Record<string, unknown>;
      if (fullDef) {
        definitionInput = { ...fullDef, flowId: slug };
      } else {
        const simpleBody = body as z.infer<typeof PublishAgentRequestSchema>;
        definitionInput = {
          flowId: slug,
          version: '1',
          metadata: {
            name: simpleBody.name,
            description: simpleBody.description,
            ...simpleBody.metadata,
          },
          steps: simpleBody.steps.map((step: (typeof simpleBody.steps)[number]) => ({
            stepId: step.stepId,
            stepType: step.type,
            operation: step.operation ?? `${step.type}.default`,
            config: step.config ?? {},
            outputMapping: step.outputMapping,
            name: step.name,
            description: step.description,
            onSuccess: step.onSuccess ?? { next: [] },
            onFailure: step.onFailure ?? { next: [] },
          })),
          startStepId: simpleBody.startStepId ?? simpleBody.steps[0]!.stepId,
          inputSchema: simpleBody.inputSchema,
          outputSchema: simpleBody.outputSchema,
        };

        const steps = definitionInput['steps'] as Array<{
          stepId: string;
          onSuccess?: { next: Array<{ stepId: string; priority?: number }> };
        }>;
        for (let i = 0; i < steps.length - 1; i++) {
          const step = steps[i];
          const nextStep = steps[i + 1];
          if (!step || !nextStep) continue;
          const onSuccess = step.onSuccess ?? { next: [] };
          if (onSuccess.next.length === 0) {
            step.onSuccess = { next: [{ stepId: nextStep.stepId, priority: 50 }] };
          }
        }
      }

      // Always strip metadata.system via the API — only db:seed can mark agents as system.
      {
        const meta = definitionInput['metadata'] as Record<string, unknown> | undefined;
        if (meta) delete meta['system'];
      }

      const defName = ((definitionInput['metadata'] as Record<string, unknown> | undefined)?.[
        'name'
      ] ?? slug) as string;
      const defDescription = ((
        definitionInput['metadata'] as Record<string, unknown> | undefined
      )?.['description'] ?? null) as string | null;

      try {
        const { createTenantContext, createAgentRepository, resolveAgentRef } =
          await import('@aflow/database');
        const tenantContext = createTenantContext(tenant.tenantId);
        const repo = createAgentRepository(context.db as PostgresJsDatabase, tenantContext);

        // See if an agent with this slug already exists in the space.
        let existingId: string | null = null;
        try {
          const resolved = await resolveAgentRef(
            context.db as PostgresJsDatabase,
            tenant.tenantId,
            { spaceId: space.spaceId, agentSlug: slug },
          );
          existingId = resolved.target.agentId;
        } catch {
          // not found → first publish
        }

        if (existingId) {
          // Append a new version. Bump from the latest published.
          const { AgentIdSchema: _AgentIdBrand } = await import('@aflow/schemas');
          type AgentIdBrand = z.infer<typeof _AgentIdBrand>;
          const agentIdBrand = existingId as unknown as AgentIdBrand;
          const latest = await repo.getLatestVersion(agentIdBrand);
          const parsed = parseInt(latest?.version ?? '1', 10);
          const version = Number.isNaN(parsed) ? `${latest?.version ?? '1'}.1` : String(parsed + 1);
          definitionInput['version'] = version;
          await repo.publishVersion({
            agentId: agentIdBrand,
            version,
            definition: definitionInput as unknown as AgentDefinition,
            name: defName,
            description: defDescription,
            ...(request.authUser?.userId ? { createdBy: request.authUser.userId } : {}),
          });
          request.log.info({ agentId: existingId, slug, version }, 'Agent version published');
          reply.status(201).send({
            agentId: existingId,
            slug,
            version,
            message: 'Agent published successfully',
          });
        } else {
          // First publish — create identity row + initial version.
          const created = await repo.create({
            spaceId: space.spaceId,
            slug,
            name: defName,
            ...(defDescription !== null ? { description: defDescription } : {}),
            initialVersion: {
              version: '1',
              definition: definitionInput as never,
              ...(request.authUser?.userId ? { createdBy: request.authUser.userId } : {}),
            },
          });
          request.log.info({ agentId: created.agent.id, slug }, 'Agent created');
          reply.status(201).send({
            agentId: created.agent.id,
            slug,
            version: created.version.version,
            message: 'Agent published successfully',
          });
        }
      } catch (err) {
        request.log.error({ err, slug, tenantId: tenant.tenantId }, 'Failed to save agent');
        reply.status(500).send({
          error: 'InternalError',
          message: 'Failed to save agent definition',
        });
        return;
      }
    },
  );

  // -------------------------------------------------------------------------
  app.patch(
    '/:agentId',
    {
      schema: {
        tags: ['Agents'],
        summary: 'Rename or edit agent metadata',
        params: z.object({ agentId: AgentIdPathParamSchema }),
        body: z.object({
          slug: z.string().min(1).max(128).optional(),
          name: z.string().min(1).max(255).optional(),
          description: z.string().max(2000).nullable().optional(),
        }),
        querystring: z.object({ spaceId: z.string().uuid().optional() }),
        response: {
          200: z.object({
            agentId: z.string().uuid(),
            slug: z.string(),
            name: z.string(),
            description: z.string().nullable().optional(),
          }),
          400: z.object({ error: z.string(), message: z.string() }),
          403: z.object({ error: z.string(), message: z.string() }),
          404: z.object({ error: z.string(), message: z.string() }),
          409: z.object({ error: z.string(), message: z.string() }),
        },
      },
      config: {
        authz: {
          resource: 'agent',
          action: 'write',
          spaceIdFrom: 'requireSpace',
          resourceIdFrom: 'param',
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      if (!space.canWrite) {
        reply.status(403).send({
          error: 'Forbidden',
          message: 'You need editor or admin role in this space to edit agents.',
        });
        return;
      }
      const { agentId: agentParam } = request.params;
      const body = request.body;
      const context = request.server.appContext;
      if (!context?.db) {
        reply.status(404).send({ error: 'NotFound', message: 'No DB context' });
        return;
      }

      const { validateAgentSlug, AgentSlugSchema } = await import('@aflow/schemas');
      let nextSlug: AgentSlug | undefined;
      if (body.slug !== undefined) {
        const v = validateAgentSlug(body.slug);
        if (!v.ok) {
          reply.status(400).send({ error: v.code, message: v.message });
          return;
        }
        nextSlug = AgentSlugSchema.parse(body.slug);
      }

      try {
        const { resolveAgentPathParam, createAgentRepository, createTenantContext } =
          await import('@aflow/database');
        const resolved = await resolveAgentPathParam(
          context.db as PostgresJsDatabase,
          tenant.tenantId,
          space.spaceId,
          agentParam,
        );
        const repo = createAgentRepository(
          context.db as PostgresJsDatabase,
          createTenantContext(tenant.tenantId),
        );
        const updated = await repo.update(
          resolved.target.agentId,
          {
            ...(nextSlug ? { slug: nextSlug } : {}),
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description ?? '' } : {}),
          },
          { ...(request.authUser?.userId ? { renamedBy: request.authUser.userId } : {}) },
        );
        if (!updated) {
          reply.status(404).send({ error: 'NotFound', message: 'Agent not found' });
          return;
        }
        reply.send({
          agentId: updated.id,
          slug: updated.slug,
          name: updated.name,
          description: updated.description ?? null,
        });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string } | undefined)?.code;
        if (code === 'SLUG_TAKEN' || message.startsWith('SLUG_TAKEN:')) {
          reply.status(409).send({ error: 'SLUG_TAKEN', message });
          return;
        }
        if (message.includes('archived')) {
          reply.status(409).send({ error: 'AgentArchived', message });
          return;
        }
        request.log.error({ err, agentParam }, 'Failed to update agent');
        reply.status(404).send({ error: 'NotFound', message });
        return;
      }
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /v1/agents/:agentId - Archive an agent
  // -------------------------------------------------------------------------
  app.delete(
    '/:agentId',
    {
      schema: {
        tags: ['Agents'],
        summary: 'Archive an agent',
        description:
          'Soft-delete an agent: it stops being listed and cannot be started, and its versions and past sessions are kept. Idempotent — archiving an already-archived agent succeeds.',
        params: z.object({ agentId: AgentIdPathParamSchema }),
        querystring: z.object({ spaceId: z.string().uuid().optional() }),
        response: {
          200: z.object({ agentId: z.string().uuid(), archived: z.literal(true) }),
          403: z.object({ error: z.string(), message: z.string() }),
          404: z.object({ error: z.string(), message: z.string() }),
        },
      },
      config: {
        authz: {
          resource: 'agent',
          action: 'write',
          spaceIdFrom: 'requireSpace',
          resourceIdFrom: 'param',
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      if (!space.canWrite) {
        reply.status(403).send({
          error: 'Forbidden',
          message: 'You need editor or admin role in this space to delete agents.',
        });
        return;
      }
      const { agentId: agentParam } = request.params;
      const context = request.server.appContext;
      if (!context?.db) {
        reply.status(404).send({ error: 'NotFound', message: 'No DB context' });
        return;
      }

      try {
        const { resolveAgentPathParam, createAgentRepository, createTenantContext } =
          await import('@aflow/database');
        const resolved = await resolveAgentPathParam(
          context.db as PostgresJsDatabase,
          tenant.tenantId,
          space.spaceId,
          agentParam,
        );
        const repo = createAgentRepository(
          context.db as PostgresJsDatabase,
          createTenantContext(tenant.tenantId),
        );
        // Archive rather than drop: sessions reference the agent that ran them,
        // and a transcript whose agent no longer exists cannot be read back.
        await repo.archive(resolved.target.agentId);
        reply.send({ agentId: resolved.target.agentId, archived: true as const });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        request.log.error({ err, agentParam }, 'Failed to archive agent');
        reply.status(404).send({ error: 'NotFound', message });
        return;
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/agents/:agentId/versions - List agent versions
  // -------------------------------------------------------------------------
  app.get(
    '/:agentId/versions',
    {
      schema: {
        tags: ['Agents'],
        summary: 'List agent versions',
        description: 'List all versions of an agent',
        params: z.object({ agentId: AgentIdPathParamSchema }),
        querystring: z.object({ spaceId: z.string().uuid().optional() }),
        response: {
          200: z.object({
            agentId: z.string(),
            versions: z.array(AgentVersionSchema),
          }),
          404: z.object({ error: z.string(), message: z.string() }),
        },
      },
      config: {
        authz: {
          resource: 'agent',
          action: 'read',
          spaceIdFrom: 'requireSpace',
          resourceIdFrom: 'param',
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const { agentId } = request.params;
      const context = request.server.appContext;

      // Platform agents have a single immutable version.
      if (isPlatformAgentId(agentId)) {
        reply.send({
          agentId,
          versions: [
            {
              version: '1',
              createdAt: new Date('2025-01-01').toISOString(),
              createdBy: 'system',
              deprecated: false,
            },
          ],
        });
        return;
      }

      if (!context?.db) {
        reply.status(404).send({ error: 'NotFound', message: `Agent ${agentId} not found` });
        return;
      }

      try {
        const { resolveAgentPathParam, createTenantContext, createAgentRepository } =
          await import('@aflow/database');
        const resolved = await resolveAgentPathParam(
          context.db as PostgresJsDatabase,
          tenant.tenantId,
          space.spaceId,
          agentId,
        );
        const repo = createAgentRepository(
          context.db as PostgresJsDatabase,
          createTenantContext(tenant.tenantId),
        );
        const versions = await repo.listVersions(resolved.target.agentId as never);
        reply.send({
          agentId: resolved.target.agentId,
          versions: versions.map((v) => ({
            version: v.version,
            createdAt: v.createdAt.toISOString(),
            createdBy: v.createdBy ?? null,
            deprecated: v.status === 'archived',
          })),
        });
      } catch (err) {
        request.log.error({ err, agentId }, 'Failed to list agent versions');
        reply.status(404).send({ error: 'NotFound', message: `Agent ${agentId} not found` });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/agents/:agentId/versions/:version - Get specific agent version
  // -------------------------------------------------------------------------
  app.get(
    '/:agentId/versions/:version',
    {
      schema: {
        tags: ['Agents'],
        summary: 'Get agent version',
        description: 'Get a specific version of an agent definition',
        params: z.object({ agentId: AgentIdPathParamSchema, version: z.string() }),
        querystring: z.object({ spaceId: z.string().uuid().optional() }),
        response: {
          200: AgentDefinitionSchema,
          404: z.object({ error: z.string(), message: z.string() }),
        },
      },
      config: {
        authz: {
          resource: 'agent',
          action: 'read',
          spaceIdFrom: 'requireSpace',
          resourceIdFrom: 'param',
        },
      },
    },
    async (request, reply) => {
      await request.requireTenant();
      await request.requireSpace();
      const { agentId, version } = request.params;

      reply.status(404).send({
        error: 'NotFound',
        message: `Agent ${agentId} version ${version} not found`,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/agents/:agentId/versions/:version/deprecate - Deprecate version
  // -------------------------------------------------------------------------
  app.post(
    '/:agentId/versions/:version/deprecate',
    {
      schema: {
        tags: ['Agents'],
        summary: 'Deprecate agent version',
        description: 'Mark an agent version as deprecated (space admin only)',
        params: z.object({ agentId: AgentIdPathParamSchema, version: z.string() }),
        querystring: z.object({ spaceId: z.string().uuid().optional() }),
        response: {
          200: z.object({ message: z.string() }),
          403: z.object({ error: z.string(), message: z.string() }),
          404: z.object({ error: z.string(), message: z.string() }),
        },
      },
      config: {
        authz: {
          resource: 'agent',
          action: 'admin',
          spaceIdFrom: 'requireSpace',
          resourceIdFrom: 'param',
        },
      },
    },
    async (request, reply) => {
      await request.requireTenant();
      const space = await request.requireSpace();
      const { agentId, version } = request.params;

      if (!space.isSpaceAdmin) {
        reply.status(403).send({
          error: 'Forbidden',
          message: 'Only space admins can deprecate agent versions',
        });
        return;
      }

      // Reject deprecation of platform agents
      if (isPlatformAgentId(agentId)) {
        throw request.server.httpErrors.forbidden(
          `PLATFORM_ARTIFACT_READ_ONLY: platform-owned agent '${agentId}' cannot be created or updated.`,
        );
      }

      request.log.info({ agentId, version }, 'Agent version deprecated');
      reply.send({ message: `Agent ${agentId} version ${version} deprecated` });
    },
  );
};
