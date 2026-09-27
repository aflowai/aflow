/**
 * The one path a simulated call takes.
 *
 * Every call that reaches here writes exactly one journal record before it
 * answers — a read, a rule-driven 429 and a create alike. That is a property
 * of the call graph rather than a convention: there is a single entry point,
 * and the only route from the ladder to a returned response runs through
 * `commit`. A caller that recorded only mutating calls would drop every read
 * the agent made from the corpus conformance and the world inspector fold.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, sql } from 'drizzle-orm';
import {
  createTenantContext,
  findCallRecord,
  readCallRecords,
  simulationRunContexts,
  withTenantSchema,
} from '@aflow/database';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { internalError } from '@aflow/executor-runtime';
import type { PayloadStore } from '@aflow/payload-store';
import { contentAddressForJson } from '@aflow/payload-store';
import type { Redis } from '@aflow/redis';
import {
  responseSchemaFor,
  runLadder,
  statusClassOf,
  SimulationGenerationError,
  SimulationGenerationUnavailableError,
  SimulationUnmatchedError,
  SimulationWorldViolationError,
} from '@aflow/integration-simulator';
import type {
  GenerationCallSummary,
  SimulatedRequest,
  SimulatedResponse,
} from '@aflow/integration-simulator';
import type {
  ApiCallInput,
  ApiEndpoint,
  SimulationCallRecord,
  SimulationRung,
  SimulationRunContext,
  Simulation,
  StepUsageBreakdown,
  TenantId,
} from '@aflow/schemas';
import { apiError } from '../../../lib/api-errors.js';
import { ApiExecutionError, definitionStoreKey, type ApiHandlerStores } from '../types.js';
import type { ResolvedCall } from '../types.js';
import { checkAgainstSchema } from '../validateBody.js';
import { createGenerateSimulatedAnswer } from './generateAnswer.js';
import { loadSimulation, resolvePinnedSimulation } from './loadSimulation.js';
import { createWorldStore } from './worldStore.js';
import type { SimulatedCallOutcome } from './worldStore.js';

/**
 * The rejected body, bounded. Enough to see what the model answered with
 * without putting a large generated document into an error message.
 */
const REJECTED_BODY_CHARS = 800;

function describeRejected(body: unknown): string {
  const rendered = JSON.stringify(body) ?? String(body);
  return rendered.length > REJECTED_BODY_CHARS
    ? `${rendered.slice(0, REJECTED_BODY_CHARS)}…`
    : rendered;
}

export interface SimulatedCallDeps {
  stores: ApiHandlerStores;
  input: ApiCallInput;
  db: PostgresJsDatabase;
  payloadStore: PayloadStore;
  redis: Redis;
  cacheTtlMs?: number;
}

export interface SimulatedCallResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  rung: SimulationRung;
  delayMs?: number;
  /**
   * What generation spent answering this call. A mock that costs tokens has to
   * say so, or the free-mock illusion produces a real invoice — so this rides
   * out to the step result as `costJson` rather than to an in-memory recorder.
   */
  usage?: StepUsageBreakdown;
}

/** Statuses an HTTP response carries no body for. */
const BODYLESS_STATUSES = new Set([204, 205, 304]);

/**
 * The answer as a `Response`, so it lands on the identical downstream the live
 * path takes: the declared transform, the inline/`PayloadRef` split and
 * `saveTo` behave exactly as they will against the real service.
 *
 * Pure — it reads no world and records nothing.
 */
export function toSimulatedFetchResponse(result: SimulatedCallResult): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(result.headers ?? {}),
  };
  const body =
    BODYLESS_STATUSES.has(result.status) || result.body === undefined
      ? null
      : JSON.stringify(result.body);
  return new Response(body, { status: result.status, headers });
}

/**
 * The instant this call observes. The anchor advances only by the declared
 * `advanceClockMs` of rules that have already fired, so the clock is a
 * function of the pinned context and the journal — never of wall time, which
 * would make every run's world differ in fields agents sort on.
 */
