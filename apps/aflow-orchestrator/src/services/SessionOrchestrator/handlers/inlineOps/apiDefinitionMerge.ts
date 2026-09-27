import {
  PLANE_ONLY_ENDPOINT_FIELDS,
  overlayPlaneOnlyEndpointFields,
} from '@aflow/cybernetic-runtime';

export { PLANE_ONLY_ENDPOINT_FIELDS };

/**
 * Build the merged definition JSON for `api.definition.upsert` against the
 * stored definition. Pure — the handler reads the prior row, calls this, then
 * validates and persists the result.
 *
 * - Endpoints merge by endpointId: named endpoints are added/replaced, stored
 *   endpoints not named are kept; removal only via explicit `removeEndpointIds`
 *   (unknown ids and provide+remove conflicts throw).
 * - Every other field is preserve-on-omit: input wins when present, otherwise
 *   the stored value is kept. baseUrl/baseUrlTemplate/variables travel as one
 *   group — providing either base form takes the input's group exclusively.
 */
export function buildMergedDefinitionJson(
  apiId: string,
  input: Record<string, unknown>,
  priorJson: Record<string, unknown> | undefined,
): Record<string, unknown> {
  // Normalize :param → {param} in path templates (agents often use Express-style)
  // and strip plane-only fields — this op is the agent surface, and the plane
  // fields must not be settable through it regardless of upstream validation.
  const rawEndpoints = input['endpoints'] as Array<Record<string, unknown>> | undefined;
  const inputEndpoints = (rawEndpoints ?? []).map((ep) => {
    const sanitized = { ...ep };
    for (const field of PLANE_ONLY_ENDPOINT_FIELDS) delete sanitized[field];
    const pt = sanitized['pathTemplate'];
    if (typeof pt === 'string' && pt.includes(':')) {
      const params = (sanitized['params'] ?? []) as Array<{ name: string }>;
      let normalized = pt;
      for (const p of params) {
        normalized = normalized.replace(`:${p.name}`, `{${p.name}}`);
      }
      sanitized['pathTemplate'] = normalized;
    }
    return sanitized;
  });

  const priorEndpoints =
    (priorJson?.['endpoints'] as Array<Record<string, unknown>> | undefined) ?? [];
  const priorIds = new Set(priorEndpoints.map((ep) => ep['endpointId'] as string));
  // A duplicated input id would silently collapse via the by-id map (last wins)
  // whenever the id already exists — reject before the map is built so the
  // schema-level duplicate check cannot be bypassed.
  const seenInputIds = new Set<string>();
  for (const ep of inputEndpoints) {
    const id = ep['endpointId'] as string;
    if (seenInputIds.has(id)) {
      throw new Error(
        `Duplicate endpointId "${id}" in endpoints[] — endpoints merge by endpointId; send one entry per endpoint.`,
      );
    }
    seenInputIds.add(id);
  }
  const inputById = new Map(inputEndpoints.map((ep) => [ep['endpointId'] as string, ep]));
  const removeIds = new Set((input['removeEndpointIds'] as string[] | undefined) ?? []);
  const unknownRemovals = [...removeIds].filter((id) => !priorIds.has(id));
  if (unknownRemovals.length > 0) {
    throw new Error(
      `removeEndpointIds names endpoint(s) not stored on "${apiId}": ` +
        `${unknownRemovals.join(', ')}. Stored: ${[...priorIds].join(', ') || '(none)'}`,
    );
  }
  const removedAndProvided = [...removeIds].filter((id) => inputById.has(id));
  if (removedAndProvided.length > 0) {
    throw new Error(
      `Endpoint(s) both provided in endpoints and listed in removeEndpointIds: ` +
        `${removedAndProvided.join(', ')}. Provide one intent per endpoint.`,
    );
  }

  const mergedEndpoints = [
    ...priorEndpoints
      .filter((ep) => !removeIds.has(ep['endpointId'] as string))
      .map((ep) => {
        const provided = inputById.get(ep['endpointId'] as string);
        return provided ? overlayPlaneOnlyEndpointFields([ep], [provided])[0]! : ep;
      }),
    ...inputEndpoints.filter((ep) => !priorIds.has(ep['endpointId'] as string)),
  ];

  const inherit = (key: string): Record<string, unknown> => {
    const value = input[key] !== undefined ? input[key] : priorJson?.[key];
    return value !== undefined ? { [key]: value } : {};
  };
  const baseProvided = input['baseUrl'] !== undefined || input['baseUrlTemplate'] !== undefined;
  const baseFields = baseProvided
    ? {
        ...(input['baseUrl'] ? { baseUrl: input['baseUrl'] } : {}),
        ...(input['baseUrlTemplate'] ? { baseUrlTemplate: input['baseUrlTemplate'] } : {}),
        ...(input['variables'] ? { variables: input['variables'] } : {}),
      }
    : {
        ...(priorJson?.['baseUrl'] ? { baseUrl: priorJson['baseUrl'] } : {}),
        ...(priorJson?.['baseUrlTemplate']
          ? { baseUrlTemplate: priorJson['baseUrlTemplate'] }
          : {}),
        ...((input['variables'] ?? priorJson?.['variables']) !== undefined
          ? { variables: input['variables'] ?? priorJson?.['variables'] }
          : {}),
      };
  const callMode = input['callMode'] ?? priorJson?.['callMode'];

  return {
    apiId,
    name: input['name'],
    ...inherit('description'),
    ...baseFields,
    version: input['version'] ?? priorJson?.['version'] ?? '1',
    ...(callMode === 'direct_url' ? { callMode: 'direct_url' } : {}),
    endpoints: mergedEndpoints,
    ...inherit('defaultHeaders'),
    ...inherit('suggestedEgressPolicy'),
    tags: input['tags'] ?? priorJson?.['tags'] ?? [],
  };
}
