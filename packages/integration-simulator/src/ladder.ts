import { synthesizeMinimalAppletValue } from '@aflow/applet-runtime';
import type { ApiEndpoint, Simulation } from '@aflow/schemas';
import {
  assertMutationsStorable,
  resolveEffect,
  resolveTransition,
  SimulationWorldViolationError,
} from './effect.js';
import { answerByGeneration } from './generate.js';
import { mintEntityId } from './identity.js';
import { runCodeHandler } from './codeRung.js';
import { matchRule } from './rules.js';
import { responseSchemaFor, successResponse } from './readiness.js';
import type { SimulatedRequest, SimulatedResponse, SimulationContext } from './types.js';

/**
 * The ladder. Each rung is cheaper and more deterministic than the one below.
 *
 *   1. declared rules      — deterministic, free, instant
 *   2. the world           — deterministic, free, coherent
 *   3. generation          — the model answers from the world and the brief
 *   4. the contract example — a stateless synthesis from the response schema
 *
 * Resolution runs top down and AUTHORING runs bottom up: a simulation with
 * nothing declared already answers, and precision is added where a scenario
 * earns it. That is the whole reason generation is the default rung — a
 * simulation whose first step is declaring every endpoint's behaviour costs
 * what implementing the API costs, and nobody finishes it.
 *
 * Rung 3 is reached whenever no rule matched and either the endpoint declares
 * no effect or its read missed with `onMissing: 'generate'`. Without a
 * `generate` port there is no model in the path: an effect's miss surfaces as
 * a `generationRequest` for the caller to answer, and an endpoint with no
 * effect falls to the contract example. `policy.unmatched: 'error'` disables
 * the rung outright — an eval-grade simulation invents nothing.
 */

export class SimulationUnmatchedError extends Error {
  readonly endpointId: string;

  constructor(endpointId: string, detail: string) {
    super(`SIMULATION_UNMATCHED: ${detail}`);
    this.name = 'SimulationUnmatchedError';
    this.endpointId = endpointId;
  }
}

/**
 * The contract example — rung 4. A deterministic minimal synthesis from the
 * endpoint's own success schema: required members only, minimum lengths, first
 * enum entries, the smallest string a pattern admits.
 *
 * It proves the wiring, the tool surface and the request shaping, and proves
 * nothing about behaviour — which is exactly what `contract_ready` claims.
 */
export function contractExample(endpoint: ApiEndpoint): { status: number; body: unknown } {
  const success = successResponse(endpoint);
  if (success === undefined) {
    throw new SimulationUnmatchedError(
      endpoint.endpointId,
      `Endpoint "${endpoint.endpointId}" declares no success response schema, so it has no contract to answer with.`,
    );
  }
  return {
    status: success.status,
    body: synthesizeMinimalAppletValue(success.schema, success.schema),
  };
}

