/**
 * Rung 3 — the model answers.
 *
 * This package holds no AI client. Generation is a PORT the caller supplies,
 * because model access resolves per space through BYOK, and a world core that
 * reached for a credential would be unusable from the server, the eval runner
 * and every test that folds a world without one.
 *
 * What makes a generated answer safe is not prompt language. The shape is
 * constrained by construction — the output schema inlines the endpoint's own
 * success response schema and each collection's entity schema — and the answer
 * is validated against those same schemas before anything commits, so one
 * contract holds whichever rung produced it.
 *
 * Generation answers the SUCCESS case. A declared failure is a rule (rung 1):
 * an invented 500 fails a run in a way nobody authored and no eval reproduces.
 */
import { escapeJsonPointerSegment } from '@aflow/applet-runtime';
import type {
  ApiEndpoint,
  Simulation,
  SimulationCollection,
  SimulationPersona,
} from '@aflow/schemas';
import { entityStorageViolation } from './entities.js';
import { responseSchemaFor, statusClassOf, successResponse } from './readiness.js';
import { schemaViolations } from './schemaCheck.js';
import type {
  SimulatedRequest,
  WorldEntity,
  WorldMutation,
  WorldReadQuery,
  WorldStore,
} from './types.js';

/**
 * The slice bounds.
 *
 * A slice exists because the whole world does not fit and does not stay the
 * same size: every entity a scenario adds would ride into every later call's
 * prompt, so an unsliced ask costs more each turn and eventually cannot be
 * made at all. What the model needs is the entities this call addresses plus
 * enough of each collection to see what its rows look like.
 */
export const WORLD_SLICE_SAMPLE_LIMIT = 5;
export const WORLD_SLICE_MATCHED_LIMIT = 10;
export const WORLD_SLICE_PROBE_VALUE_LIMIT = 16;

/**
 * Mutations one generated answer may carry. A model-authored write list is
 * unbounded input to durable state; one call that rewrites twenty entities is
 * a runaway rather than an answer.
 */
export const GENERATED_MUTATION_LIMIT = 20;

/** One collection's contribution to the slice. */
export interface WorldSliceCollection {
  collection: string;
  identityField: string;
  /** Entities addressed by a value this request itself carries. */
  matched: WorldEntity[];
  /** Entities beyond those, bounded — the shape of what already exists. */
  sample: WorldEntity[];
  /** The collection holds more than `sample` shows. */
  truncated: boolean;
}

export interface WorldSlice {
  collections: WorldSliceCollection[];
}

/** The world as slice-building reads it — queries only, so it commits nothing. */
/**
 * What generation needs of the world: the slice it reasons over, and the
 * ownership stamp its invented rows are held to. Narrowed deliberately — the
 * generative rung must not be able to commit, only to propose.
 */
export type WorldSliceSource = Pick<WorldStore, 'query' | 'stampOwnership'>;

/** The endpoint as the model sees it. */
export interface GenerationEndpointView {
  endpointId: string;
  name: string;
  description?: string;
  method: string;
  pathTemplate: string;
  params: Array<{
    name: string;
    location: string;
    required: boolean;
    description?: string;
    schema?: Record<string, unknown>;
  }>;
}

/** One earlier call to this simulation, compactly. */
export interface GenerationCallSummary {
  endpointId: string;
  status: number;
}

/** Everything the model needs to answer this call, and nothing more. */
export interface GenerationAsk {
  /**
   * Narrowed rather than the `ApiEndpoint` itself: the endpoint carries a
   * `writeRiskTier`, which is orchestrator-plane and never crosses into a
   * model's context.
   */
  endpoint: GenerationEndpointView;
  /** The call as resolved — the canonical, non-secret shape the journal records. */
  request: SimulatedRequest;
  /** The status and schema the answer's body must satisfy. */
  success: { status: number; schema: Record<string, unknown> };
  /** The collections the answer may write, with the schema each row is held to. */
  collections: readonly SimulationCollection[];
  /** The simulation's domain brief — the world the answer has to be plausible in. */
  domainBrief: string;
  /** Who the call is acting as, and what is true of them. Absent when nobody. */
  persona?: SimulationPersona | undefined;
  world: WorldSlice;
  /**
   * The instant this call observes, from the virtual clock. A generated
   * `createdAt` the model dated itself would differ on every run, in a field
   * agents filter and sort on.
   */
  clockMs: number;
  /**
   * This run's earlier calls to this simulation. Without them the model
   * re-answers a question it already answered differently, and a conversation
   * that reads back what it just wrote sees two worlds.
   */
  priorCalls: readonly GenerationCallSummary[];
  /** The JSON Schema the model's structured output must satisfy. */
  outputSchema: Record<string, unknown>;
}

