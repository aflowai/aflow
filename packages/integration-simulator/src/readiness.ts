import type {
  ApiDefinition,
  ApiEndpoint,
  Simulation,
  SimulationDiagnostic,
  SimulationEndpointReadiness,
  SimulationEndpointReport,
  SimulationReadinessReport,
  WorldEffect,
} from '@aflow/schemas';
import { MAX_DIAGNOSTIC_DETAIL } from '@aflow/schemas';
import { compileSchema, schemaViolations } from './schemaCheck.js';

/** Status class key the response-schema lookup uses, e.g. 404 -> '4xx'. */
export function statusClassOf(status: number): string {
  return `${String(Math.floor(status / 100))}xx`;
}

/** The response schema a simulated response must validate against — its OWN status class. */
export function responseSchemaFor(
  endpoint: ApiEndpoint,
  status: number,
): Record<string, unknown> | undefined {
  return endpoint.responseSchemas?.[statusClassOf(status)];
}

/**
 * The success contract of an endpoint — the schema a contract example
 * synthesizes from and a generated body is constrained by, so both rungs
 * answer the same shape.
 *
 * Response schemas are keyed by status CLASS, so every 2xx resolves to this
 * one schema; 200 is the status the class is named for.
 */
export function successResponse(
  endpoint: ApiEndpoint,
): { status: number; schema: Record<string, unknown> } | undefined {
  const schemas = endpoint.responseSchemas ?? {};
  const successClass = Object.keys(schemas).find((key) => key.startsWith('2'));
  if (successClass === undefined) return undefined;
  const schema = schemas[successClass];
  if (schema === undefined) return undefined;
  return { status: 200, schema };
}

function effectDiagnostics(
  endpointId: string,
  effect: WorldEffect,
  collections: ReadonlySet<string>,
  collectionSchemas: ReadonlyMap<string, unknown>,
): SimulationDiagnostic[] {
  const out: SimulationDiagnostic[] = [];
  for (const read of effect.reads) {
    if (!collections.has(read.collection)) {
      out.push({
        code: 'effect_collection_unknown',
        endpointId,
        detail: `reads[] names collection "${read.collection}", which is not declared.`,
      });
      continue;
    }
    const compiled = compileSchema(collectionSchemas.get(read.collection));
    if (!compiled.ok) {
      out.push({
        code: 'collection_schema_uncompilable',
        endpointId,
        detail: `Collection "${read.collection}" schema does not compile: ${compiled.detail}`,
      });
    }
  }
  for (const write of effect.writes) {
    if (!collections.has(write.collection)) {
      out.push({
        code: 'effect_collection_unknown',
        endpointId,
        detail: `writes[] names collection "${write.collection}", which is not declared.`,
      });
    }
  }
  const readNames = new Set(effect.reads.map((read) => read.as).filter(Boolean));
  const writeNames = new Set(effect.writes.map((write) => write.as).filter(Boolean));
  for (const projection of effect.project) {
    const source = projection.from;
    const named = 'read' in source ? source.read : source.write;
    const declared = 'read' in source ? readNames.has(named) : writeNames.has(named);
    if (declared) continue;
    out.push({
      code: 'effect_projection_invalid',
      endpointId,
      detail: `project[].from names ${'read' in source ? 'read' : 'write'} "${named}", which this effect does not declare.`,
    });
  }
  return out;
}

/**
 * Readiness for one endpoint. Recomputed at read and never stamped — an
 * endpoint that loses its response schema surfaces on the next read with no
 * stale flag to clean up.
 *
 * Two levels rather than one, because a compiling response schema lets a
 * stateless rule or a contract example answer and says nothing about whether
 * the endpoint can traverse the world. An OpenAPI import supplies schemas and
 * is structurally unable to supply a `WorldEffect`, so collapsing the levels
 * would advertise endpoints that fail on their first stateful call.
 */
