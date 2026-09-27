import { compileSchema } from '@aflow/integration-simulator';
import { deriveEndpointBodySchema } from '@aflow/schemas';
import type { ApiEndpoint, AflowError } from '@aflow/schemas';
import { validationError } from '@aflow/executor-runtime';
import { apiError } from '../../lib/api-errors.js';

/**
 * A schema that will not compile is a defect in the DEFINITION — most often an
 * OpenAPI `$ref` stored without being inlined, which Ajv refuses to resolve.
 * It is reported separately from value issues because the two are different
 * failures with different owners: nobody's request was wrong, and the caller
 * cannot fix it by sending different bytes.
 */
export type SchemaCheck =
  { kind: 'ok' } | { kind: 'issues'; issues: string[] } | { kind: 'uncompilable'; reason: string };

/**
 * Compilation goes through the simulator's `compileSchema`, which gives every
 * schema its OWN Ajv, cached by content.
 *
 * A shared instance registers schemas by `$id`, and importers stamp one per
 * component name — so two spaces importing an API that both call a schema
 * `Customer` collide, and Ajv refuses the second for the life of the process.
 * That fails in the silent direction: a legitimate body rejected because of a
 * definition imported into a space this one cannot see.
 */
export function checkAgainstSchema(schema: Record<string, unknown>, value: unknown): SchemaCheck {
  const compilation = compileSchema(schema);
  if (!compilation.ok) return { kind: 'uncompilable', reason: compilation.detail };
  if (compilation.validate(value)) return { kind: 'ok' };
  return {
    kind: 'issues',
    issues: (compilation.validate.errors ?? []).map(
      (e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`,
    ),
  };
}

/**
 * Value issues only — an uncompilable schema surfaces as an empty result here,
 * so reach for `checkAgainstSchema` where the distinction matters.
 */
export function schemaIssues(schema: Record<string, unknown>, value: unknown): string[] {
  const result = checkAgainstSchema(schema, value);
  return result.kind === 'issues' ? result.issues : [];
}

/**
 * Plan 253 §P0 backstop — validate a resolved request body against the
 * endpoint's declared body JSON Schema at call time. Plan 210 validates
 * promoted agent-tool args in-session, but a raw `api.http.call` or an
 * operation-task call reaches the executor unvalidated; this closes that gap so
 * a schema-invalid write never leaves the box (and never pauses for approval).
 *
 * The schema comes from `deriveEndpointBodySchema`, the same derivation the
 * agent's tool schema is built from — so a body the model would have been
 * refused for cannot be waved through by a raw caller. Validating fewer shapes
 * than the tool advertises is the gap that opens: a multi-field body was
 * marked required for the model and unchecked for everyone else.
 *
 * Opaque string/binary bodies (bodySource file uploads) stay unvalidated.
 */
export function validateEndpointBody(endpoint: ApiEndpoint, body: unknown): AflowError | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string' || body instanceof Uint8Array) return null;

  const schema = deriveEndpointBodySchema(endpoint);
  if (!schema || Object.keys(schema).length === 0) return null;

  const result = checkAgainstSchema(schema, body);
  if (result.kind === 'ok') return null;

  // A schema that will not compile is the endpoint's problem, not the caller's.
  // Reporting it as VALIDATION_ERROR would tell an operator their request body
  // was invalid when it was never looked at, and point them at bytes they
  // cannot change to fix it.
  if (result.kind === 'uncompilable') {
    return apiError(
      'API_ENDPOINT_SCHEMA_INVALID',
      `Endpoint "${endpoint.endpointId}" declares a request-body schema that is not valid JSON Schema: ${result.reason}. Fix the API definition — a $ref stored without being inlined is the usual cause.`,
      { details: { endpointId: endpoint.endpointId } },
    );
  }

  const summary = result.issues.join('; ');
  return validationError(`Request body invalid for endpoint "${endpoint.endpointId}": ${summary}`, {
    endpointId: endpoint.endpointId,
  });
}