export interface GeneratedAnswer {
  status: number;
  body: unknown;
  mutations: WorldMutation[];
}

export type GenerateSimulatedAnswer = (ask: GenerationAsk) => Promise<GeneratedAnswer>;

/** Where in a generated answer a check failed. */
export interface GenerationIssue {
  /** `status`, `body`, `mutations` or `mutations[2]`. */
  location: string;
  detail: string;
}

/**
 * A generated answer the contract rejects. Loud and non-retryable: the model
 * answered outside the schemas the simulation promises, and returning it would
 * put the agent and the world in shapes the real API could never produce.
 */
/**
 * Generation cannot run at all — no model is connected for this space, rather
 * than the model having answered badly.
 *
 * It fails the call. Falling through to the contract example would answer a
 * behavioural question with a synthesized minimal body, so an operator whose
 * space is simply missing a provider would read "the endpoint returned a
 * plausible purchase" as behaviour when only the wiring was exercised. It is
 * the same class as a spent `maxGeneratedCallsPerRun`, which already refuses
 * loudly for exactly that reason, and treating the two differently made the
 * ceiling's own argument inconsistent.
 *
 * `endpointReadiness` calling such an endpoint `contract_ready` is not a
 * disagreement: readiness describes the ARTIFACT — this endpoint declares a
 * contract that could answer — while this describes the DEPLOYMENT. The
 * contract example remains rung 4 for a caller that folds the ladder with no
 * generation port at all.
 */
export class SimulationGenerationUnavailableError extends Error {
  readonly endpointId: string;

  constructor(endpointId: string, detail: string) {
    super(`SIMULATION_GENERATION_UNAVAILABLE: ${detail}`);
    this.name = 'SimulationGenerationUnavailableError';
    this.endpointId = endpointId;
  }
}

export class SimulationGenerationError extends Error {
  readonly endpointId: string;
  readonly issues: readonly GenerationIssue[];
  /**
   * What the model actually produced. A schema violation alone does not say
   * whether the declaration is wrong or the model read the domain differently
   * — and those call for opposite fixes.
   */
  readonly answer: GeneratedAnswer;

  constructor(endpointId: string, issues: readonly GenerationIssue[], answer: GeneratedAnswer) {
    super(
      `SIMULATION_GENERATION_INVALID: ${issues.map((issue) => `${issue.location}: ${issue.detail}`).join('; ')}`,
    );
    this.name = 'SimulationGenerationError';
    this.endpointId = endpointId;
    this.issues = issues;
    this.answer = answer;
  }
}

// ============================================================================
// The world slice
// ============================================================================

function collectScalars(value: unknown, into: Map<string, string | number>): void {
  if (into.size >= WORLD_SLICE_PROBE_VALUE_LIMIT) return;
  // Booleans are deliberately not probes: `true` addresses no entity, it
  // partitions the collection, and every row holding it would be "matched".
  if (typeof value === 'string') {
    if (value.length > 0) into.set(value, value);
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    into.set(String(value), value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectScalars(item, into);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) collectScalars(item, into);
  }
}

/** The identifiers this call names, in the order the request states them. */
export function requestProbeValues(request: SimulatedRequest): Array<string | number> {
  const found = new Map<string, string | number>();
  collectScalars(request.params, found);
  collectScalars(request.body, found);
  return [...found.values()].slice(0, WORLD_SLICE_PROBE_VALUE_LIMIT);
}

/**
 * The call's top-level keys paired with their values.
 *
 * A request key and a collection property of the same name are the same field:
 * that is what a path parameter means. It matters where the referenced entity
 * is not itself a modelled collection — `customerId` addresses a purchase even
 * with no `customers` collection to lend the name.
 */
export function requestProbePairs(
  request: SimulatedRequest,
): Array<{ key: string; value: string | number }> {
  const pairs: Array<{ key: string; value: string | number }> = [];
  const sources = [request.params, request.body];
  for (const source of sources) {
    if (typeof source !== 'object' || source === null || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (pairs.length >= WORLD_SLICE_PROBE_VALUE_LIMIT) return pairs;
      if (typeof value === 'string' && value.length > 0) pairs.push({ key, value });
      else if (typeof value === 'number' && Number.isFinite(value)) pairs.push({ key, value });
    }
  }
  return pairs;
}

function declaredProperties(schema: Record<string, unknown>): ReadonlySet<string> {
  const properties = schema['properties'];
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return new Set<string>();
  }
  return new Set(Object.keys(properties));
}

