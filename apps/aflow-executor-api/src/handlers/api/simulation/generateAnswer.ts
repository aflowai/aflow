/**
 * Rung 3's executor half — the model access the simulator deliberately has no
 * way to reach for itself.
 *
 * A simulation declares no model, so access resolves user → space → tenant
 * through BYOK with no environment-key fallback: a space that has connected no
 * provider cannot generate, rather than quietly spending a platform key on a
 * mock.
 *
 * The answer's shape is carried by the request. `ask.outputSchema` inlines the
 * endpoint's own success schema and each collection's entity schema, and it is
 * sent as the provider's structured-output constraint — so the contract holds
 * by construction instead of by prose the model weighs against everything else
 * in the prompt.
 */
import { z } from 'zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AIClient } from '@aflow/ai-client';
import {
  createByokAiClientFactory,
  ByokCredentialError,
  type ByokAiClientFactory,
  type ByokClientContext,
} from '@aflow/credential-resolver';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type {
  GeneratedAnswer,
  GenerateSimulatedAnswer,
  GenerationAsk,
  GenerationCallSummary,
  WorldMutation,
  WorldSlice,
} from '@aflow/integration-simulator';
import { SimulationGenerationUnavailableError } from '@aflow/integration-simulator';
import { TEXT_MODELS } from '@aflow/schemas';
import type { StepUsageBreakdown } from '@aflow/schemas';
import { apiError } from '../../../lib/api-errors.js';
import { ApiExecutionError } from '../types.js';

/**
 * The envelope narrowing, and only that — `validateGeneratedAnswer` holds the
 * answer to the endpoint's and the collections' schemas afterwards. It is
 * needed because an adapter given a raw JSON Schema does not run the Zod one:
 * the OpenAI path casts the parsed JSON straight to `T`.
 */