function virtualClockMs(
  runContext: SimulationRunContext,
  simulation: Simulation,
  records: readonly SimulationCallRecord[],
): number {
  const advanceByRuleId = new Map<string, number>(
    simulation.rules.map((rule) => [rule.ruleId, rule.advanceClockMs ?? 0]),
  );
  let clockMs = runContext.clockAnchorMs;
  for (const record of records) {
    const ruleId = record.matched.ruleId;
    if (ruleId !== undefined) clockMs += advanceByRuleId.get(ruleId) ?? 0;
  }
  return clockMs;
}

/**
 * Mandatory and fail-loud, against the schema for the response's OWN status
 * class and on the raw provider-shaped body before any transform.
 *
 * The live path validates only on request and only warns, because there the
 * service is the authority and a mismatch is the definition's problem. Here
 * the schema IS the authority, so a body outside it is a shape the real API
 * could never return.
 */
function assertDeclaredResponse(params: {
  endpoint: ApiEndpoint;
  simulationId: string;
  status: number;
  body: unknown;
}): void {
  const { endpoint, simulationId, status, body } = params;
  const declared = Object.keys(endpoint.responseSchemas ?? {});
  const details = { endpointId: endpoint.endpointId, simulationId, status };

  if (status < 200) {
    throw new ApiExecutionError(
      apiError(
        'API_SIMULATION_CONTRACT_VIOLATION',
        `Simulation "${simulationId}" answered endpoint "${endpoint.endpointId}" with HTTP ${String(status)}, which is not a final response. Respond with a status the endpoint declares.`,
        { details },
      ),
    );
  }

  const schema = responseSchemaFor(endpoint, status);
  if (!schema) {
    throw new ApiExecutionError(
      apiError(
        'API_SIMULATION_CONTRACT_VIOLATION',
        `Simulation "${simulationId}" answered endpoint "${endpoint.endpointId}" with HTTP ${String(status)}, but the API definition declares no responseSchemas['${statusClassOf(status)}'] — only [${declared.join(', ') || 'none'}]. Declare that status class on the endpoint, or answer with one it already declares.`,
        { details: { ...details, declaredStatusClasses: declared } },
      ),
    );
  }

  const check = checkAgainstSchema(schema, body);
  // An uncompilable response schema is a broken CONTRACT, not a bad answer —
  // saying the simulation replied outside a schema nobody can compile would
  // blame the world for the definition's defect.
  if (check.kind === 'uncompilable') {
    throw new ApiExecutionError(
      apiError(
        'API_ENDPOINT_SCHEMA_INVALID',
        `Endpoint "${endpoint.endpointId}" declares a responseSchemas['${statusClassOf(status)}'] that is not valid JSON Schema: ${check.reason}. Fix the API definition — a $ref stored without being inlined is the usual cause.`,
        { details },
      ),
    );
  }
  const issues = check.kind === 'issues' ? check.issues : [];
  if (issues.length > 0) {
    throw new ApiExecutionError(
      apiError(
        'API_SIMULATION_CONTRACT_VIOLATION',
        `Simulation "${simulationId}" answered endpoint "${endpoint.endpointId}" with a body outside responseSchemas['${statusClassOf(status)}']: ${issues.join('; ')}`,
        { details: { ...details, issues } },
      ),
    );
  }
}

function unmatched(simulationId: string, endpointId: string, detail: string): ApiExecutionError {
  return new ApiExecutionError(
    apiError('API_SIMULATION_UNMATCHED', detail, { details: { simulationId, endpointId } }),
  );
}

/**
 * How many of this run's calls to this endpoint have already COMMITTED.
 *
 * This is what a rule's `when.ordinal` matches — "the third call to
 * getCustomer returns 429". It used to be computed from scheduled-call
 * identity, so that two calls of one turn could be told apart before either
 * committed; that machinery is gone, and the committed count was always the
 * fallback beneath it.
 *
 * For a serialized run — which is what an eval-grade run is — the two agree
 * exactly. For calls dispatched in parallel, "the third call" is a question
 * about scheduling, and arrival order is the honest answer rather than an
 * invented one.
 */