export function endpointReadiness(
  endpoint: ApiEndpoint,
  simulation: Simulation,
): SimulationEndpointReport {
  const diagnostics: SimulationDiagnostic[] = [];
  const schemas = endpoint.responseSchemas ?? {};
  const declaredStatusClasses = Object.keys(schemas);

  if (declaredStatusClasses.length === 0) {
    diagnostics.push({
      code: 'response_schema_missing',
      endpointId: endpoint.endpointId,
      detail:
        'No responseSchemas declared. A simulated response is validated against the schema for ' +
        'its own status class, so an endpoint with none has no contract to answer with.',
    });
  }
  for (const [statusClass, schema] of Object.entries(schemas)) {
    const compiled = compileSchema(schema);
    if (!compiled.ok) {
      diagnostics.push({
        code: 'response_schema_uncompilable',
        endpointId: endpoint.endpointId,
        detail: `responseSchemas['${statusClass}'] does not compile: ${compiled.detail}`,
      });
    }
  }

  const contractOk = declaredStatusClasses.length > 0 && diagnostics.length === 0;
  const handler = simulation.handlers[endpoint.endpointId];
  const effect = simulation.effects[endpoint.endpointId];

  // A code handler answers from the world, so the endpoint is world-ready. What
  // cannot be checked statically is the body: an effect's reads and writes are
  // inspectable, a function's are not. The collections it declares are the only
  // thing readiness can know, which is why declaring them is required.
  if (handler) {
    const declared = new Set(simulation.collections.map((c) => c.collection));
    for (const collection of handler.collections) {
      if (declared.has(collection)) continue;
      diagnostics.push({
        code: 'effect_collection_unknown',
        endpointId: endpoint.endpointId,
        collection,
        detail: `The code handler declares collection "${collection}", which the simulation does not, so nothing would be passed to it under that name.`,
      });
    }
    const handlerOk = contractOk && diagnostics.length === 0;
    return {
      endpointId: endpoint.endpointId,
      readiness: handlerOk ? 'world_ready' : contractOk ? 'contract_ready' : 'not_ready',
      declaredStatusClasses,
      hasEffect: true,
      diagnostics,
    };
  }

  if (!effect) {
    return {
      endpointId: endpoint.endpointId,
      readiness: contractOk ? 'contract_ready' : 'not_ready',
      declaredStatusClasses,
      hasEffect: false,
      diagnostics,
    };
  }

  const collections = new Set(simulation.collections.map((c) => c.collection));
  const collectionSchemas = new Map(simulation.collections.map((c) => [c.collection, c.schema]));
  const effectIssues = effectDiagnostics(
    endpoint.endpointId,
    effect,
    collections,
    collectionSchemas,
  );
  diagnostics.push(...effectIssues);

  const readiness: SimulationEndpointReadiness =
    contractOk && effectIssues.length === 0
      ? 'world_ready'
      : contractOk
        ? 'contract_ready'
        : 'not_ready';

  return {
    endpointId: endpoint.endpointId,
    readiness,
    declaredStatusClasses,
    hasEffect: true,
    diagnostics,
  };
}

