/**
 * Catalog endpoints - step types, operations, and models.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  AIProviderSchema,
  createDefaultModelCatalog,
  effectiveModelPricing,
  retiredRefsFor,
  type ModelDefinition,
} from '@aflow/ai-client';
import { isRecommendedAgentModelRef } from '@aflow/schemas';
import {
  getOperationCatalog,
  getAllOperations,
  STEP_TYPE_DESCRIPTIONS,
} from '@aflow/schemas/catalog';

// ============================================================================
// Schemas
// ============================================================================

const StepTypeSchema = z.object({
  type: z.string(),
  displayName: z.string(),
  description: z.string(),
  category: z.enum(['control', 'ai', 'integration', 'data', 'user', 'other']),
  operations: z.array(z.string()),
  inputSchema: z.record(z.unknown()).optional(),
  outputSchema: z.record(z.unknown()).optional(),
});

const OperationSchema = z.object({
  operationId: z.string(),
  stepType: z.string(),
  displayName: z.string(),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()).optional(),
  /** Step config schema — superset of inputSchema for flow-editor config fields */
  stepConfigSchema: z.record(z.unknown()).optional(),
  sideEffects: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
  allowedModels: z.array(z.string()).optional(),
  /** Fields that are orchestrator-managed and hidden from the flow editor UI */
  internalFields: z
    .object({
      input: z.array(z.string()).optional(),
      output: z.array(z.string()).optional(),
    })
    .optional(),
  /** If false, structural runtime primitive — not available as an agent tool */
  agentTool: z.boolean().optional(),
});

const ModelSchema = z.object({
  modelId: z.string(),
  provider: AIProviderSchema,
  displayName: z.string(),
  description: z.string().optional(),
  contextWindow: z.number().int().nonnegative(), // 0 for image/video-only models
  maxOutputTokens: z.number().int().nonnegative(),
  capabilities: z.object({
    chat: z.boolean(),
    completion: z.boolean(),
    embedding: z.boolean(),
    vision: z.boolean(),
    audio: z.boolean(),
    functionCalling: z.boolean(),
    jsonMode: z.boolean(),
    streaming: z.boolean(),
    // New 2026 capabilities
    reasoning: z.boolean().optional(),
    toolInCoT: z.boolean().optional(),
    structuredOutputs: z.boolean().optional(),
    codeInterpreter: z.boolean().optional(),
    webSearch: z.boolean().optional(),
    imageGeneration: z.boolean().optional(),
    videoGeneration: z.boolean().optional(),
    decision: z.boolean().optional(),
  }),
  pricing: z.object({
    promptPer1M: z.number().nonnegative(),
    completionPer1M: z.number().nonnegative(),
    imagePerImage: z.number().nonnegative().optional(),
    videoPerSecond: z.number().nonnegative().optional(),
    currency: z.string(),
  }),
  traits: z
    .object({
      speed: z.number().int().min(1).max(5).optional(),
      cost: z.number().int().min(1).max(5).optional(),
      intelligence: z.number().int().min(1).max(5).optional(),
      outputType: z.enum(['text', 'image', 'video', 'audio', 'embedding', 'decision']).optional(),
    })
    .optional(),
  deprecated: z.boolean().optional(),
  aliases: z.array(z.string()).optional(),
  /** Ids that named this model before their own entry retired into it. */
  retiredRefs: z.array(z.string()).optional(),
  /**
   * Which reasoning efforts this model accepts. Absent on models that take no
   * reasoning config. A picker that offers a rung outside `supported` is
   * offering a combination the provider rejects at call time.
   */
  reasoning: z
    .object({
      supported: z.array(z.enum(['off', 'low', 'medium', 'high'])),
      default: z.enum(['off', 'low', 'medium', 'high']).optional(),
    })
    .optional(),
});

// ============================================================================
// Routes
// ============================================================================

function toDisplayName(stepType: string): string {
  // "ai" -> "AI", "flow_control" -> "Flow Control"
  if (stepType.toLowerCase() === 'ai') return 'AI';
  return stepType
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => (w[0]?.toUpperCase() ?? '') + w.slice(1))
    .join(' ');
}

