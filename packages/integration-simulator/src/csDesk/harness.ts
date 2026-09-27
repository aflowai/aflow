import type { ApiEndpoint } from '@aflow/schemas';
import { runCodeHandler } from '../codeRung.js';
import { responseSchemaFor } from '../readiness.js';
import { compileSchema } from '../schemaCheck.js';
import { CS_DESK_BASELINE } from './baseline.js';
import { CS_DESK_COLLECTIONS } from './collections.js';
import { CS_DESK_HANDLERS } from './handlers/index.js';

/**
 * Calls a handler the way the engine does, minus the engine.
 *
 * Persona narrowing happens in the world store BEFORE a handler runs, so what
 * is reproduced here is the narrowing's RESULT — the handler is handed rows
 * that are already the caller's. That keeps the scoping guarantee where it is
 * tested (the store) instead of re-implementing it beside the thing it guards.
 */

const personaFields = new Map<string, string>(
  CS_DESK_COLLECTIONS.flatMap((c) =>
    c.ownership === 'persona_scoped' && 'personaField' in c
      ? [[c.collection, c.personaField as string] as const]
      : [],
  ),
);

export function worldFor(
  personaId: string | null,
  overrides: Record<string, Array<Record<string, unknown>>> = {},
): Record<string, Array<Record<string, unknown>>> {
  const world: Record<string, Array<Record<string, unknown>>> = {};
  for (const [collection, allRows] of Object.entries({ ...CS_DESK_BASELINE, ...overrides })) {
    const field = personaFields.get(collection);
    if (field === undefined) {
      world[collection] = allRows;
      continue;
    }
    // An identity of nobody reads every owned collection empty, which is the
    // unauthenticated caller rather than a caller who happens to own nothing.
    world[collection] = personaId === null ? [] : allRows.filter((r) => r[field] === personaId);
  }
  return world;
}

export interface DeskCall {
  endpointId: string;
  body: unknown;
  personaId?: string | null;
  nowMs: number;
  world?: Record<string, Array<Record<string, unknown>>>;
  overrides?: Record<string, Array<Record<string, unknown>>>;
}

export interface DeskAnswer {
  status: string;
  result: Record<string, unknown>;
  escalations: Array<{ reason: string; scope: string; detail: string }>;
  errorRecovery: { code: string; message: string; retryable: boolean } | undefined;
  raw: Record<string, unknown>;
  mutations: ReadonlyArray<{ collection: string; op: string; entityId: string }>;
}

export async function callDesk(
  endpoints: readonly ApiEndpoint[],
  call: DeskCall,
): Promise<DeskAnswer> {
  const endpoint = endpoints.find((e) => e.endpointId === call.endpointId);
  if (!endpoint) throw new Error(`no endpoint "${call.endpointId}"`);
  const handler = CS_DESK_HANDLERS[call.endpointId];
  if (!handler) throw new Error(`no handler for "${call.endpointId}"`);

  const personaId = call.personaId === undefined ? null : call.personaId;
  const world = call.world ?? worldFor(personaId, call.overrides ?? {});

  let minted = 0;
  const response = await runCodeHandler({
    endpointId: call.endpointId,
    code: handler.code,
    timeoutMs: handler.timeoutMs,
    request: {
      method: endpoint.method,
      url: `https://simulated.invalid/cs-desk${endpoint.pathTemplate}`,
      params: {},
      body: call.body,
    },
    caller: personaId === null ? null : { personaId },
    now: call.nowMs,
    mintId: (collection: string) => `${collection.toUpperCase()}-MINT-${++minted}`,
    world,
  });

  // Mandatory and fail-loud, against the schema for the response's OWN status
  // class — the same check the engine applies before anything is returned.
  const schema = responseSchemaFor(endpoint, response.status);
  if (schema === undefined) {
    throw new Error(`${call.endpointId} answered ${response.status} with no declared schema`);
  }
  const compiled = compileSchema(schema);
  if (!compiled.ok)
    throw new Error(`${call.endpointId} schema does not compile: ${compiled.detail}`);
  if (!compiled.validate(response.body)) {
    throw new Error(
      `${call.endpointId} answered outside its contract: ${JSON.stringify(compiled.validate.errors)} — body ${JSON.stringify(response.body)}`,
    );
  }

  // Mutations are held to the collection's own schema, the way the commit
  // boundary holds them. A handler that writes a row the world would reject is
  // a failure the engine raises at run time and this raises at test time.
  for (const mutation of response.mutations) {
    const declared = CS_DESK_COLLECTIONS.find((c) => c.collection === mutation.collection);
    if (!declared)
      throw new Error(`${call.endpointId} wrote to undeclared "${mutation.collection}"`);
    if (mutation.op === 'delete') continue;
    const compiledRow = compileSchema(declared.schema as Record<string, unknown>);
    if (!compiledRow.ok) throw new Error(compiledRow.detail);
    if (!compiledRow.validate(mutation.body)) {
      throw new Error(
        `${call.endpointId} wrote a ${mutation.collection} row the collection rejects: ${JSON.stringify(compiledRow.validate.errors)}`,
      );
    }
  }

  const body = response.body as Record<string, unknown>;
  return {
    status: body['status'] as string,
    result: (body['result'] ?? {}) as Record<string, unknown>,
    escalations: (body['escalations'] ?? []) as DeskAnswer['escalations'],
    errorRecovery: body['error_recovery'] as DeskAnswer['errorRecovery'],
    raw: body,
    mutations: response.mutations,
  };
}

/** The reasons a call escalated, which is what replaces a suggested handover. */
export function reasons(answer: DeskAnswer): string[] {
  return answer.escalations.map((e) => e.reason);
}