/**
 * The fields a request value can address a row by: the collection's own
 * identity, plus any other collection's identity this one declares as a
 * property. Without a declared index, a foreign key IS another collection's
 * identity field, so the declarations already say which fields relate rows —
 * scanning every property instead would make the slice a table scan per value.
 */
export function sliceProbeFields(
  declaration: SimulationCollection,
  collections: readonly SimulationCollection[],
): string[] {
  const fields = [declaration.identityField];
  const properties = declaredProperties(declaration.schema);
  for (const other of collections) {
    if (other.collection === declaration.collection) continue;
    if (!properties.has(other.identityField)) continue;
    if (!fields.includes(other.identityField)) fields.push(other.identityField);
  }
  return fields;
}

async function probeInto(params: {
  declaration: SimulationCollection;
  collections: readonly SimulationCollection[];
  values: ReadonlyArray<string | number>;
  pairs: ReadonlyArray<{ key: string; value: string | number }>;
  store: WorldSliceSource;
  matched: Map<string, WorldEntity>;
}): Promise<void> {
  const { declaration, store, matched } = params;
  const properties = declaredProperties(declaration.schema);

  const probes: Array<{ field: string; value: string | number }> = [];
  for (const field of sliceProbeFields(declaration, params.collections)) {
    for (const value of params.values) probes.push({ field, value });
  }
  for (const pair of params.pairs) {
    if (properties.has(pair.key)) probes.push({ field: pair.key, value: pair.value });
  }

  for (const probe of probes) {
    if (matched.size >= WORLD_SLICE_MATCHED_LIMIT) return;
    const query: WorldReadQuery = {
      collection: declaration.collection,
      match: [{ path: `/${escapeJsonPointerSegment(probe.field)}`, value: probe.value }],
      limit: WORLD_SLICE_MATCHED_LIMIT - matched.size,
    };
    for (const entity of await store.query(query)) matched.set(entity.id, entity);
  }
}

async function finishSlice(params: {
  declaration: SimulationCollection;
  matched: Map<string, WorldEntity>;
  store: WorldSliceSource;
}): Promise<WorldSliceCollection> {
  const { declaration, matched, store } = params;
  const window = await store.query({
    collection: declaration.collection,
    match: [],
    limit: WORLD_SLICE_SAMPLE_LIMIT + 1,
  });
  const sample = window
    .filter((entity) => !matched.has(entity.id))
    .slice(0, WORLD_SLICE_SAMPLE_LIMIT);

  return {
    collection: declaration.collection,
    identityField: declaration.identityField,
    matched: [...matched.values()],
    sample,
    truncated: window.length > WORLD_SLICE_SAMPLE_LIMIT,
  };
}

/**
 * What this call can see of the world.
 *
 * Nothing declares which entities a call is about once an endpoint has no
 * effect, so the request itself is the declaration: every scalar it carries is
 * an identifier candidate, and a row any declared collection addresses by one
 * of them belongs in the slice. The sample on top is what lets the model match
 * the shape of rows it never read.
 */
export async function buildWorldSlice(params: {
  request: SimulatedRequest;
  collections: readonly SimulationCollection[];
  store: WorldSliceSource;
}): Promise<WorldSlice> {
  const values = requestProbeValues(params.request);
  const pairs = requestProbePairs(params.request);
  const pending = params.collections.map((declaration) => ({
    declaration,
    matched: new Map<string, WorldEntity>(),
  }));

  const probeAll = async (
    probeValues: ReadonlyArray<string | number>,
    probePairs: ReadonlyArray<{ key: string; value: string | number }>,
  ): Promise<void> => {
    await Promise.all(
      pending.map((entry) =>
        probeInto({
          declaration: entry.declaration,
          collections: params.collections,
          values: probeValues,
          pairs: probePairs,
          store: params.store,
          matched: entry.matched,
        }),
      ),
    );
  };

  await probeAll(values, pairs);

  // One hop out. A call names the entity it is about, not the rows that hang
  // off it: a customer id reaches their purchases, and only the purchase ids
  // those rows carry reach the instalments. Without the hop a transitively
  // related collection is represented by the sample alone, and an answer
  // computed over it is an estimate the model has no way to flag as one.
  const reached = new Set<string | number>();
  for (const entry of pending) {
    for (const entity of entry.matched.values()) reached.add(entity.id);
  }
  const fresh = [...reached].filter((value) => !values.includes(value));
  if (fresh.length > 0) await probeAll(fresh, []);

  const collections = await Promise.all(
    pending.map((entry) =>
      finishSlice({
        declaration: entry.declaration,
        matched: entry.matched,
        store: params.store,
      }),
    ),
  );
  return { collections };
}

