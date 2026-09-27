/**
 * GitHub REST API definition shipped by the `coding-pr-loop` bundle.
 *
 * Derived from the GitHub connector (`connectorCatalog/github.ts`) — the single
 * source of truth for the endpoint set — and lowered to the bundle's
 * `ApiDefinitionDraft` shape (`pathTemplate → path`, `description → summary`,
 * params split into `queryParams` / `body`). Keeping it derived means the bundle
 * and the connector store never drift.
 *
 * @packageDocumentation
 */
import type { BundledApiDefinition } from '@aflow/schemas';
import { GITHUB_CONNECTOR } from '../connectorCatalog/github.js';

const def = GITHUB_CONNECTOR.definition;

export const GITHUB_API_DEFINITION: BundledApiDefinition = {
  apiId: def.apiId,
  definition: {
    name: def.name,
    baseUrl: def.baseUrl,
    authKind: 'bearer' as const,
    callMode: 'endpoint' as const,
    // The connector's egress hints must ride along — they include PUT/PATCH, which
    // `mergePullRequest` (PUT) and `updatePullRequest` (PATCH) need. Dropping them
    // left a bundle-installed binding at the GET/POST default, so merge was blocked.
    ...(def.suggestedEgressPolicy ? { suggestedEgressPolicy: def.suggestedEgressPolicy } : {}),
    endpoints: def.endpoints.map((ep) => {
      const params = ep.params;
      const queryParams = params
        .filter((p) => p.location === 'query')
        .map((p) => ({ name: p.name, required: p.required, description: p.description }));
      const bodyParam = params.find((p) => p.location === 'body');
      return {
        endpointId: ep.endpointId,
        name: ep.name,
        // Connector path templates already carry their {path} params inline.
        path: ep.pathTemplate,
        // The connector method enum is wider (HEAD/OPTIONS); the draft enum is the
        // narrower REST set. Every github endpoint is in the draft set, and the
        // bundle schema re-validates at catalog load, so the narrowing is safe.
        method: ep.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        ...(ep.description !== undefined ? { summary: ep.description } : {}),
        ...(queryParams.length > 0 ? { queryParams } : {}),
        ...(bodyParam?.schema
          ? { body: { contentType: 'application/json' as const, schema: bodyParam.schema } }
          : {}),
      };
    }),
  },
  conflictPolicy: 'skip' as const,
};