/**
 * Claim one generated answer against the run's ceiling, durably.
 *
 * A conditional UPDATE rather than a read-then-write: the row is the lock, so
 * two concurrent calls cannot both see the last slot. Returns the new count, or
 * `null` when the ceiling is already spent and the caller must refuse instead
 * of dialling.
 *
 * The claim is not released if the call then fails. That is deliberate — the
 * tokens were spent either way, and a ceiling that refunded failures would let
 * a failing loop bill indefinitely.
 */
async function claimGenerationSlot(params: {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  runId: string;
  simulationId: string;
  ceiling: number;
}): Promise<number | null> {
  const rows = await withTenantSchema(
    params.db,
    createTenantContext(params.tenantId as TenantId),
    async (tx) =>
      tx
        .update(simulationRunContexts)
        .set({ generatedCalls: sql`${simulationRunContexts.generatedCalls} + 1` })
        .where(
          and(
            eq(simulationRunContexts.spaceId, params.spaceId),
            eq(simulationRunContexts.runId, params.runId),
            eq(simulationRunContexts.simulationId, params.simulationId),
            sql`${simulationRunContexts.generatedCalls} < ${params.ceiling}`,
          ),
        )
        .returning({ generatedCalls: simulationRunContexts.generatedCalls }),
  );
  return rows[0]?.generatedCalls ?? null;
}

export function endpointOrdinal(
  records: readonly SimulationCallRecord[],
  endpointId: string,
): number {
  return records.filter((record) => record.endpointId === endpointId).length;
}

/**
 * The answer a journal record already holds. Declared latency and rule headers
 * are not part of the receipt: the run already waited out the first and the
 * agent already read the second.
 */
async function recordedAnswer(
  deps: SimulatedCallDeps,
  record: SimulationCallRecord,
): Promise<SimulatedCallResult> {
  return {
    status: record.responseStatus,
    body: await deps.payloadStore.retrieve(record.responseRef),
    rung: record.matched.rung,
  };
}