const GeneratedAnswerSchema = z.object({
  body: z.unknown(),
  mutations: z
    .array(
      z.object({
        collection: z.string().min(1),
        op: z.enum(['create', 'update', 'delete']),
        entityId: z.string().min(1),
        body: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .default([]),
});

/**
 * A preference, not a pin: `resolveGenerationModel` returns one only if the
 * space can resolve a credential for it, so a space on another provider still
 * generates instead of failing after the agent committed to the call.
 */
const DEFAULT_SIMULATION_MODEL = 'anthropic-sonnet';

/** Low, because the answer is a fixture rather than prose. */
const GENERATION_TEMPERATURE = 0.2;
/**
 * Headroom, because reasoning and the answer draw on one budget. At a ceiling
 * the thinking alone can reach, the call returns no tool use at all rather
 * than a short answer.
 */
const GENERATION_MAX_TOKENS = 32_000;

/**
 * Stated, not inherited — on a model whose thinking is adaptive by omission,
 * leaving it unset is not the same as choosing it. An answer over a world is a
 * reconciliation, and a model that does not reason reports rows correctly and
 * then totals them wrong.
 */
const GENERATION_REASONING = { effort: 'low' } as const;

/**
 * The factory holds a provider-client cache keyed on credential identity, so
 * rebuilding it per call would throw that cache away every time.
 */
let cachedFactory: { db: PostgresJsDatabase; factory: ByokAiClientFactory } | null = null;

function byokFactory(db: PostgresJsDatabase): ByokAiClientFactory {
  if (cachedFactory?.db === db) return cachedFactory.factory;
  const factory = createByokAiClientFactory(db);
  cachedFactory = { db, factory };
  return factory;
}

function byokContext(ctx: ExecutorContext): ByokClientContext {
  const job = ctx.job as { spaceId?: string; credentialOwnerId?: string };
  return {
    tenantId: ctx.tenantId as string,
    spaceId: job.spaceId ?? '',
    ...(job.credentialOwnerId ? { credentialOwnerId: job.credentialOwnerId } : {}),
  };
}

/**
 * The model this simulation generates on, in preference order: the one the run
 * pinned, the one the agent making the call is itself running on, the
 * operator's process-wide override, this rung's default, then anything else
 * the space holds a credential for. Every candidate is probed before it is
 * returned, so a call fails only when the space has no usable provider at all
 * — a setup problem an operator can act on rather than a surprise mid-run.
 */
export async function resolveGenerationModel(
  factory: ByokAiClientFactory,
  ctx: ExecutorContext,
  candidates: ReadonlyArray<string | undefined>,
): Promise<string | null> {
  const seen = new Set<string>();
  const byok = byokContext(ctx);
  for (const candidate of [...candidates, ...TEXT_MODELS]) {
    if (candidate === undefined || candidate.length === 0 || seen.has(candidate)) continue;
    seen.add(candidate);
    if (await factory.canResolveModel(candidate, byok)) return candidate;
  }
  return null;
}

/**
 * The named model, or a refusal.
 *
 * Silently substituting another model is the one thing a pin may not do: the
 * journal records `modelRef`, so a substituted answer is recorded as having
 * come from a model that never saw the request, and two runs meant to be
 * compared differ for a reason neither transcript shows.
 */
async function pinnedGenerationModel(
  factory: ByokAiClientFactory,
  ctx: ExecutorContext,
  modelRef: string,
  simulationId: string,
): Promise<string> {
  if (await factory.canResolveModel(modelRef, byokContext(ctx))) return modelRef;
  throw new SimulationGenerationUnavailableError(
    simulationId,
    `Simulation "${simulationId}" pins generation to model "${modelRef}", which this space cannot resolve a credential for. A pinned model is not a preference — answering from a different one would record this run as having used "${modelRef}" when it did not. Connect that provider, or clear the simulation's generationModel to use whatever the space would use anyway.`,
  );
}

export interface GenerationBudget {
  /** The simulation's operator-set ceiling. */
  maxGeneratedCallsPerRun: number;
  /**
   * Claim one generated call against the ceiling, durably, and return how many
   * are now claimed — or `null` when the ceiling is already spent.
   *
   * Called BEFORE the model is dialled, because that is when the money is
   * committed. Counting the journal instead would let two concurrent calls both
   * see the same last slot: a record exists only after the call commits, which
   * is after the spend.
   */
  claimSlot: () => Promise<number | null>;
}

export interface GenerateSimulatedAnswerDeps {
  db: PostgresJsDatabase;
  simulationId: string;
  /** The model the run's pinned context names, when it names one. */
  modelRef?: string;
  budget: GenerationBudget;
}

export interface SimulationGenerator {
  /** The port the ladder calls when nothing declared can answer. */
  generate: GenerateSimulatedAnswer;
  /** What `generate` spent on this call, or undefined if it never dialled. */
  spend: () => StepUsageBreakdown | undefined;
}

function describeWorld(world: WorldSlice): string {
  if (world.collections.length === 0) return 'This simulation declares no collections.';
  return world.collections
    .map((slice) => {
      const bodies = (entities: ReadonlyArray<{ body: Record<string, unknown> }>): string =>
        JSON.stringify(entities.map((entity) => entity.body));
      return [
        `${slice.collection} (identity: ${slice.identityField})`,
        `  addressed by this call: ${bodies(slice.matched)}`,
        `  other rows${slice.truncated ? ', sampled — more exist' : ''}: ${bodies(slice.sample)}`,
      ].join('\n');
    })
    .join('\n');
}

function describePriorCalls(priorCalls: readonly GenerationCallSummary[]): string {
  if (priorCalls.length === 0) return 'None — this is the first call of the run.';
  return priorCalls.map((call) => `${call.endpointId} → ${String(call.status)}`).join(', ');
}

/**
 * The ontology only. Every constraint the answer must satisfy travels in
 * `ask.outputSchema`, which the provider enforces, so nothing here restates a
 * schema.
 */
function buildPrompt(ask: GenerationAsk): { system: string; user: string } {
  const system = [
    'You are the backend of the API described below. Answer this call as that service would,',
    'and state every change to the world your answer implies.',
    '',
    'The world you are shown is the truth. Never contradict a row it already holds, and never',
    'invent one where it shows the collection has none that match. `now` is the instant given',
    "below, never today's date. Earlier answers in this run are already true; stay consistent",
    'with them.',
  ].join('\n');

  const user = [
    `Domain brief:\n${ask.domainBrief.length > 0 ? ask.domainBrief : '(none given)'}`,
    ask.persona === undefined
      ? 'Caller: unauthenticated — it owns no rows in this world.'
      : `Caller: ${ask.persona.label ?? ask.persona.personaId} (${ask.persona.personaId})${
          ask.persona.brief === undefined ? '' : ` — ${ask.persona.brief}`
        }. Every persona-scoped row you were shown already belongs to them.`,
    `Endpoint: ${ask.endpoint.method} ${ask.endpoint.pathTemplate} — ${ask.endpoint.name}`,
    ask.endpoint.description !== undefined ? `About it: ${ask.endpoint.description}` : '',
    `Call: ${ask.request.method} ${ask.request.url}`,
    `Params: ${JSON.stringify(ask.request.params)}`,
    `Body: ${JSON.stringify(ask.request.body ?? null)}`,
    `World:\n${describeWorld(ask.world)}`,
    `Earlier calls this run: ${describePriorCalls(ask.priorCalls)}`,
    `now: ${new Date(ask.clockMs).toISOString()}`,
  ]
    .filter((line) => line.length > 0)
    .join('\n\n');

  return { system, user };
}

/** Sum of what one step spent, so a call that generated twice reports both. */
function accumulate(
  total: StepUsageBreakdown | undefined,
  next: StepUsageBreakdown,
): StepUsageBreakdown {
  if (total === undefined) return next;
  return {
    ...total,
    promptTokens: total.promptTokens + next.promptTokens,
    completionTokens: total.completionTokens + next.completionTokens,
    totalTokens: total.totalTokens + next.totalTokens,
    promptCostUsd: total.promptCostUsd + next.promptCostUsd,
    completionCostUsd: total.completionCostUsd + next.completionCostUsd,
    totalCostUsd: total.totalCostUsd + next.totalCostUsd,
  };
}

function usageOf(response: {
  provider?: string;
  model: string;
  usage: {
    promptTokens?: number | undefined;
    completionTokens?: number | undefined;
    totalTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
  };
  cost?: { promptCost: number; completionCost: number; totalCost: number } | undefined;
}): StepUsageBreakdown | undefined {
  if (!response.usage.totalTokens) return undefined;
  return {
    provider: response.provider ?? 'unknown',
    model: response.model,
    promptTokens: response.usage.promptTokens ?? 0,
    completionTokens: response.usage.completionTokens ?? 0,
    totalTokens: response.usage.totalTokens,
    ...(response.usage.cacheReadTokens !== undefined
      ? { cacheReadTokens: response.usage.cacheReadTokens }
      : {}),
    ...(response.usage.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: response.usage.cacheWriteTokens }
      : {}),
    promptCostUsd: response.cost?.promptCost ?? 0,
    completionCostUsd: response.cost?.completionCost ?? 0,
    totalCostUsd: response.cost?.totalCost ?? 0,
  };
}

/**
 * The generation port for one simulated call.
 *
 * The ceiling is checked here rather than at the call's entry, because only
 * this function knows a generation was actually asked for — refusing every
 * call once it is reached would fail the reads that rules and the world answer
 * for free. Reaching it fails the call and never falls through to the contract
 * example: a scenario that quietly stops generating keeps answering plausibly
 * while it stops rehearsing anything.
 */
export function createGenerateSimulatedAnswer(
  ctx: ExecutorContext,
  deps: GenerateSimulatedAnswerDeps,
): SimulationGenerator {
  const { maxGeneratedCallsPerRun } = deps.budget;
  let spent: StepUsageBreakdown | undefined;

  async function generate(ask: GenerationAsk): Promise<GeneratedAnswer> {
    const claimed = await deps.budget.claimSlot();
    if (claimed === null) {
      throw new ApiExecutionError(
        apiError(
          'API_SIMULATION_GENERATION_LIMIT',
          `Simulation "${deps.simulationId}" has spent its policy.maxGeneratedCallsPerRun of ${String(maxGeneratedCallsPerRun)} generated answers in this run, so endpoint "${ask.endpoint.endpointId}" is refused rather than answered from its contract. Raise the ceiling, declare a rule or a world effect for this endpoint, or freeze the run's world into a baseline so the call is answered deterministically and for free.`,
          {
            retryable: false,
            details: {
              simulationId: deps.simulationId,
              endpointId: ask.endpoint.endpointId,
              maxGeneratedCallsPerRun,
            },
          },
        ),
      );
    }

    // Before the client is even built: a cancelled step must not sit through a
    // model call whose answer it will never be allowed to return.
    ctx.signal.throwIfAborted();

    const factory = byokFactory(deps.db);
    // A NAMED model is a pin, not a preference. Falling through would let two
    // runs of one scenario answer from different models with nothing recording
    // it — which destroys the only reason to name one. When nothing is named,
    // the fallback chain still applies: an unnamed simulation is asking for
    // "whatever this space would use", and that should not fail.
    const model =
      deps.modelRef !== undefined
        ? await pinnedGenerationModel(factory, ctx, deps.modelRef, deps.simulationId)
        : await resolveGenerationModel(factory, ctx, [
            ctx.callerModel,
            process.env['SIMULATION_GEN_MODEL'],
            DEFAULT_SIMULATION_MODEL,
          ]);
    if (model === null) {
      throw new SimulationGenerationUnavailableError(
        ask.endpoint.endpointId,
        `Simulation "${deps.simulationId}" has no AI provider connected in this space, so endpoint "${ask.endpoint.endpointId}" answers from its declared contract instead.`,
      );
    }

    let client: AIClient;
    try {
      ({ client } = await factory.getClientForModel(model, byokContext(ctx)));
    } catch (error) {
      if (error instanceof ByokCredentialError) {
        // Same class as no model at all: the space cannot generate, so the
        // endpoint answers from its contract rather than failing the call.
        throw new SimulationGenerationUnavailableError(ask.endpoint.endpointId, error.message);
      }
      throw error;
    }

    const { system, user } = buildPrompt(ask);
    const response = await client.generateJson({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      schema: z.unknown(),
      schemaName: 'simulated_answer',
      rawJsonSchema: ask.outputSchema,
      // An endpoint's success body is arbitrary JSON, which OpenAI's strict
      // mode — all properties required, no additional ones — cannot express.
      strictJsonSchema: false,
      reasoning: GENERATION_REASONING,
      temperature: GENERATION_TEMPERATURE,
      maxTokens: GENERATION_MAX_TOKENS,
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.stepExecutionId,
      attempt: ctx.attempt,
      signal: ctx.signal,
    });
    const usage = usageOf(response);
    if (usage) spent = accumulate(spent, usage);

    const parsed = GeneratedAnswerSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new ApiExecutionError(
        apiError(
          'API_SIMULATION_CONTRACT_VIOLATION',
          `Simulation "${deps.simulationId}" generated an answer for endpoint "${ask.endpoint.endpointId}" outside the envelope the generation request required: ${parsed.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
          {
            details: { simulationId: deps.simulationId, endpointId: ask.endpoint.endpointId },
          },
        ),
      );
    }

    const mutations: WorldMutation[] = parsed.data.mutations.map((mutation) => ({
      collection: mutation.collection,
      op: mutation.op,
      entityId: mutation.entityId,
      ...(mutation.body !== undefined ? { body: mutation.body } : {}),
    }));

    return { status: ask.success.status, body: parsed.data.body, mutations };
  }

  return { generate, spend: () => spent };
}