export async function runLadder(params: {
  simulation: Simulation;
  endpoint: ApiEndpoint;
  request: SimulatedRequest;
  context: SimulationContext;
}): Promise<SimulatedResponse> {
  const { simulation, endpoint, request, context } = params;

  // Rung 1 — declared rules.
  const rule = await matchRule({
    rules: simulation.rules,
    request,
    ordinal: context.ordinal,
    store: context.store,
  });
  if (rule) {
    const response: SimulatedResponse = {
      status: rule.respond.status,
      body: rule.respond.body ?? null,
      rung: 'rule',
      ruleId: rule.ruleId,
      mutations: [],
    };
    if (rule.respond.headers) response.headers = rule.respond.headers;
    if (rule.respond.delayMs !== undefined) response.delayMs = rule.respond.delayMs;
    if (rule.transition) {
      const outcome = await resolveTransition({
        transition: rule.transition,
        request,
        store: context.store,
        collections: simulation.collections,
        seed: context.runContext.seed,
        logicalExecutionId: context.logicalExecutionId,
        clockMs: context.clockMs,
      });
      response.mutations = outcome.mutations;
    }
    return response;
  }

  // Rung 1.5 — a function over the world.
  //
  // Above the declarative effect because it is the more specific authoring: an
  // endpoint given a function was given one deliberately, and an effect it also
  // carries is the shape that function replaced.
  const handler = simulation.handlers[endpoint.endpointId];
  if (handler) {
    const world: Record<string, Array<Record<string, unknown>>> = {};
    for (const collection of handler.collections) {
      // Through `store.query`, so the persona narrowing every other rung gets
      // applies here too — a handler cannot see rows its caller could not.
      const entities = await context.store.query({ collection, match: [] });
      world[collection] = entities.map((entity) => entity.body);
    }

    // Ids are minted HERE, from the run seed, so a handler cannot invent one
    // and break replay. The sequence is per handler run, so two creates in one
    // call get different ids and the same call replayed gets the same pair.
    let minted = 0;
    const result = await runCodeHandler({
      endpointId: endpoint.endpointId,
      code: handler.code,
      timeoutMs: handler.timeoutMs,
      mintId: (collection) =>
        mintEntityId({
          seed: context.runContext.seed,
          logicalExecutionId: context.logicalExecutionId,
          collection,
          sequence: minted++,
        }),
      request: {
        method: request.method,
        url: request.url,
        params: request.params,
        body: request.body,
      },
      caller:
        context.runContext.personaId === null ? null : { personaId: context.runContext.personaId },
      now: context.clockMs,
      world,
    });

    // A handler's body is opaque, so its declaration is the only thing that can
    // bound what it writes. Without this a handler could persist into a
    // collection it never named, and readiness would go on reporting the world
    // it actually touches as unread.
    const declared = new Set(handler.collections);
    for (const mutation of result.mutations) {
      if (declared.has(mutation.collection)) continue;
      throw new SimulationWorldViolationError(mutation.collection, [
        `The code handler for "${endpoint.endpointId}" writes to "${mutation.collection}", which is not in its declared collections. Declare it, or write only to what the handler already declares.`,
      ]);
    }

    const mutations = result.mutations.map((mutation) =>
      mutation.op === 'delete'
        ? {
            collection: mutation.collection,
            op: 'delete' as const,
            entityId: mutation.entityId,
          }
        : {
            collection: mutation.collection,
            op: mutation.op,
            entityId: mutation.entityId,
            body: mutation.body,
          },
    );

    // Stamped and checked exactly as a declared effect's writes are. The commit
    // boundary stamps ownership again as a backstop, but nothing there checks a
    // delta against its collection schema — so an unchecked handler could store
    // a row the contract forbids and have it fold into the world.
    const stamped = context.store.stampOwnership(mutations);
    assertMutationsStorable(simulation.collections, stamped);

    return {
      status: result.status,
      body: result.body,
      rung: 'code',
      mutations: stamped,
    };
  }

  // Rung 2 — the world.
  const effect = simulation.effects[endpoint.endpointId];
  if (effect) {
    const outcome = await resolveEffect({
      effect,
      request,
      store: context.store,
      collections: simulation.collections,
      seed: context.runContext.seed,
      logicalExecutionId: context.logicalExecutionId,
      clockMs: context.clockMs,
    });

    if (outcome.kind === 'resolved') {
      return {
        status: outcome.status,
        body: outcome.body,
        rung: 'world',
        mutations: outcome.mutations,
      };
    }

    // The read came back empty. What that MEANS is declared, because an absent
    // entity that should be invented and one that should be reported missing
    // are different answers and nothing else distinguishes them.
    const onMissing = outcome.onMissing;
    if (typeof onMissing === 'object') {
      // The read produced no entity, so the declared status class is the only
      // shape left to answer in. An author's own body wins; synthesis is the
      // fallback, and it is well-formed rather than useful — a not-found
      // carrying nothing a caller can read is barely better than one that fails
      // validation, which is why the body is declarable at all.
      const schema = responseSchemaFor(endpoint, onMissing.respond);
      const body =
        onMissing.body !== undefined
          ? onMissing.body
          : schema === undefined
            ? null
            : synthesizeMinimalAppletValue(schema, schema);
      return {
        status: onMissing.respond,
        body,
        rung: 'world',
        mutations: [],
      };
    }
    if (onMissing === 'error' || simulation.policy.unmatched === 'error') {
      throw new SimulationUnmatchedError(
        endpoint.endpointId,
        `No entity in "${outcome.query.collection}" matches ${JSON.stringify(outcome.query.match)} and generation is disabled.`,
      );
    }
    if (outcome.unresolved) {
      // Generation invents facts to satisfy a STATED predicate. With no value
      // for the selector there is none, so an invented entity would answer a
      // question the caller never asked — the wrong-entity read this branch
      // exists to prevent, arrived at from the other side.
      throw new SimulationUnmatchedError(
        endpoint.endpointId,
        `Endpoint "${endpoint.endpointId}" selects "${outcome.query.collection}" on "${outcome.unresolved.requestPath}", which this request supplies no value for, so no entity can match it. Supply the input, or declare the read's onMissing as a status the endpoint declares.`,
      );
    }

    // Rung 3 — the model answers what the world could not.
    const generated = await generate({ simulation, endpoint, request, context });
    if (generated) return generated;

    // No model in the path. The miss is reported as the facts a caller with
    // one would have to invent, which is what an inspector and an authoring
    // surface both need to say what is missing.
    return {
      status: effect.status,
      body: null,
      rung: 'generated',
      mutations: [],
      generationRequest: { effect, missing: [outcome.query] },
    };
  }

  // Rung 3 with nothing declared at all — the case the whole rung exists for.
  if (simulation.policy.unmatched === 'error') {
    throw new SimulationUnmatchedError(
      endpoint.endpointId,
      `No rule matched and endpoint "${endpoint.endpointId}" declares no world effect, and this simulation refuses to invent.`,
    );
  }
  const generated = await generate({ simulation, endpoint, request, context });
  if (generated) return generated;

  // Generation declines for two reasons and they have different owners, so the
  // refusal names the one that applies. Reporting the schema as missing when a
  // caller simply has no model sends an operator to edit a definition that is
  // already correct.
  throw new SimulationUnmatchedError(
    endpoint.endpointId,
    context.generate === undefined
      ? `No rule matched and endpoint "${endpoint.endpointId}" declares no world effect, and this caller has no model to answer with. Author a rule, an effect or a handler for it, or call through a path that supplies generation.`
      : `No rule matched, no world effect answered, and endpoint "${endpoint.endpointId}" declares no success response schema, so there is no contract to invent an answer against. Declare responseSchemas for it, or give it a world effect.`,
  );
}

/**
 * Rung 3 as the ladder uses it: `undefined` whenever the caller has no model
 * or the endpoint has no success schema to constrain an answer with, so the
 * rung below answers instead.
 */
async function generate(params: {
  simulation: Simulation;
  endpoint: ApiEndpoint;
  request: SimulatedRequest;
  context: SimulationContext;
}): Promise<SimulatedResponse | undefined> {
  const { simulation, endpoint, request, context } = params;
  if (context.generate === undefined) return undefined;

  const answer = await answerByGeneration({
    generate: context.generate,
    simulation,
    endpoint,
    request,
    store: context.store,
    clockMs: context.clockMs,
    priorCalls: context.priorCalls ?? [],
    personaId: context.runContext.personaId,
  });
  if (answer === undefined) return undefined;

  return {
    status: answer.status,
    body: answer.body,
    rung: 'generated',
    mutations: answer.mutations,
  };
}