/** The coverage view an authoring surface reads: what can be exercised, and what holds state. */
export function simulationReadiness(
  definition: Pick<ApiDefinition, 'endpoints'>,
  simulation: Simulation,
): SimulationReadinessReport {
  const endpoints = definition.endpoints.map((e) => endpointReadiness(e, simulation));
  const declaredEndpointIds = new Set(definition.endpoints.map((e) => e.endpointId));

  const diagnostics: SimulationDiagnostic[] = [];
  for (const endpointId of Object.keys(simulation.effects)) {
    if (!declaredEndpointIds.has(endpointId)) {
      diagnostics.push({
        code: 'effect_uncompilable',
        endpointId,
        detail: `An effect is declared for "${endpointId}", which the API definition does not declare.`,
      });
    }
  }

  // A collection nothing reads is a world that costs money to ignore.
  //
  // This is the failure an author reaches by stopping halfway: collections and
  // seed rows are the obvious half of the artifact, effects are the half that
  // makes them reachable. Declare the first without the second and every call
  // is answered by a model that never sees the rows — slower, billed per call,
  // and inventing facts the world already holds. Nothing else reports it,
  // because each endpoint is individually valid; only the whole artifact shows
  // that the data and the wiring disagree.
  const readCollections = new Set<string>();
  for (const effect of Object.values(simulation.effects)) {
    for (const read of effect.reads) readCollections.add(read.collection);
    for (const write of effect.writes) readCollections.add(write.collection);
  }
  // A handler's declared collections count as reached. Its body is opaque, so
  // the declaration is the only claim available — and without it, seeding a
  // collection only a handler uses would report as a world nothing reads.
  for (const handler of Object.values(simulation.handlers)) {
    for (const collection of handler.collections) readCollections.add(collection);
  }
  for (const collection of simulation.collections) {
    if (readCollections.has(collection.collection)) continue;
    diagnostics.push({
      code: 'collection_unread',
      collection: collection.collection,
      detail: `Collection "${collection.collection}" is declared but no world effect reads or writes it, so nothing it holds can reach an answer. Seed data in it is never returned, and every endpoint that should expose it is answered by a model instead. Declare an effect naming this collection, or drop the collection.`,
    });
  }

  // A rule answering a status class the definition never declared cannot be
  // validated, so it would ship a shape the real endpoint could not return.
  {
    for (const rule of simulation.rules) {
      const endpoint = definition.endpoints.find((e) => e.endpointId === rule.when.endpointId);
      if (!endpoint) continue;
      const cls = statusClassOf(rule.respond.status);
      if (endpoint.responseSchemas?.[cls] === undefined) {
        diagnostics.push({
          code: 'rule_status_undeclared',
          endpointId: rule.when.endpointId,
          ruleId: rule.ruleId,
          detail: `Rule responds ${String(rule.respond.status)} but the endpoint declares no responseSchemas['${cls}'].`,
        });
      }
    }
  }

  // A body written by hand is never checked anywhere else until the call that
  // returns it fails validation mid-run. Readiness exists to move that
  // discovery to authoring time, where the author is still looking at it.
  {
    const checkAuthoredBody = (
      endpointId: string,
      ruleId: string | undefined,
      status: number,
      body: unknown,
      what: string,
    ): void => {
      const endpoint = definition.endpoints.find((e) => e.endpointId === endpointId);
      if (!endpoint) return;
      const schema = responseSchemaFor(endpoint, status);
      // An undeclared status class is already `rule_status_undeclared`; saying
      // it twice would make one authoring mistake look like two.
      if (schema === undefined) return;
      const violations = schemaViolations(schema, body);
      if (violations.length === 0) return;
      const detail = `${what} answers ${String(status)} with a body outside responseSchemas['${statusClassOf(status)}']: ${violations.join('; ')}`;
      diagnostics.push({
        code: 'authored_body_off_contract',
        endpointId,
        ...(ruleId !== undefined ? { ruleId } : {}),
        // The diagnostic schema caps detail, and these carry a validator's own
        // wording — long enough, on a deep schema, to fail the report that
        // exists to report it.
        detail:
          detail.length > MAX_DIAGNOSTIC_DETAIL
            ? `${detail.slice(0, MAX_DIAGNOSTIC_DETAIL - 1)}…`
            : detail,
      });
    };

    for (const rule of simulation.rules) {
      if (rule.respond.body === undefined) continue;
      checkAuthoredBody(
        rule.when.endpointId,
        rule.ruleId,
        rule.respond.status,
        rule.respond.body,
        `Rule "${rule.ruleId}"`,
      );
    }

    for (const [endpointId, effect] of Object.entries(simulation.effects)) {
      for (const read of effect.reads) {
        const onMissing = read.onMissing;
        if (typeof onMissing === 'string') continue;
        if (onMissing.body === undefined) continue;
        checkAuthoredBody(
          endpointId,
          undefined,
          onMissing.respond,
          onMissing.body,
          `The onMissing body for read "${read.as ?? read.collection}"`,
        );
      }
    }
  }

  return {
    simulationId: simulation.simulationId,
    revision: simulation.revision,
    endpoints,
    worldReadyCount: endpoints.filter((e) => e.readiness === 'world_ready').length,
    contractReadyCount: endpoints.filter((e) => e.readiness === 'contract_ready').length,
    notReadyCount: endpoints.filter((e) => e.readiness === 'not_ready').length,
    diagnostics,
  };
}