// STEP_TYPE_DESCRIPTIONS imported from @aflow/schemas/catalog (single source of truth)

function toCategory(stepType: string): z.infer<typeof StepTypeSchema>['category'] {
  // NOTE: This is intentionally small and stable. Operations themselves are
  // sourced dynamically from the schema registry; only presentation metadata
  // is mapped here.
  switch (stepType) {
    case 'ai':
      return 'ai';
    case 'memory':
    case 'compute':
      return 'data';
    case 'api':
    case 'mcp':
      return 'integration';
    case 'user':
      return 'user';
    case 'agent':
    case 'catalog':
    case 'space':
      return 'control';
    case 'workflow':
    case 'eval':
    case 'guardrail':
    case 'ui':
    case 'search':
      return 'other';
    default:
      return 'other';
  }
}

export const catalogRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.addHook('preHandler', app.authenticate);

  // -------------------------------------------------------------------------
  // GET /v1/catalog/step-types - List step types
  // -------------------------------------------------------------------------
  app.get(
    '/step-types',
    {
      config: { public: true },
      schema: {
        tags: ['Catalog'],
        summary: 'List step types',
        description: 'List all available step types',
        response: {
          200: z.object({
            stepTypes: z.array(StepTypeSchema),
          }),
        },
      },
    },
    async (_request, reply) => {
      // Single source of truth: generated from the schemas registry.
      const catalog = getOperationCatalog({ includeOutputSchema: false });

      const grouped = new Map<string, string[]>();
      for (const op of catalog.operations) {
        const list = grouped.get(op.stepType) ?? [];
        list.push(op.operationId);
        grouped.set(op.stepType, list);
      }

      const stepTypes: Array<z.infer<typeof StepTypeSchema>> = [...grouped.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([stepType, ops]) => ({
          type: stepType,
          displayName: toDisplayName(stepType),
          description: STEP_TYPE_DESCRIPTIONS[stepType] ?? `${toDisplayName(stepType)} operations`,
          category: toCategory(stepType),
          operations: ops.sort(),
        }));

      reply.send({ stepTypes });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/catalog/operations - List operations
  // -------------------------------------------------------------------------
  app.get(
    '/operations',
    {
      config: { public: true },
      schema: {
        tags: ['Catalog'],
        summary: 'List operations',
        description: 'List all available operations with their schemas',
        querystring: z.object({
          stepType: z.string().optional(),
        }),
        response: {
          200: z.object({
            operations: z.array(OperationSchema),
          }),
        },
      },
    },
    async (request, reply) => {
      const { stepType } = request.query;

      // Single source of truth: generated from the schemas registry.
      const catalog = getOperationCatalog({
        includeOutputSchema: true,
        ...(stepType ? { stepTypes: [stepType] } : {}),
      });

      const registry = getAllOperations();
      const operations: Array<z.infer<typeof OperationSchema>> = catalog.operations.map((op) => {
        const desc = registry.get(op.operationId);
        return {
          operationId: op.operationId,
          stepType: op.stepType,
          displayName: op.name,
          description: op.semanticDescription,
          inputSchema: op.inputSchema,
          outputSchema: op.outputSchema,
          ...(op.stepConfigSchema ? { stepConfigSchema: op.stepConfigSchema } : {}),
          ...(op.internalFields ? { internalFields: op.internalFields } : {}),
          ...(desc && !desc.agentTool ? { agentTool: false } : {}),
        };
      });

      reply.send({ operations });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/catalog/models - List AI models
  // -------------------------------------------------------------------------
  /**
   * The platform's default discovery set for a cybernetic role. This is
   * configuration, not session state: an operator editing a space needs the
   * default they are about to override, and there is no run to read it from.
   */
  app.get(
    '/agents/:role/discovery',
    {
      config: { public: true },
      schema: {
        tags: ['Catalog'],
        summary: 'Platform discovery set for a cybernetic role',
        description:
          'The operation ids a platform role may add to its own toolbox by default. A space can override this via directives.capabilityDiscovery.',
        params: z.object({ role: z.enum(['helmsman']) }),
        response: {
          200: z.object({
            role: z.literal('helmsman'),
            allowedOperationIds: z.array(z.string()),
          }),
        },
      },
    },
    async (request, reply) => {
      const { role } = request.params as { role: 'helmsman' };
      const { HELMSMAN_DISCOVERY_PRESET } = await import('@aflow/platform-artifacts');
      reply.send({ role, allowedOperationIds: [...HELMSMAN_DISCOVERY_PRESET] });
    },
  );

  /**
   * The capability bundles a role's surface actually reaches, each with the
   * per-turn token cost of the pinned tools it carries.
   *
   * The cost is computed here rather than in the client because it is the cost
   * of the EMITTED schema — the same prune the turn assembler applies — and a
   * client estimate would drift from what actually goes on the wire, which is
   * the one number this control exists to show.
   */
  app.get(
    '/agents/:role/bundles',
    {
      config: { public: true },
      schema: {
        tags: ['Catalog'],
        summary: 'Capability bundles offered to a cybernetic role',
        description:
          'Bundles this role can reach, with the per-turn token cost of the tools each pins. Locked bundles cannot be shed.',
        params: z.object({ role: z.enum(['helmsman']) }),
        response: {
          200: z.object({
            role: z.literal('helmsman'),
            bundles: z.array(
              z.object({
                id: z.string(),
                label: z.string(),
                hint: z.string(),
                tier: z.enum(['loaded', 'on_demand']),
                lockedReason: z.string().optional(),
                defaultPlacement: z.enum(['always_on', 'on_demand', 'off']),
                /** Per-turn cost if this bundle is always_on. */
                alwaysOnTokens: z.number(),
                operationCount: z.number(),
                /**
                 * What the bundle contributes while it sits at its authored
                 * default — only the operations the definition pins. Differs
                 * from `alwaysOnTokens` for a bundle whose operations are
                 * authored across both tiers.
                 */
                authoredPinnedTokens: z.number(),
                authoredPinnedCount: z.number(),
              }),
            ),
          }),
        },
      },
    },
    async (request, reply) => {
      const { role } = request.params as { role: 'helmsman' };
      const { CYBERNETIC_AGENTS } = await import('@aflow/platform-artifacts');
      const {
        bundlesForSurface,
        bundleForOperation,
        getOperation,
        toJsonSchemaSync,
        pruneSchemaForAgent,
        estimateStringTokens,
        effectivePlacement,
      } = await import('@aflow/schemas');

      const helmsman = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-helmsman');
      const catalog = (
        helmsman?.steps.find((s) => s['operation'] === 'ai.agent.turn')?.['config'] as
          | {
              catalog?: {
                coreOperations?: string[];
                discovery?: { allowedOperationIds?: string[] };
              };
            }
          | undefined
      )?.catalog;
      const coreOperations = catalog?.coreOperations ?? [];
      const surface = [...coreOperations, ...(catalog?.discovery?.allowedOperationIds ?? [])];

      const tokensByBundle = new Map<string, { tokens: number; count: number }>();
      for (const opId of coreOperations) {
        const op = getOperation(opId);
        const bundle = bundleForOperation(opId);
        if (!op || !bundle) continue;
        const emitted = JSON.stringify({
          name: opId,
          description: op.semanticDescription,
          input_schema: pruneSchemaForAgent(
            toJsonSchemaSync(op.inputZod) as Record<string, unknown>,
          ),
        });
        const prior = tokensByBundle.get(bundle.id) ?? { tokens: 0, count: 0 };
        tokensByBundle.set(bundle.id, {
          tokens: prior.tokens + estimateStringTokens(emitted),
          count: prior.count + 1,
        });
      }

      // What each bundle costs when pinned, measured rather than assumed: the
      // panel has to quote the real per-turn figure for a placement the
      // operator has not made yet.
      const costOf = (ops: readonly string[]): number =>
        ops.reduce((sum, opId) => {
          const op = getOperation(opId);
          if (!op) return sum;
          return (
            sum +
            estimateStringTokens(
              JSON.stringify({
                name: opId,
                description: op.semanticDescription,
                input_schema: pruneSchemaForAgent(
                  toJsonSchemaSync(op.inputZod) as Record<string, unknown>,
                ),
              }),
            )
          );
        }, 0);

      const bundles = bundlesForSurface(surface).map((b) => {
        // Everything this bundle owns inside the agent's authored authority —
        // which is exactly what `always_on` would pin, since placement never
        // widens beyond the ceiling.
        const owned = surface.filter((opId) => bundleForOperation(opId)?.id === b.id);
        const authoredPinned = coreOperations.filter(
          (opId) => bundleForOperation(opId)?.id === b.id,
        );
        return {
          id: b.id,
          label: b.label,
          hint: b.hint,
          tier: b.tier,
          ...(b.locked ? { lockedReason: b.locked.reason } : {}),
          defaultPlacement: effectivePlacement(b, undefined),
          alwaysOnTokens: costOf(owned),
          operationCount: owned.length,
          authoredPinnedTokens: costOf(authoredPinned),
          authoredPinnedCount: authoredPinned.length,
        };
      });

      reply.send({ role, bundles });
    },
  );

  app.get(
    '/models',
    {
      config: { public: true },
      schema: {
        tags: ['Catalog'],
        summary: 'List AI models',
        description: 'List available AI models with capabilities and pricing',
        querystring: z.object({
          provider: AIProviderSchema.optional(),
          capability: z.string().optional(),
          set: z.enum(['agent']).optional(),
        }),
        response: {
          200: z.object({
            models: z.array(ModelSchema),
          }),
        },
      },
    },
    async (request, reply) => {
      const { provider, capability, set } = request.query;

      const catalog = createDefaultModelCatalog();

      /** Strip keys with `undefined` values (fast-json-stringify rejects them). */
      const clean = <T>(obj: T): T =>
        Object.fromEntries(
          Object.entries(obj as Record<string, unknown>).filter(([, v]) => v !== undefined),
        ) as T;

      const toApiModel = (m: ModelDefinition): z.infer<typeof ModelSchema> => {
        const pricing = effectiveModelPricing(m.pricing);
        return clean({
          modelId: m.id,
          provider: m.provider,
          displayName: m.displayName,
          description: m.description,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
          capabilities: clean(m.capabilities),
          // The rates in force now, not the ones the entry was written with:
          // a model on introductory pricing would otherwise keep advertising
          // the promotional number after billing had moved on.
          pricing: clean({
            promptPer1M: pricing.promptPer1M,
            completionPer1M: pricing.completionPer1M,
            imagePerImage: pricing.imagePerImage,
            videoPerSecond: pricing.videoPerSecond,
            currency: pricing.currency,
          }),
          traits: m.traits ? clean(m.traits) : undefined,
          deprecated: m.deprecated,
          aliases: m.aliases,
          retiredRefs: retiredRefsFor(m.id),
          reasoning: m.reasoning
            ? clean({ supported: [...m.reasoning.supported], default: m.reasoning.default })
            : undefined,
        }) as z.infer<typeof ModelSchema>;
      };

      // Get models, optionally filtered by provider
      let catalogModels = catalog.listModels(provider);

      // Filter by capability if specified
      if (capability) {
        catalogModels = catalogModels.filter((m) => {
          const caps = m.capabilities as unknown as Record<string, boolean>;
          return caps[capability] === true;
        });
      }

      // The platform recommendation, not what a given tenant allows — this
      // route is unauthenticated and has no tenant to answer for. A surface
      // picking a model for a cybernetic role reads GET /v1/tenant/agent-models.
      if (set === 'agent') {
        catalogModels = catalogModels.filter((m) => isRecommendedAgentModelRef(m.id));
      }

      const models = catalogModels.map(toApiModel);

      reply.send({ models });
    },
  );
};
