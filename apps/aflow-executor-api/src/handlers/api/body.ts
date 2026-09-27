/**
 * Request body extraction for API calls.
 */
import type { ApiEndpoint } from '@aflow/schemas';

export function extractBody(endpoint: ApiEndpoint, params: Record<string, unknown>): unknown {
  const declaresBody = endpoint.params.some((param) => param.location === 'body');
  if (!declaresBody) return undefined;

  // Fields passed flat, one per declared parameter — how a caller composing the
  // call itself addresses them: a task input template, a test, a hand-written
  // `api.http.call`.
  const bodyParams: Record<string, unknown> = {};
  let hasBody = false;
  // A null body param means "no body" — nulls INSIDE a provided body object
  // are data and ride through untouched.
  for (const param of endpoint.params) {
    if (param.location === 'body') {
      const value = params[param.name];
      if (value !== undefined && value !== null) {
        bodyParams[param.name] = value;
        hasBody = true;
      }
    }
  }

  // An endpoint that declares a FIELD called `body` alongside others makes the
  // two shapes ambiguous, and preferring the envelope there silently dropped
  // its siblings. So the envelope wins only when nothing else was supplied
  // flat: `{ body, title }` sent flat is two fields, and `{ body: {...} }`
  // alone is one envelope.
  const flatFields = Object.keys(bodyParams).filter((name) => name !== 'body');
  if (flatFields.length > 0) return bodyParams;

  // `params.body` IS the body — one parameter named `body`, or several that are
  // fields of it. Both derive the same tool schema (a single `body` property),
  // so both arrive this way, and reading only the per-name form left a
  // multi-field write with no body at all: the model sent exactly what it was
  // asked for and every field was dropped.
  const envelope = params['body'];
  if (envelope !== undefined && envelope !== null) return envelope;

  return hasBody ? bodyParams : undefined;
}