async function answerCall(params: {
  ctx: ExecutorContext;
  resolved: ResolvedCall;
  deps: SimulatedCallDeps;
  endpoint: ApiEndpoint;
  spaceId: string;
  simulationRef: NonNullable<ResolvedCall['simulation']>;
}): Promise<SimulatedCallResult> {
  const { ctx, resolved, deps, endpoint, spaceId, simulationRef } = params;
  const scope = { db: deps.db, tenantId: ctx.tenantId, spaceId, runId: ctx.runId };

  // `processJob`'s outputExists() short-circuit runs BEFORE the handler, so a
  // crash between committing the world and persisting the step's output really
  // does re-run this call. The record is the receipt, and returning what it
  // recorded is what stops one call from issuing two refunds.
  const replay = await findCallRecord({ ...scope, logicalExecutionId: ctx.logicalExecutionId });
  if (replay) return recordedAnswer(deps, replay);

  // This simulation's journal, not the run's: another simulation's records
  // would move this one's ordinals and virtual clock.
  const records = await readCallRecords({ ...scope, simulationId: simulationRef.simulationId });
  const ordinal = endpointOrdinal(records, endpoint.endpointId);

  const definition = deps.stores.definitionStore.get(
    definitionStoreKey({ tenantId: ctx.tenantId, spaceId, apiId: simulationRef.apiId }),
  );
  if (!definition) {
    throw new ApiExecutionError(
      internalError(
        `The API definition "${simulationRef.apiId}" was evicted from the executor's cache between resolution and dispatch.`,
      ),
    );
  }

  const loaded = await loadSimulation(
    deps.stores,
    {
      db: deps.db,
      ...(deps.cacheTtlMs !== undefined ? { cacheTtlMs: deps.cacheTtlMs } : {}),
    },
    {
      tenantId: ctx.tenantId,
      spaceId,
      simulationId: simulationRef.simulationId,
      binding: {
        bindingId: simulationRef.bindingId,
        apiId: simulationRef.apiId,
        fulfillment: { mode: 'simulated', simulationId: simulationRef.simulationId },
      },
      definition,
    },
  );

  // Everything below answers from the pinned snapshot rather than from
  // `loaded` or `resolved.endpoint`: the artifact a run started on is the
  // artifact it finishes on, and a mid-run edit is refused here rather than
  // absorbed silently.
  const { runContext, pinned } = await resolvePinnedSimulation({
    stores: deps.stores,
    db: deps.db,
    redis: deps.redis,
    payloadStore: deps.payloadStore,
    tenantId: ctx.tenantId,
    spaceId,
    runId: ctx.runId,
    loaded,
    definition,
  });
  const simulation = pinned.snapshot.simulation;
  const pinnedEndpoint = pinned.endpointsById.get(endpoint.endpointId);
  if (!pinnedEndpoint) {
    throw new ApiExecutionError(
      apiError(
        'API_SIMULATION_PIN_BROKEN',
        `Endpoint "${endpoint.endpointId}" is not in the endpoint set this run pinned simulation "${simulationRef.simulationId}" to. Start a new run to call it.`,
        {
          retryable: false,
          details: { simulationId: simulationRef.simulationId, endpointId: endpoint.endpointId },
        },
      ),
    );
  }

  const clockMs = virtualClockMs(runContext, simulation, records);
  const request: SimulatedRequest = {
    method: resolved.method,
    url: resolved.url,
    endpointId: endpoint.endpointId,
    params: deps.input.params ?? {},
    body: resolved.body,
  };

  // The record's answer half — rung, status, response ref — exists only once
  // the ladder has read the world, so it is filled in below and read back from
  // inside `commit`.
  const recorded: { outcome?: SimulatedCallOutcome } = {};
  const store = await createWorldStore({
    db: deps.db,
    payloadStore: deps.payloadStore,
    tenantId: ctx.tenantId,
    spaceId,
    runId: ctx.runId,
    stepExecutionId: ctx.stepExecutionId,
    attempt: ctx.attempt,
    simulationId: simulationRef.simulationId,
    baselineVersion: runContext.baselineVersion,
    personaId: runContext.personaId,
    collections: simulation.collections,
    call: {
      logicalExecutionId: ctx.logicalExecutionId,
      bindingId: simulationRef.bindingId,
      apiId: simulationRef.apiId,
      endpointId: endpoint.endpointId,
      request: {
        method: resolved.method,
        url: resolved.url,
        ...(resolved.body !== undefined ? { body: resolved.body } : {}),
      },
      ordinal,
      clockMs,
    },
    resolveOutcome: () => {
      const { outcome } = recorded;
      if (outcome === undefined) {
        throw new Error('The world was committed before the ladder produced an answer.');
      }
      return outcome;
    },
  });

  // The ceiling is the simulation's own policy, so the count is this
  // simulation's generated calls within the run and not the run's: two
  // simulations answering one run each carry their own budget.
  const generator = createGenerateSimulatedAnswer(ctx, {
    db: deps.db,
    simulationId: simulationRef.simulationId,
    ...(runContext.modelRef !== undefined ? { modelRef: runContext.modelRef } : {}),
    budget: {
      maxGeneratedCallsPerRun: simulation.policy.maxGeneratedCallsPerRun,
      claimSlot: () =>
        claimGenerationSlot({
          ...scope,
          simulationId: simulationRef.simulationId,
          ceiling: simulation.policy.maxGeneratedCallsPerRun,
        }),
    },
  });
  // The journal in the order it was written, so a generated answer stays
  // consistent with what this run has already been told.
  const priorCalls: GenerationCallSummary[] = records.map((record) => ({
    endpointId: record.endpointId,
    status: record.responseStatus,
  }));

  // Compile every declared response schema BEFORE the ladder runs.
  //
  // Generation is the default rung, and it validates its own answer against
  // this schema — `schemaViolations` collapses a compile failure into an
  // ordinary violation, which surfaces as "the simulation answered outside its
  // contract". That blames the world for the definition's defect, and the
  // check further down never sees a generated call at all. The provider may
  // also refuse the invalid schema before returning anything.
  for (const [statusClass, declaredSchema] of Object.entries(
    pinnedEndpoint.responseSchemas ?? {},
  )) {
    const compiled = checkAgainstSchema(declaredSchema, undefined);
    if (compiled.kind === 'uncompilable') {
      throw new ApiExecutionError(
        apiError(
          'API_ENDPOINT_SCHEMA_INVALID',
          `Endpoint "${pinnedEndpoint.endpointId}" declares a responseSchemas['${statusClass}'] that is not valid JSON Schema: ${compiled.reason}. Fix the API definition — nothing can answer this endpoint until it compiles.`,
          { details: { endpointId: pinnedEndpoint.endpointId, statusClass } },
        ),
      );
    }
  }

  let answer: SimulatedResponse;
  try {
    answer = await runLadder({
      simulation,
      endpoint: pinnedEndpoint,
      request,
      context: {
        runContext,
        logicalExecutionId: ctx.logicalExecutionId,
        ordinal,
        clockMs,
        store,
        generate: generator.generate,
        priorCalls,
      },
    });
  } catch (error) {
    // Tokens burned before the failure are real and cannot be recorded:
    // `failureWithError` carries no costJson, so a failed step has nowhere to
    // put them. General to any executor that spends before failing, so it is
    // surfaced here rather than worked around simulation-locally.
    const burned = generator.spend();
    if (burned !== undefined) {
      ctx.log.warn('Simulated generation spent tokens on a call that then failed', {
        simulationId: simulationRef.simulationId,
        endpointId: pinnedEndpoint.endpointId,
        totalTokens: burned.totalTokens,
      });
    }
    if (error instanceof SimulationUnmatchedError) {
      throw unmatched(simulationRef.simulationId, error.endpointId, error.message);
    }
    if (error instanceof SimulationGenerationUnavailableError) {
      throw new ApiExecutionError(
        apiError(
          'API_SIMULATION_GENERATION_UNAVAILABLE',
          `Simulation "${simulationRef.simulationId}" needs a model to answer endpoint "${endpoint.endpointId}", which declares no rule and no world effect, and this space has no AI provider it can resolve. ${error.message} Connect a provider, or declare a rule or a world effect so the endpoint is answered without one.`,
          {
            retryable: false,
            details: {
              simulationId: simulationRef.simulationId,
              endpointId: endpoint.endpointId,
            },
          },
        ),
      );
    }
    if (error instanceof SimulationGenerationError) {
      throw new ApiExecutionError(
        apiError(
          'API_SIMULATION_CONTRACT_VIOLATION',
          `Simulation "${simulationRef.simulationId}" generated an answer for endpoint "${endpoint.endpointId}" the contract rejects: ${error.issues
            .map((issue) => `${issue.location}: ${issue.detail}`)
            .join('; ')}. It answered with: ${describeRejected(error.answer.body)}`,
          {
            details: {
              simulationId: simulationRef.simulationId,
              endpointId: endpoint.endpointId,
              issues: error.issues,
              rejectedBody: describeRejected(error.answer.body),
            },
          },
        ),
      );
    }
    if (error instanceof SimulationWorldViolationError) {
      throw new ApiExecutionError(
        apiError(
          'API_SIMULATION_CONTRACT_VIOLATION',
          `Simulation "${simulationRef.simulationId}" answered endpoint "${endpoint.endpointId}" with a world delta outside the "${error.collection}" collection schema: ${error.issues.join('; ')}`,
          {
            details: {
              simulationId: simulationRef.simulationId,
              endpointId: endpoint.endpointId,
              collection: error.collection,
              issues: error.issues,
            },
          },
        ),
      );
    }
    throw error;
  }

  // The executor always supplies a generation port, so a miss that surfaces as
  // a generation request means the rung could not be run at all: the endpoint
  // declares no success schema, and an answer nothing constrains is a
  // fabrication rather than a mock.
  if (answer.generationRequest) {
    const missing = answer.generationRequest.missing[0];
    throw unmatched(
      simulationRef.simulationId,
      endpoint.endpointId,
      `SIMULATION_UNMATCHED: endpoint "${endpoint.endpointId}" reads an entity in "${missing?.collection ?? 'the world'}" that the pinned baseline does not hold, and it declares no success response schema to generate one against. Declare the endpoint's success responseSchemas, seed the entity in the baseline, declare a rule for this call, or set the read's onMissing to a declared status.`,
    );
  }

  assertDeclaredResponse({
    endpoint: pinnedEndpoint,
    simulationId: simulationRef.simulationId,
    status: answer.status,
    body: answer.body,
  });

  // A bodyless answer is stored as an explicit null: the address is computed
  // over the bytes actually written, and `undefined` has no JSON encoding, so
  // hashing one value and storing another would either diverge or fail to
  // serialize at all.
  const bodyForStorage = answer.body ?? null;
  // Content-addressed, not keyed on the attempt: two overlapping deliveries of
  // ONE attempt — what a lease expiry produces, and the case the receipt exists
  // for — would otherwise write the same object, letting the loser replace the
  // body the winner's committed row points at.
  const responseRef = await deps.payloadStore.storeContentAddressed({
    tenantId: ctx.tenantId,
    contentHash: contentAddressForJson(bodyForStorage),
    kind: 'simulation_response',
    data: bodyForStorage,
    persist: true,
  });
  recorded.outcome = {
    matched: {
      rung: answer.rung,
      ...(answer.ruleId !== undefined ? { ruleId: answer.ruleId } : {}),
    },
    responseStatus: answer.status,
    responseRef,
  };

  // Unconditional, empty mutation list included. A pure read and a rule-driven
  // 429 change nothing and still belong to the corpus, so gating this on
  // `mutations.length` would silently omit every read the agent made.
  const committed = await store.commit(answer.mutations);
  if (!committed.applied) {
    // A concurrent attempt of this same call won the receipt, so its record is
    // what happened: nothing this attempt computed was journalled, and handing
    // the agent an answer no record describes is the drift the receipt exists
    // to prevent.
    const winner = await findCallRecord({ ...scope, logicalExecutionId: ctx.logicalExecutionId });
    if (winner) {
      // The recorded answer is what happened; the tokens this attempt burned
      // reaching its own are still real and still belong in run accounting.
      const lost = generator.spend();
      const recorded = await recordedAnswer(deps, winner);
      return lost === undefined ? recorded : { ...recorded, usage: lost };
    }
  }

  const usage = generator.spend();
  return {
    status: answer.status,
    body: answer.body,
    rung: answer.rung,
    ...(answer.headers !== undefined ? { headers: answer.headers } : {}),
    ...(answer.delayMs !== undefined ? { delayMs: answer.delayMs } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

/**
 * Answer one call from the simulation its binding names.
 *
 * The only handler-facing entry point, and the only place a call record is
 * written.
 */
export async function executeSimulatedCall(
  ctx: ExecutorContext,
  resolved: ResolvedCall,
  deps: SimulatedCallDeps,
): Promise<SimulatedCallResult> {
  const simulationRef = resolved.simulation;
  const endpoint = resolved.endpoint;
  const spaceId = ctx.job.spaceId;
  if (!simulationRef || !endpoint || !spaceId) {
    throw new ApiExecutionError(
      internalError(
        'A simulated call needs a binding resolved to simulated fulfillment, its endpoint and a space context.',
        { retryable: false },
      ),
    );
  }

  return await answerCall({ ctx, resolved, deps, endpoint, spaceId, simulationRef });
}
