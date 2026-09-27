import { ApiEndpointSchema, stableHash } from '@aflow/schemas';
import type { ApiEndpoint } from '@aflow/schemas';

/**
 * The endpoint set a simulated call is answered against, and its identity.
 *
 * A run pins the set rather than the whole `ApiDefinition`: a simulated call
 * reads no base URL, no auth profile and no egress policy, so hashing them
 * would refuse a run over an edit that cannot reach it. What it does read is
 * the endpoint's response schemas, which decide whether an answer is a
 * contract violation — so those are exactly what must not move mid-run.
 */

const setHashes = new WeakMap<readonly ApiEndpoint[], string>();

/**
 * Canonical form: schema defaults applied, ordered by id.
 *
 * Both, because the same set reaches here from a definition row, from a stored
 * snapshot and from a draft, and only a form that survives a round trip through
 * the schema can be compared across them.
 */
export function canonicalEndpoints(endpoints: readonly ApiEndpoint[]): ApiEndpoint[] {
  return endpoints
    .map((endpoint) => ApiEndpointSchema.parse(endpoint))
    .sort((left, right) => left.endpointId.localeCompare(right.endpointId));
}

/**
 * Memoized on the array's identity: the definition cache replaces the object
 * when it reloads, so the memo expires exactly when the definition does and a
 * per-call re-canonicalization of a large endpoint set never happens.
 */
export function endpointSetHash(endpoints: readonly ApiEndpoint[]): string {
  const memo = setHashes.get(endpoints);
  if (memo !== undefined) return memo;
  const hash = stableHash(canonicalEndpoints(endpoints));
  setHashes.set(endpoints, hash);
  return hash;
}
