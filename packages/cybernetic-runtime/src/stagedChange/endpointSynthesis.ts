import type { ApiDefinitionDraft, ApiEndpoint, BodyEncoding, EndpointParam } from '@aflow/schemas';

/**
 * The success schema as stored. A draft states its prose separately from the
 * schema; JSON Schema has a `description` of its own, so the two are merged
 * rather than one being dropped — an author's sentence about what a call
 * returns is exactly what a generating simulation should read.
 */
function successSchema(response: {
  description?: string | undefined;
  schema: Record<string, unknown>;
}): Record<string, unknown> {
  if (response.description === undefined || 'description' in response.schema) {
    return response.schema;
  }
  return { ...response.schema, description: response.description };
}

/** Map a draft body `contentType` to the canonical `bodyEncoding`; default JSON. */
function bodyEncodingForContentType(contentType: string | undefined): BodyEncoding {
  if (contentType === 'application/x-www-form-urlencoded') return 'form-urlencoded';
  if (contentType === 'multipart/form-data') return 'form-data';
  return 'json';
}

export function synthesizeEndpointId(method: string, path: string): string {
  const slug = path
    .toLowerCase()
    .replace(/\{([^}]+)\}/g, '$1') // {fileName} -> fileName
    .replace(/[^a-z0-9]+/g, '_') // squash separators
    .replace(/^_+|_+$/g, ''); // trim
  const id = `${method.toLowerCase()}_${slug}`;
  return id.length > 128 ? id.slice(0, 128) : id;
}

function extractPathParams(path: string): EndpointParam[] {
  const re = /\{([^}]+)\}/g;
  const out: EndpointParam[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(path)) !== null) {
    out.push({
      name: match[1]!,
      location: 'path',
      required: true,
    });
  }
  return out;
}

function extractQueryParams(
  draftQueryParams: NonNullable<ApiDefinitionDraft['endpoints'][number]['queryParams']>,
): EndpointParam[] {
  return draftQueryParams.map((qp) => ({
    name: qp.name,
    location: 'query' as const,
    required: qp.required ?? false,
    ...(qp.description ? { description: qp.description } : {}),
  }));
}

function extractBodyParams(
  draftBody: NonNullable<ApiDefinitionDraft['endpoints'][number]['body']>,
): EndpointParam[] {
  return [
    {
      name: 'body',
      location: 'body' as const,
      required: true,
      schema: draftBody.schema,
      ...(draftBody.description ? { description: draftBody.description } : {}),
    },
  ];
}

export function synthesizeEndpoints(
  draftEndpoints: ApiDefinitionDraft['endpoints'],
): ApiEndpoint[] {
  const seenIds = new Set<string>();
  const out: ApiEndpoint[] = [];
  for (const ep of draftEndpoints) {
    let endpointId = ep.endpointId ?? synthesizeEndpointId(ep.method, ep.path);
    // Defensive uniqueness — should be rare given path+method combinations,
    // but a draft with two identical entries (or operator-provided IDs that
    // collide) would otherwise produce duplicate IDs and api.http.call
    // resolution would be ambiguous.
    if (seenIds.has(endpointId)) {
      let suffix = 2;
      while (seenIds.has(`${endpointId}_${suffix}`)) suffix++;
      endpointId = `${endpointId}_${suffix}`;
    }
    seenIds.add(endpointId);

    const pathParams = extractPathParams(ep.path);
    const queryParams = ep.queryParams ? extractQueryParams(ep.queryParams) : [];
    const bodyParams = ep.body ? extractBodyParams(ep.body) : [];

    out.push({
      endpointId,
      // `name` is a short display label (≤256) and `description` is the longer
      // prose (≤2000). The draft splits these as `name` (≤256) and `summary`
      // (≤500); when no `name` is given, fall back to a clamped `summary` so a
      // 257–500 char summary can't overflow the model `name` cap and produce a
      // stored definition the executor's safeParse rejects → silent skip →
      // "API definition not found in space".
      name: (ep.name ?? ep.summary ?? endpointId).slice(0, 256),
      ...(ep.summary ? { description: ep.summary } : {}),
      method: ep.method,
      pathTemplate: ep.path,
      params: [...pathParams, ...queryParams, ...bodyParams],
      bodyEncoding: bodyEncodingForContentType(ep.body?.contentType),
      // Keyed by status class, and a draft states only the success shape. This
      // is what makes a definition authored from a brief simulatable: with no
      // response schema every endpoint reads `contract_missing` and generation
      // has nothing to answer against (Plan 293 §5.10).
      ...(ep.response ? { responseSchemas: { '2xx': successSchema(ep.response) } } : {}),
      ...(ep.responseTransformPresetId !== undefined
        ? { responseTransformPresetId: ep.responseTransformPresetId }
        : {}),
      tags: [],
    });
  }
  return out;
}