// ============================================================================
// The ask
// ============================================================================

function endpointView(endpoint: ApiEndpoint): GenerationEndpointView {
  return {
    endpointId: endpoint.endpointId,
    name: endpoint.name,
    ...(endpoint.description !== undefined ? { description: endpoint.description } : {}),
    method: endpoint.method,
    pathTemplate: endpoint.pathTemplate,
    params: endpoint.params.map((param) => ({
      name: param.name,
      location: param.location,
      required: param.required,
      ...(param.description !== undefined ? { description: param.description } : {}),
      ...(param.schema !== undefined ? { schema: param.schema } : {}),
    })),
  };
}

/**
 * The JSON Schema a generated answer must satisfy.
 *
 * The body IS the endpoint's success response schema and a mutation body IS
 * its collection's schema, inlined rather than described: a structured-output
 * call constrained this way cannot return the wrong shape, where an instruction
 * to match a schema is advice the model weighs against everything else in the
 * prompt.
 *
 * `undefined` when the endpoint declares no success schema — there is nothing
 * to constrain an answer with, and an unconstrained one is a fabrication.
 */
export function generationOutputSchema(params: {
  endpoint: ApiEndpoint;
  collections: readonly SimulationCollection[];
}): Record<string, unknown> | undefined {
  const success = successResponse(params.endpoint);
  if (success === undefined) return undefined;

  const branches = params.collections.map((declaration) => ({
    type: 'object',
    additionalProperties: false,
    required: ['collection', 'op', 'entityId'],
    description:
      `A write to "${declaration.collection}". \`body\` is the entity's complete post-image ` +
      `and is required for create and update — the world merges it over what is stored, so a ` +
      `partial body describes an entity the collection schema would reject. Omit it for delete.`,
    properties: {
      collection: { type: 'string', enum: [declaration.collection] },
      op: { type: 'string', enum: ['create', 'update', 'delete'] },
      entityId: {
        type: 'string',
        minLength: 1,
        description: `The row's "${declaration.identityField}", which \`body\` must also carry.`,
      },
      body: declaration.schema,
    },
  }));

  // No `status`: the endpoint declares exactly one success status, so asking
  // for it back is a constant the model can only echo or omit. The caller
  // stamps it. A declared failure is authored as a rule, not invented.
  return {
    type: 'object',
    additionalProperties: false,
    required: ['body', 'mutations'],
    properties: {
      body: success.schema,
      mutations: {
        type: 'array',
        maxItems: branches.length === 0 ? 0 : GENERATED_MUTATION_LIMIT,
        description:
          branches.length === 0
            ? 'This simulation declares no collections, so the answer changes no state.'
            : 'Every change this call makes to the world. Empty for a read.',
        ...(branches.length === 0 ? {} : { items: { anyOf: branches } }),
      },
    },
  };
}

/**
 * Everything the model is given, assembled. Pure — the world slice is passed
 * in, so the ask is inspectable and testable without a store.
 *
 * `undefined` when the endpoint has no success schema to constrain the answer.
 */
export function buildGenerationAsk(params: {
  simulation: Pick<Simulation, 'domainBrief' | 'collections'>;
  endpoint: ApiEndpoint;
  request: SimulatedRequest;
  world: WorldSlice;
  clockMs: number;
  priorCalls: readonly GenerationCallSummary[];
  /** The active persona, so the model answers as the world's owner sees it. */
  persona?: SimulationPersona | undefined;
}): GenerationAsk | undefined {
  const success = successResponse(params.endpoint);
  const outputSchema = generationOutputSchema({
    endpoint: params.endpoint,
    collections: params.simulation.collections,
  });
  if (success === undefined || outputSchema === undefined) return undefined;

  return {
    endpoint: endpointView(params.endpoint),
    request: params.request,
    success,
    collections: params.simulation.collections,
    domainBrief: params.simulation.domainBrief,
    ...(params.persona ? { persona: params.persona } : {}),
    world: params.world,
    clockMs: params.clockMs,
    priorCalls: params.priorCalls,
    outputSchema,
  };
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Every check a generated answer must pass before it can be returned or
 * committed — the same schemas a rule's response and a seeded row are held to.
 *
 * Returns issues rather than throwing: an authoring surface reports them all,
 * and the execution path turns them into one error.
 */
export function validateGeneratedAnswer(params: {
  endpoint: ApiEndpoint;
  collections: readonly SimulationCollection[];
  answer: GeneratedAnswer;
}): GenerationIssue[] {
  const { endpoint, answer } = params;
  const issues: GenerationIssue[] = [];

  if (!Number.isInteger(answer.status) || answer.status < 200 || answer.status > 599) {
    issues.push({
      location: 'status',
      detail: `${String(answer.status)} is not a final HTTP response status.`,
    });
  } else {
    const schema = responseSchemaFor(endpoint, answer.status);
    if (schema === undefined) {
      issues.push({
        location: 'status',
        detail: `Endpoint "${endpoint.endpointId}" declares no responseSchemas['${statusClassOf(answer.status)}'], so a ${String(answer.status)} has no contract to validate against.`,
      });
    } else {
      for (const violation of schemaViolations(schema, answer.body)) {
        issues.push({
          location: 'body',
          detail: `outside responseSchemas['${statusClassOf(answer.status)}']: ${violation}`,
        });
      }
    }
  }

  if (answer.mutations.length > GENERATED_MUTATION_LIMIT) {
    issues.push({
      location: 'mutations',
      detail: `${String(answer.mutations.length)} mutations exceeds the ${String(GENERATED_MUTATION_LIMIT)} one call may write.`,
    });
  }

  const declared = new Map(params.collections.map((c) => [c.collection, c]));
  for (const [index, mutation] of answer.mutations.entries()) {
    const location = `mutations[${String(index)}]`;
    const declaration = declared.get(mutation.collection);
    if (declaration === undefined) {
      issues.push({
        location,
        detail: `Collection "${mutation.collection}" is not declared, so nothing can read what this writes.`,
      });
      continue;
    }
    if (mutation.entityId.length === 0) {
      issues.push({
        location,
        detail: 'An entity with no id cannot be addressed by a later read.',
      });
      continue;
    }
    if (mutation.op === 'delete') continue;
    if (mutation.body === undefined) {
      issues.push({
        location,
        detail: `A ${mutation.op} carries the entity's complete post-image; this one carries no body.`,
      });
      continue;
    }
    const violation = entityStorageViolation({
      declaration,
      entityId: mutation.entityId,
      body: mutation.body,
    });
    if (violation !== undefined) issues.push({ location, detail: violation });
  }

  return issues;
}

/**
 * The whole rung: slice the world, ask, and hold the answer to the contract.
 *
 * `undefined` when the endpoint cannot be generated for — the caller falls to
 * the rung below rather than answering unconstrained.
 */
export async function answerByGeneration(params: {
  generate: GenerateSimulatedAnswer;
  simulation: Pick<Simulation, 'domainBrief' | 'collections' | 'personas'>;
  endpoint: ApiEndpoint;
  request: SimulatedRequest;
  store: WorldSliceSource;
  clockMs: number;
  priorCalls: readonly GenerationCallSummary[];
  /** Who the run acts as, or null for nobody. */
  personaId: string | null;
}): Promise<GeneratedAnswer | undefined> {
  // Before the world is read: an ask that cannot be constrained is never made,
  // so an endpoint with no success schema costs no queries either.
  if (successResponse(params.endpoint) === undefined) return undefined;

  const world = await buildWorldSlice({
    request: params.request,
    collections: params.simulation.collections,
    store: params.store,
  });
  const activePersona = params.simulation.personas.find(
    (persona) => persona.personaId === params.personaId,
  );
  const ask = buildGenerationAsk({
    simulation: params.simulation,
    endpoint: params.endpoint,
    request: params.request,
    world,
    clockMs: params.clockMs,
    priorCalls: params.priorCalls,
    ...(activePersona ? { persona: activePersona } : {}),
  });
  if (ask === undefined) return undefined;

  // Every reason generation cannot produce an answer propagates and fails the
  // call: an unavailable model, a spent ceiling, an answer the contract
  // rejects. Degrading any of them into the contract example would answer a
  // behavioural question with a synthesized body.
  const generated: GeneratedAnswer = await params.generate(ask);
  // Stamped before validation for the same reason a declared write is: an owned
  // collection normally declares its owner field required, and the model is not
  // shown the acting persona — it invents rows, and whose they are is not its
  // decision to make.
  const answer: GeneratedAnswer = {
    ...generated,
    mutations: params.store.stampOwnership(generated.mutations),
  };
  const issues = validateGeneratedAnswer({
    endpoint: params.endpoint,
    collections: params.simulation.collections,
    answer,
  });
  if (issues.length > 0) {
    throw new SimulationGenerationError(params.endpoint.endpointId, issues, answer);
  }
  return answer;
}
